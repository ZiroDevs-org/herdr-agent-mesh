import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { Readable } from "node:stream"
import {
  AGENT_AVAILABILITY,
  DELIVERY_STATE,
  HerdrRejectionError,
  REJECTION_CODE,
  type AgentDescriptor,
  type AgentIdentity,
  type ConsentReceipt,
  type DeliveryReceipt,
  type ExplicitScope,
  type HerdrLocation,
  type MessageEnvelope,
  PROTOCOL,
  SCOPE_KIND,
  validateAgentIdentity,
  validateConsentReceipt,
  validateExplicitScope,
  validateHerdrLocation,
  validateMessageEnvelope,
} from "./protocol"

export const HERDR_ENV = "HERDR_ENV"
export const HERDR_ENV_VALUE = "1"
export const DEFAULT_HERDR_COMMAND = "herdr"

export interface HerdrCommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
}

export interface SpawnedHerdrProcess {
  stdout: Readable
  stderr: Readable
  on(event: "error", listener: (error: Error) => void): this
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface HerdrSpawnOptions {
  env?: NodeJS.ProcessEnv
  shell?: boolean
}

export type SpawnHerdrProcess = (
  command: string,
  args: string[],
  options: HerdrSpawnOptions,
) => SpawnedHerdrProcess

export interface HerdrTransport {
  snapshot(): Promise<unknown>
  prompt(targetPaneId: string, text: string): Promise<HerdrCommandResult>
}

export interface HerdrSnapshot {
  protocol: number | undefined
  version: string | undefined
  agents: AgentDescriptor[]
}

export interface HerdrCallerContext {
  location: HerdrLocation
  session_id?: string
}

export interface HerdrTeamClientOptions {
  transport: HerdrTransport
  caller?: HerdrCallerContext
  deduplicationStore?: DeduplicationStore
  now?: () => Date
  makeId?: () => string
}

export interface IdempotencyClaim {
  acquired: boolean
  receipt?: HerdrDeliveryReceipt
}

export interface DeduplicationStore {
  claim(idempotencyKey: string): Promise<IdempotencyClaim>
  complete(idempotencyKey: string, receipt: HerdrDeliveryReceipt): Promise<void>
}

export class MemoryDeduplicationStore implements DeduplicationStore {
  private readonly records = new Map<string, HerdrDeliveryReceipt | undefined>()

  async claim(idempotencyKey: string): Promise<IdempotencyClaim> {
    if (!this.records.has(idempotencyKey)) {
      this.records.set(idempotencyKey, undefined)
      return { acquired: true }
    }
    return { acquired: false, receipt: this.records.get(idempotencyKey) }
  }

  async complete(idempotencyKey: string, receipt: HerdrDeliveryReceipt): Promise<void> {
    this.records.set(idempotencyKey, receipt)
  }
}

export interface DiscoveryResult {
  schema: typeof PROTOCOL.TOPOLOGY_SCHEMA
  scope: ExplicitScope
  agents: AgentDescriptor[]
}

export interface CreateEnvelopeRequest {
  target_pane_id: string
  text: string
  scope?: ExplicitScope
  message_id?: string
  correlation_id?: string
  idempotency_key?: string
}

export interface HerdrDeliveryReceipt extends DeliveryReceipt {
  target: AgentDescriptor
  command: HerdrCommandResult
}

export class HerdrCliTransport implements HerdrTransport {
  private readonly command: string
  private readonly spawnProcess: SpawnHerdrProcess

  constructor(options: { command?: string; spawnProcess?: SpawnHerdrProcess } = {}) {
    this.command = options.command ?? process.env.HERDR_TEAM_HERDR_BIN ?? DEFAULT_HERDR_COMMAND
    this.spawnProcess = options.spawnProcess ?? defaultSpawn
  }

  async snapshot(): Promise<unknown> {
    const result = await this.run(["api", "snapshot"])
    return parseHerdrJson(result, "Herdr snapshot")
  }

  async prompt(targetPaneId: string, text: string): Promise<HerdrCommandResult> {
    return this.run(["agent", "prompt", targetPaneId, text])
  }

  private async run(args: string[]): Promise<HerdrCommandResult> {
    const options: HerdrSpawnOptions = {
      env: { ...process.env, [HERDR_ENV]: HERDR_ENV_VALUE },
      shell: false,
    }
    const child = this.spawnProcess(this.command, [...args], options)

    return new Promise<HerdrCommandResult>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let settled = false

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      })
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      })
      child.on("error", (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.on("close", (code) => {
        if (settled) return
        settled = true
        resolve({ stdout, stderr, exit_code: code })
      })
    })
  }
}

