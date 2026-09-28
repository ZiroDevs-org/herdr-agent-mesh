import { readHerdrCallerContext } from "./context"
import {
  HerdrCliTransport,
  HerdrTeamClient,
  MemoryDeduplicationStore,
  type DeduplicationStore,
  type HerdrTransport,
} from "./herdr-client"
import {
  createRejectedDeliveryResult,
  HerdrRejectionError,
  issueConsentReceipt,
  REJECTION_CODE,
  type ConsentReceipt,
  type ConsentRequest,
  type ExplicitScope,
} from "./protocol"
import { SCOPE_KIND, validateExplicitScope } from "./protocol"

export interface DaemonRequest {
  id: string
  command: "discover" | "send"
  scope?: ExplicitScope
  target_pane_id?: string
  text?: string
  authorize?: boolean
  message_id?: string
  correlation_id?: string
  idempotency_key?: string
}

export interface DaemonResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface DaemonDependencies {
  env?: NodeJS.ProcessEnv
  transport?: HerdrTransport
  deduplicationStore?: DeduplicationStore
  issueConsent?: (request: ConsentRequest) => ConsentReceipt | Promise<ConsentReceipt>
  now?: () => Date
  makeId?: () => string
}

const DAEMON_DEDUPLICATION_STORE = new MemoryDeduplicationStore()

export async function handleDaemonRequest(
  input: unknown,
  dependencies: DaemonDependencies = {},
): Promise<DaemonResponse> {
  const id = requestId(input)
  try {
    const request = parseRequest(input)
    const client = new HerdrTeamClient({
      transport: dependencies.transport ?? new HerdrCliTransport(),
      caller: readHerdrCallerContext(dependencies.env ?? process.env),
      deduplicationStore: dependencies.deduplicationStore ?? DAEMON_DEDUPLICATION_STORE,
      now: dependencies.now,
      makeId: dependencies.makeId,
    })

    if (request.command === "discover") {
      return { id: request.id, ok: true, result: await client.discover(request.scope) }
    }

    if (request.target_pane_id === undefined) {
      throw new HerdrRejectionError(REJECTION_CODE.MISSING_ARGUMENT, "send requires target_pane_id")
    }
    if (request.text === undefined) {
      throw new HerdrRejectionError(REJECTION_CODE.MISSING_ARGUMENT, "send requires text")
    }
    if (request.authorize !== true) {
      throw new HerdrRejectionError(REJECTION_CODE.AUTHORIZATION_REQUIRED, "send requires authorize: true")
    }

    const envelope = await client.createEnvelope({
      target_pane_id: request.target_pane_id,
      text: request.text,
      scope: request.scope,
      message_id: request.message_id,
      correlation_id: request.correlation_id,
      idempotency_key: request.idempotency_key,
    })
    const issueConsent = dependencies.issueConsent ?? ((consentRequest: ConsentRequest) => issueConsentReceipt(consentRequest))
    const consent = await issueConsent({
      message_id: envelope.message_id,
      target_pane_id: envelope.recipient.location.pane_id,
      scope: envelope.scope,
      text: envelope.body.text,
    })
    return { id: request.id, ok: true, result: await client.sendAuthorized(envelope, consent) }
  } catch (error) {
    return {
      id,
      ok: false,
      result: createRejectedDeliveryResult(error, dependencies.now, messageId(input)),
    }
  }
}

export async function runDaemon(
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  dependencies: DaemonDependencies = {},
): Promise<void> {
  for await (const line of lines) {
    if (line.trim() === "") continue
    let response: DaemonResponse
    try {
      response = await handleDaemonRequest(JSON.parse(line) as unknown, dependencies)
    } catch (error) {
      response = {
        id: "unknown",
        ok: false,
        result: createRejectedDeliveryResult(
          new HerdrRejectionError(REJECTION_CODE.INVALID_REQUEST, error instanceof Error ? error.message : "invalid daemon request"),
          dependencies.now,
        ),
      }
    }
    write(JSON.stringify(response))
  }
}

function parseRequest(input: unknown): DaemonRequest {
  if (!isRecord(input)) throw new HerdrRejectionError(REJECTION_CODE.INVALID_REQUEST, "daemon request must be an object")
  const id = stringValue(input.id)
  const command = stringValue(input.command)
  if (id === undefined) throw new HerdrRejectionError(REJECTION_CODE.MISSING_ARGUMENT, "daemon request requires id")
  if (command !== "discover" && command !== "send") {
    throw new HerdrRejectionError(REJECTION_CODE.INVALID_ARGUMENT, "daemon command must be discover or send")
  }

  const scope = parseScope(input.scope)
  return {
    id,
    command,
    ...(scope === undefined ? {} : { scope }),
    target_pane_id: stringValue(input.target_pane_id),
    text: typeof input.text === "string" ? input.text : undefined,
    authorize: input.authorize === true,
    message_id: stringValue(input.message_id),
    correlation_id: stringValue(input.correlation_id),
    idempotency_key: stringValue(input.idempotency_key),
  }
}

function parseScope(input: unknown): ExplicitScope | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input)) throw new HerdrRejectionError(REJECTION_CODE.INVALID_SCOPE, "scope must be an object")
  const kind = stringValue(input.kind)
  if (kind === SCOPE_KIND.TAB && typeof input.tab_id === "string") {
    const scope = { kind: SCOPE_KIND.TAB, tab_id: input.tab_id }
    validateExplicitScope(scope)
    return scope
  }
  if (kind === SCOPE_KIND.WORKSPACES && Array.isArray(input.workspace_ids)
    && input.workspace_ids.every((value): value is string => typeof value === "string")) {
    const scope = { kind: SCOPE_KIND.WORKSPACES, workspace_ids: input.workspace_ids }
    validateExplicitScope(scope)
    return scope
  }
  throw new HerdrRejectionError(REJECTION_CODE.INVALID_SCOPE, "scope must contain a valid tab_id or workspace_ids")
}

function requestId(input: unknown): string {
  return isRecord(input) && typeof input.id === "string" && input.id.trim() !== "" ? input.id : "unknown"
}

function messageId(input: unknown): string | undefined {
  return isRecord(input) && typeof input.message_id === "string" && input.message_id.trim() !== ""
    ? input.message_id
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (import.meta.main) {
  await runDaemon(process.stdin, (line) => process.stdout.write(`${line}\n`))
}
