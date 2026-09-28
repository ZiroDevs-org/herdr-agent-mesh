import { readHerdrCallerContext } from "./context"
import { HerdrCliTransport, HerdrTeamClient, type HerdrTransport } from "./herdr-client"
import type { ExplicitScope, SendAuthorization } from "./protocol"
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
  now?: () => Date
  makeId?: () => string
}

export async function handleDaemonRequest(
  input: unknown,
  dependencies: DaemonDependencies = {},
): Promise<DaemonResponse> {
  const request = parseRequest(input)
  try {
    const client = new HerdrTeamClient({
      transport: dependencies.transport ?? new HerdrCliTransport(),
      caller: readHerdrCallerContext(dependencies.env ?? process.env),
      now: dependencies.now,
      makeId: dependencies.makeId,
    })

    if (request.command === "discover") {
      return { id: request.id, ok: true, result: await client.discover(request.scope) }
    }

    if (request.target_pane_id === undefined) throw new Error("send requires target_pane_id")
    if (request.text === undefined) throw new Error("send requires text")
    if (request.authorize !== true) throw new Error("send requires authorize: true")

    const envelope = await client.createEnvelope({
      target_pane_id: request.target_pane_id,
      text: request.text,
      scope: request.scope,
      message_id: request.message_id,
      correlation_id: request.correlation_id,
      idempotency_key: request.idempotency_key,
    })
    const authorization: SendAuthorization = {
      authorized: true,
      message_id: envelope.message_id,
      target_pane_id: envelope.recipient.location.pane_id,
      scope: envelope.scope,
      text: envelope.body.text,
      authorized_at: envelope.consent.authorized_at,
    }
    return { id: request.id, ok: true, result: await client.sendAuthorized(envelope, authorization) }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : "unknown error" }
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
        error: error instanceof Error ? error.message : "invalid daemon request",
      }
    }
    write(JSON.stringify(response))
  }
}

function parseRequest(input: unknown): DaemonRequest {
  if (!isRecord(input)) throw new Error("daemon request must be an object")
  const id = stringValue(input.id)
  const command = stringValue(input.command)
  if (id === undefined) throw new Error("daemon request requires id")
  if (command !== "discover" && command !== "send") throw new Error("daemon command must be discover or send")

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
  if (!isRecord(input)) throw new Error("scope must be an object")
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
  throw new Error("scope must contain a valid tab_id or workspace_ids")
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