export class HerdrTeamClient {
  private readonly transport: HerdrTransport
  private readonly caller: HerdrCallerContext | undefined
  private readonly deduplicationStore: DeduplicationStore
  private readonly now: () => Date
  private readonly makeId: () => string

  constructor(options: HerdrTeamClientOptions) {
    this.transport = options.transport
    this.caller = options.caller
    this.deduplicationStore = options.deduplicationStore ?? new MemoryDeduplicationStore()
    this.now = options.now ?? (() => new Date())
    this.makeId = options.makeId ?? randomUUID
    if (this.caller !== undefined) validateHerdrLocation(this.caller.location)
  }

  async discover(scope?: ExplicitScope): Promise<DiscoveryResult> {
    const snapshot = await this.readSnapshot()
    const resolvedScope = this.resolveScope(scope, snapshot)
    return {
      schema: PROTOCOL.TOPOLOGY_SCHEMA,
      scope: resolvedScope,
      agents: snapshot.agents.filter((agent) => isInScope(agent, resolvedScope)),
    }
  }

  async createEnvelope(request: CreateEnvelopeRequest): Promise<MessageEnvelope> {
    const snapshot = await this.readSnapshot()
    const scope = this.resolveScope(request.scope, snapshot)
    const sender = this.findCaller(snapshot).identity
    const target = findSendableTarget(snapshot.agents, request.target_pane_id, scope)
    const createdAt = this.now().toISOString()
    const messageId = request.message_id ?? this.makeId()

    return {
      schema: PROTOCOL.MESSAGE_SCHEMA,
      message_id: messageId,
      correlation_id: request.correlation_id ?? messageId,
      idempotency_key: request.idempotency_key ?? messageId,
      sender,
      recipient: target.identity,
      scope,
      body: { text: requireText(request.text) },
      created_at: createdAt,
    }
  }

