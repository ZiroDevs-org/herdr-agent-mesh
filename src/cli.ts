import { readHerdrCallerContext } from "./context"
import {
  HerdrCliTransport,
  HerdrTeamClient,
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
  type RejectionCode,
} from "./protocol"
import { SCOPE_KIND } from "./protocol"

export interface CliDependencies {
  env?: NodeJS.ProcessEnv
  transport?: HerdrTransport
  deduplicationStore?: DeduplicationStore
  issueConsent?: (request: ConsentRequest) => ConsentReceipt | Promise<ConsentReceipt>
  now?: () => Date
  makeId?: () => string
  write?: (line: string) => void
}

interface CliOptions {
  tab_id?: string
  workspace_ids: string[]
  target_pane_id?: string
  text?: string
  message_id?: string
  correlation_id?: string
  idempotency_key?: string
  authorize: boolean
}

class CliUsageError extends HerdrRejectionError {
  constructor(message: string, code: RejectionCode = REJECTION_CODE.INVALID_REQUEST) {
    super(code, message)
  }
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const [command, ...arguments_] = argv

  if (command === undefined || command === "help" || command === "--help") {
    write(usage())
    return 0
  }

  try {
    const options = parseOptions(arguments_)
    const env = dependencies.env ?? process.env
    const caller = readHerdrCallerContext(env)
    const client = new HerdrTeamClient({
      transport: dependencies.transport ?? new HerdrCliTransport(),
      caller,
      deduplicationStore: dependencies.deduplicationStore,
      now: dependencies.now,
      makeId: dependencies.makeId,
    })

    if (command === "discover") {
      const result = await client.discover(scopeFromOptions(options))
      write(JSON.stringify(result, null, 2))
      return 0
    }

    if (command === "send") {
      if (options.target_pane_id === undefined) {
        throw new CliUsageError("send requires --target-pane <pane_id>", REJECTION_CODE.MISSING_ARGUMENT)
      }
      if (options.text === undefined) {
        throw new CliUsageError("send requires --text <message>", REJECTION_CODE.MISSING_ARGUMENT)
      }
      if (!options.authorize) {
        throw new CliUsageError("send requires --authorize after reviewing the exact target and text", REJECTION_CODE.AUTHORIZATION_REQUIRED)
      }

      const envelope = await client.createEnvelope({
        target_pane_id: options.target_pane_id,
        text: options.text,
        scope: scopeFromOptions(options),
        message_id: options.message_id,
        correlation_id: options.correlation_id,
        idempotency_key: options.idempotency_key,
      })
      const issueConsent = dependencies.issueConsent ?? ((request: ConsentRequest) => issueConsentReceipt(request))
      const consent = await issueConsent({
        message_id: envelope.message_id,
        target_pane_id: envelope.recipient.location.pane_id,
        scope: envelope.scope,
        text: envelope.body.text,
      })
      const result = await client.sendAuthorized(envelope, consent)
      write(JSON.stringify(result, null, 2))
      return result.state === "failed" || result.state === "unknown" ? 1 : 0
    }

    throw new CliUsageError(`unknown command '${command}'`)
  } catch (error) {
    const rejection = createRejectedDeliveryResult(error, dependencies.now, optionValue(arguments_, "--message-id"))
    write(JSON.stringify(rejection, null, 2))
    return error instanceof CliUsageError ? 2 : 1
  }
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { workspace_ids: [], authorize: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--authorize" || argument === "--json") {
      if (argument === "--authorize") options.authorize = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${argument} requires a value`, REJECTION_CODE.MISSING_ARGUMENT)
    }
    if (argument === "--tab-id") {
      if (options.tab_id !== undefined) throw new CliUsageError("--tab-id may be provided once")
      options.tab_id = value
    } else if (argument === "--workspace-id") {
      options.workspace_ids.push(value)
    } else if (argument === "--target-pane") {
      if (options.target_pane_id !== undefined) throw new CliUsageError("--target-pane may be provided once")
      options.target_pane_id = value
    } else if (argument === "--text") {
      if (options.text !== undefined) throw new CliUsageError("--text may be provided once")
      options.text = value
    } else if (argument === "--message-id") {
      options.message_id = value
    } else if (argument === "--correlation-id") {
      options.correlation_id = value
    } else if (argument === "--idempotency-key") {
      options.idempotency_key = value
    } else {
      throw new CliUsageError(`unknown option '${argument}'`)
    }
    index += 1
  }
  return options
}

function scopeFromOptions(options: CliOptions): ExplicitScope | undefined {
  if (options.tab_id !== undefined && options.workspace_ids.length > 0) {
    throw new CliUsageError("choose either --tab-id or --workspace-id, not both")
  }
  if (options.tab_id !== undefined) return { kind: SCOPE_KIND.TAB, tab_id: options.tab_id }
  if (options.workspace_ids.length > 0) return { kind: SCOPE_KIND.WORKSPACES, workspace_ids: options.workspace_ids }
  return undefined
}

function usage(): string {
  return [
    "Herdr Team local bridge",
    "",
    "  discover [--tab-id ID | --workspace-id ID ...] [--json]",
    "  send --target-pane ID --text TEXT [--tab-id ID | --workspace-id ID ...] --authorize",
    "",
    "Default discovery scope is the verified current Herdr tab. Cross-tab and cross-workspace scope must be explicit.",
    "Send reports submitted_to_herdr only; it does not claim delivery or processing.",
  ].join("\n")
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && !value.startsWith("--") ? value : undefined
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2))
  process.exitCode = exitCode
}