  async sendAuthorized(envelope: MessageEnvelope, consent: ConsentReceipt): Promise<HerdrDeliveryReceipt> {
    validateMessageEnvelope(envelope)
    validateConsentReceipt(envelope, consent)

    const validationSnapshot = await this.readSnapshot()
    findExactSender(validationSnapshot.agents, envelope.sender)
    findExactTarget(validationSnapshot.agents, envelope, envelope.scope)

    const freshSnapshot = await this.readSnapshot()
    findExactSender(freshSnapshot.agents, envelope.sender)
    const target = findExactTarget(freshSnapshot.agents, envelope, envelope.scope)

    const claim = await this.deduplicationStore.claim(envelope.idempotency_key)
    if (!claim.acquired) {
      if (claim.receipt !== undefined) {
        return {
          ...claim.receipt,
          detail: "duplicate idempotency key; returned the existing Herdr submission receipt",
        }
      }
      return {
        message_id: envelope.message_id,
        state: DELIVERY_STATE.UNKNOWN,
        recorded_at: this.now().toISOString(),
        detail: "duplicate idempotency key is already in flight; no second prompt was submitted",
        target,
        command: { stdout: "", stderr: "", exit_code: null },
      }
    }

    let command: HerdrCommandResult
    let receipt: HerdrDeliveryReceipt
    try {
      command = await this.transport.prompt(target.identity.location.pane_id, envelope.body.text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Herdr prompt outcome is unknown"
      receipt = {
        message_id: envelope.message_id,
        state: DELIVERY_STATE.UNKNOWN,
        recorded_at: this.now().toISOString(),
        detail,
        target,
        command: { stdout: "", stderr: detail, exit_code: null },
      }
      await this.deduplicationStore.complete(envelope.idempotency_key, receipt)
      return receipt
    }

    receipt = {
      message_id: envelope.message_id,
      state: command.exit_code === 0 ? DELIVERY_STATE.SUBMITTED_TO_HERDR : DELIVERY_STATE.FAILED,
      recorded_at: this.now().toISOString(),
      detail: command.exit_code === 0
        ? "Herdr accepted the directed prompt; recipient observation and processing are not confirmed."
        : summarizeCommandFailure(command),
      target,
      command,
    }
    await this.deduplicationStore.complete(envelope.idempotency_key, receipt)
    return receipt
  }

  private async readSnapshot(): Promise<HerdrSnapshot> {
    return normalizeHerdrSnapshot(await this.transport.snapshot())
  }

  private resolveScope(scope: ExplicitScope | undefined, snapshot: HerdrSnapshot): ExplicitScope {
    if (scope !== undefined) {
      validateExplicitScope(scope)
      return scope
    }

    if (this.caller === undefined) {
      throw new HerdrRejectionError(REJECTION_CODE.INVALID_SCOPE, "explicit scope is required when the verified current tab is unavailable")
    }

    const caller = this.findCaller(snapshot)
    return { kind: SCOPE_KIND.TAB, tab_id: caller.identity.location.tab_id }
  }

  private findCaller(snapshot: HerdrSnapshot): AgentDescriptor {
    if (this.caller === undefined) {
      throw new HerdrRejectionError(REJECTION_CODE.INVALID_IDENTITY, "caller context is unavailable")
    }
    const caller = snapshot.agents.find((agent) => agent.identity.location.pane_id === this.caller?.location.pane_id)
    if (caller === undefined) {
      throw new HerdrRejectionError(REJECTION_CODE.SENDER_STALE, "verified current pane was not found in the Herdr snapshot")
    }
    if (!sameLocation(caller.identity.location, this.caller.location)) {
      throw new HerdrRejectionError(REJECTION_CODE.SENDER_STALE, "verified current pane location changed; rediscover before continuing")
    }
    if (this.caller.session_id !== undefined && caller.identity.session_id !== this.caller.session_id) {
      throw new HerdrRejectionError(REJECTION_CODE.SENDER_STALE, "verified current session changed; rediscover before continuing")
    }
    return caller
  }
}

export function normalizeHerdrSnapshot(input: unknown): HerdrSnapshot {
  if (isNormalizedSnapshot(input)) return input
  const root = snapshotRecord(input)
  const rawAgents = recordValue(root, "agents")
  if (!Array.isArray(rawAgents)) return { protocol: undefined, version: undefined, agents: [] }

  const agents: AgentDescriptor[] = []
  const seenPanes = new Set<string>()
  for (const raw of rawAgents) {
    if (!isRecord(raw)) continue
    const location = readLocation(raw)
    const sessionId = readSessionId(raw)
    if (location === undefined || sessionId === undefined || seenPanes.has(location.pane_id)) continue
    seenPanes.add(location.pane_id)
    agents.push({
      identity: {
        provider: readProvider(raw),
        session_id: sessionId,
        location,
      },
      availability: readString(raw, ["agent_status", "status"]) ?? AGENT_AVAILABILITY.UNKNOWN,
      capabilities: {
        can_discover: true,
        can_submit_to_herdr: true,
        can_receive: false,
        can_reply: false,
      },
      metadata: {
        label: readString(raw, ["tab_label", "label"]) ?? "",
        title: readString(raw, ["terminal_title_stripped", "terminal_title", "title"]) ?? "",
        cwd: readString(raw, ["cwd", "foreground_cwd"]) ?? "",
        focused: raw.focused === true,
      },
    })
  }

  return {
    protocol: readNumber(root, "protocol"),
    version: readString(root, ["version"]),
    agents,
  }
}

function defaultSpawn(command: string, args: string[], options: HerdrSpawnOptions): SpawnedHerdrProcess {
  return spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams
}

function parseHerdrJson(result: HerdrCommandResult, label: string): unknown {
  if (result.exit_code !== 0) {
    const detail = summarizeCommandFailure(result)
    throw new Error(`${label} failed${detail === "" ? "" : `: ${detail}`}`)
  }
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function findSendableTarget(agents: AgentDescriptor[], paneId: string, scope: ExplicitScope): AgentDescriptor {
  const target = agents.find((agent) => agent.identity.location.pane_id === paneId)
  if (target === undefined) {
    throw new HerdrRejectionError(REJECTION_CODE.TARGET_NOT_ELIGIBLE, `target pane '${paneId}' is not an eligible target`)
  }
  if (!isInScope(target, scope)) {
    throw new HerdrRejectionError(REJECTION_CODE.OUT_OF_SCOPE, `target pane '${paneId}' is outside the requested scope`)
  }
  if (!target.capabilities.can_submit_to_herdr) {
    throw new HerdrRejectionError(REJECTION_CODE.TARGET_NOT_ELIGIBLE, `target pane '${paneId}' cannot accept Herdr prompts`)
  }
  if (isBlockedOrUnknown(target.availability)) {
    throw new HerdrRejectionError(REJECTION_CODE.TARGET_NOT_ELIGIBLE, `target pane '${paneId}' has blocked/unknown status '${target.availability}'`)
  }
  return target
}

function findExactSender(agents: AgentDescriptor[], sender: AgentIdentity): AgentDescriptor {
  const current = agents.find((agent) => agent.identity.location.pane_id === sender.location.pane_id)
  if (current === undefined || !sameIdentity(current.identity, sender)) {
    throw new HerdrRejectionError(REJECTION_CODE.SENDER_STALE, "sender identity changed; rediscover and authorize the current sender again")
  }
  return current
}

function findExactTarget(agents: AgentDescriptor[], envelope: MessageEnvelope, scope: ExplicitScope): AgentDescriptor {
  const target = findSendableTarget(agents, envelope.recipient.location.pane_id, scope)
  if (!sameIdentity(target.identity, envelope.recipient)) {
    throw new HerdrRejectionError(REJECTION_CODE.TARGET_STALE, "target identity changed; rediscover and authorize the exact pane again")
  }
  return target
}

function isInScope(agent: AgentDescriptor, scope: ExplicitScope): boolean {
  if (scope.kind === SCOPE_KIND.TAB) return agent.identity.location.tab_id === scope.tab_id
  return scope.workspace_ids.includes(agent.identity.location.workspace_id)
}

function isBlockedOrUnknown(availability: string): boolean {
  const normalized = availability.trim().toLowerCase()
  return normalized === AGENT_AVAILABILITY.BLOCKED
    || normalized === AGENT_AVAILABILITY.UNKNOWN
    || normalized.startsWith(`${AGENT_AVAILABILITY.BLOCKED}:`)
    || normalized.startsWith(`${AGENT_AVAILABILITY.UNKNOWN}:`)
}

function snapshotRecord(input: unknown): RecordValue {
  if (!isRecord(input)) return {}
  const result = recordValue(input, "result")
  const resultRecord = isRecord(result) ? result : input
  const snapshot = recordValue(resultRecord, "snapshot")
  return isRecord(snapshot) ? snapshot : resultRecord
}

function readLocation(value: RecordValue): HerdrLocation | undefined {
  const workspaceId = readString(value, ["workspace_id"])
  const tabId = readString(value, ["tab_id"])
  const paneId = readString(value, ["pane_id"])
  if (workspaceId === undefined || tabId === undefined || paneId === undefined) return undefined
  const location = { workspace_id: workspaceId, tab_id: tabId, pane_id: paneId }
  validateHerdrLocation(location)
  return location
}

function readSessionId(value: RecordValue): string | undefined {
  const direct = readString(value, ["session_id"])
  if (direct !== undefined) return direct
  const session = recordValue(value, "agent_session")
  if (!isRecord(session)) return undefined
  return readString(session, ["value", "session_id"])
}

function readProvider(value: RecordValue): string {
  const agent = recordValue(value, "agent")
  if (typeof agent === "string" && agent.trim() !== "") return agent.trim()
  return readNestedString(value, "agent", "provider") ?? readString(value, ["provider"]) ?? "unknown"
}

function readNestedString(value: RecordValue, parentKey: string, childKey: string): string | undefined {
  const parent = recordValue(value, parentKey)
  return isRecord(parent) ? readString(parent, [childKey]) : undefined
}

function isNormalizedSnapshot(value: unknown): value is HerdrSnapshot {
  if (!isRecord(value) || !Array.isArray(value.agents)) return false
  return value.agents.every((agent) => {
    if (!isRecord(agent) || !isRecord(agent.identity)) return false
    return typeof agent.identity.provider === "string"
      && typeof agent.identity.session_id === "string"
      && isRecord(agent.identity.location)
  })
}

function sameLocation(left: HerdrLocation, right: HerdrLocation): boolean {
  return left.workspace_id === right.workspace_id && left.tab_id === right.tab_id && left.pane_id === right.pane_id
}

function sameIdentity(left: AgentIdentity, right: AgentIdentity): boolean {
  return left.provider === right.provider
    && left.session_id === right.session_id
    && sameLocation(left.location, right.location)
}

function readString(value: RecordValue, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim()
  }
  return undefined
}

function readNumber(value: RecordValue, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined
}

function recordValue(value: RecordValue, key: string): unknown {
  return value[key]
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireText(text: string): string {
  if (typeof text !== "string" || text.trim() === "") {
    throw new HerdrRejectionError(REJECTION_CODE.INVALID_ARGUMENT, "message text must not be empty")
  }
  return text
}

function summarizeCommandFailure(result: HerdrCommandResult): string {
  return (result.stderr || result.stdout).trim().replace(/[\r\n]+/g, " ").slice(0, 400)
}

type RecordValue = Record<string, unknown>
