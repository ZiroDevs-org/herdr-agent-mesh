import { randomUUID } from "node:crypto"

export const PROTOCOL = {
  NAME: "herdr-agent-mesh",
  MESSAGE_SCHEMA: "herdr-agent-mesh.message/v1",
  TOPOLOGY_SCHEMA: "herdr-agent-mesh.topology/v1",
} as const

export const SCOPE_KIND = {
  TAB: "tab",
  WORKSPACES: "workspaces",
} as const

export const AGENT_AVAILABILITY = {
  IDLE: "idle",
  WORKING: "working",
  BLOCKED: "blocked",
  DONE: "done",
  UNKNOWN: "unknown",
} as const

export const DELIVERY_STATE = {
  REJECTED: "rejected",
  SUBMITTED_TO_HERDR: "submitted_to_herdr",
  OBSERVED: "observed",
  DELIVERED: "delivered",
  PROCESSED: "processed",
  REPLIED: "replied",
  FAILED: "failed",
  UNKNOWN: "unknown",
} as const

export const CONSENT = {
  RECEIPT_TYPE: "herdr-agent-mesh.consent/v1",
} as const

export const REJECTION_CODE = {
  INVALID_REQUEST: "invalid_request",
  INVALID_ARGUMENT: "invalid_argument",
  INVALID_SCOPE: "invalid_scope",
  INVALID_IDENTITY: "invalid_identity",
  MISSING_ARGUMENT: "missing_argument",
  AUTHORIZATION_REQUIRED: "authorization_required",
  CONSENT_INVALID: "consent_invalid",
  TARGET_NOT_ELIGIBLE: "target_not_eligible",
  TARGET_STALE: "target_stale",
  SENDER_STALE: "sender_stale",
  OUT_OF_SCOPE: "out_of_scope",
} as const

export type ScopeKind = (typeof SCOPE_KIND)[keyof typeof SCOPE_KIND]
export type AgentAvailability = (typeof AGENT_AVAILABILITY)[keyof typeof AGENT_AVAILABILITY]
export type DeliveryState = (typeof DELIVERY_STATE)[keyof typeof DELIVERY_STATE]
export type RejectionCode = (typeof REJECTION_CODE)[keyof typeof REJECTION_CODE]

export interface HerdrLocation {
  workspace_id: string
  tab_id: string
  pane_id: string
}

export interface AgentIdentity {
  provider: string
  session_id: string
  location: HerdrLocation
}

export interface TabScope {
  kind: typeof SCOPE_KIND.TAB
  tab_id: string
}

export interface WorkspaceScope {
  kind: typeof SCOPE_KIND.WORKSPACES
  workspace_ids: readonly string[]
}

export type ExplicitScope = TabScope | WorkspaceScope

export interface AgentCapabilities {
  can_discover: boolean
  can_submit_to_herdr: boolean
  can_receive: boolean
  can_reply: boolean
}

export interface AgentMetadata {
  label: string
  title: string
  cwd: string
  focused: boolean
}

export interface AgentDescriptor {
  identity: AgentIdentity
  availability: AgentAvailability | string
  capabilities: AgentCapabilities
  metadata: AgentMetadata
}

export interface MessageBody {
  text: string
}

export interface MessageEnvelope {
  schema: typeof PROTOCOL.MESSAGE_SCHEMA
  message_id: string
  correlation_id: string
  idempotency_key: string
  sender: AgentIdentity
  recipient: AgentIdentity
  scope: ExplicitScope
  body: MessageBody
  created_at: string
}

export interface ConsentRequest {
  message_id: string
  target_pane_id: string
  scope: ExplicitScope
  text: string
}

export interface ConsentReceipt {
  type: typeof CONSENT.RECEIPT_TYPE
  token: string
  message_id: string
  target_pane_id: string
  scope: ExplicitScope
  text: string
  approved_at: string
}

export interface ConsentFactoryOptions {
  now?: () => Date
  makeToken?: () => string
}

export interface DeliveryReceipt {
  message_id: string
  state: Exclude<DeliveryState, typeof DELIVERY_STATE.REJECTED>
  recorded_at: string
  detail?: string
}

export interface DeliveryRejection {
  code: RejectionCode
  message: string
  details?: Readonly<Record<string, string>>
}

export interface RejectedDeliveryResult {
  message_id?: string
  state: typeof DELIVERY_STATE.REJECTED
  recorded_at: string
  reason: DeliveryRejection
}

export type PublicDeliveryResult = DeliveryReceipt | RejectedDeliveryResult

export class HerdrRejectionError extends Error {
  readonly code: RejectionCode
  readonly details: Readonly<Record<string, string>> | undefined

  constructor(code: RejectionCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message)
    this.name = "HerdrRejectionError"
    this.code = code
    this.details = details
  }
}

const issuedConsentReceipts = new Map<string, ConsentReceipt>()

const DELIVERY_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  [DELIVERY_STATE.REJECTED]: [DELIVERY_STATE.REJECTED],
  [DELIVERY_STATE.SUBMITTED_TO_HERDR]: [
    DELIVERY_STATE.SUBMITTED_TO_HERDR,
    DELIVERY_STATE.OBSERVED,
    DELIVERY_STATE.DELIVERED,
    DELIVERY_STATE.FAILED,
    DELIVERY_STATE.UNKNOWN,
  ],
  [DELIVERY_STATE.OBSERVED]: [
    DELIVERY_STATE.OBSERVED,
    DELIVERY_STATE.DELIVERED,
    DELIVERY_STATE.PROCESSED,
    DELIVERY_STATE.FAILED,
    DELIVERY_STATE.UNKNOWN,
  ],
  [DELIVERY_STATE.DELIVERED]: [
    DELIVERY_STATE.DELIVERED,
    DELIVERY_STATE.PROCESSED,
    DELIVERY_STATE.FAILED,
    DELIVERY_STATE.UNKNOWN,
  ],
  [DELIVERY_STATE.PROCESSED]: [
    DELIVERY_STATE.PROCESSED,
    DELIVERY_STATE.REPLIED,
    DELIVERY_STATE.FAILED,
    DELIVERY_STATE.UNKNOWN,
  ],
  [DELIVERY_STATE.REPLIED]: [DELIVERY_STATE.REPLIED],
  [DELIVERY_STATE.FAILED]: [DELIVERY_STATE.FAILED],
  [DELIVERY_STATE.UNKNOWN]: [
    DELIVERY_STATE.UNKNOWN,
    DELIVERY_STATE.OBSERVED,
    DELIVERY_STATE.DELIVERED,
    DELIVERY_STATE.PROCESSED,
    DELIVERY_STATE.REPLIED,
    DELIVERY_STATE.FAILED,
  ],
}

export function canTransitionDeliveryState(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to)
}

export function validateHerdrLocation(location: HerdrLocation): void {
  requireNonEmpty(location.workspace_id, "workspace_id", REJECTION_CODE.INVALID_IDENTITY)
  requireNonEmpty(location.tab_id, "tab_id", REJECTION_CODE.INVALID_IDENTITY)
  requireNonEmpty(location.pane_id, "pane_id", REJECTION_CODE.INVALID_IDENTITY)
}

export function validateAgentIdentity(identity: AgentIdentity): void {
  requireNonEmpty(identity.provider, "provider", REJECTION_CODE.INVALID_IDENTITY)
  requireNonEmpty(identity.session_id, "session_id", REJECTION_CODE.INVALID_IDENTITY)
  validateHerdrLocation(identity.location)
}

export function validateExplicitScope(scope: ExplicitScope): void {
  if (scope.kind === SCOPE_KIND.TAB) {
    requireNonEmpty(scope.tab_id, "tab_id", REJECTION_CODE.INVALID_SCOPE)
    return
  }

  if (scope.kind === SCOPE_KIND.WORKSPACES) {
    if (scope.workspace_ids.length === 0) {
      throw new HerdrRejectionError(REJECTION_CODE.INVALID_SCOPE, "workspace_ids must not be empty")
    }
    for (const workspaceId of scope.workspace_ids) {
      requireNonEmpty(workspaceId, "workspace_ids", REJECTION_CODE.INVALID_SCOPE)
    }
    return
  }

  throw new HerdrRejectionError(REJECTION_CODE.INVALID_SCOPE, "scope kind is not supported")
}

export function validateMessageEnvelope(envelope: MessageEnvelope): void {
  if (envelope.schema !== PROTOCOL.MESSAGE_SCHEMA) {
    throw new HerdrRejectionError(REJECTION_CODE.INVALID_REQUEST, "unsupported message schema")
  }
  if ("consent" in envelope) {
    throw new HerdrRejectionError(REJECTION_CODE.INVALID_REQUEST, "envelope must not carry consent flags")
  }
  requireNonEmpty(envelope.message_id, "message_id", REJECTION_CODE.INVALID_ARGUMENT)
  requireNonEmpty(envelope.correlation_id, "correlation_id", REJECTION_CODE.INVALID_ARGUMENT)
  requireNonEmpty(envelope.idempotency_key, "idempotency_key", REJECTION_CODE.INVALID_ARGUMENT)
  requireNonEmpty(envelope.body.text, "message text", REJECTION_CODE.INVALID_ARGUMENT)
  requireNonEmpty(envelope.created_at, "created_at", REJECTION_CODE.INVALID_ARGUMENT)
  validateAgentIdentity(envelope.sender)
  validateAgentIdentity(envelope.recipient)
  validateExplicitScope(envelope.scope)
}

export function issueConsentReceipt(request: ConsentRequest, options: ConsentFactoryOptions = {}): ConsentReceipt {
  requireNonEmpty(request.message_id, "message_id", REJECTION_CODE.INVALID_ARGUMENT)
  requireNonEmpty(request.target_pane_id, "target_pane_id", REJECTION_CODE.INVALID_ARGUMENT)
  requireNonEmpty(request.text, "message text", REJECTION_CODE.INVALID_ARGUMENT)
  validateExplicitScope(request.scope)

  const receipt: ConsentReceipt = {
    type: CONSENT.RECEIPT_TYPE,
    token: options.makeToken?.() ?? randomUUID(),
    message_id: request.message_id,
    target_pane_id: request.target_pane_id,
    scope: request.scope,
    text: request.text,
    approved_at: (options.now?.() ?? new Date()).toISOString(),
  }
  requireNonEmpty(receipt.token, "consent token", REJECTION_CODE.CONSENT_INVALID)
  issuedConsentReceipts.set(receipt.token, receipt)
  return receipt
}

export function validateConsentReceipt(envelope: MessageEnvelope, value: unknown): asserts value is ConsentReceipt {
  if (!isConsentReceipt(value)) {
    throw new HerdrRejectionError(REJECTION_CODE.CONSENT_INVALID, "consent receipt is required")
  }
  const issued = issuedConsentReceipts.get(value.token)
  if (issued === undefined || !sameConsentReceipt(issued, value)) {
    throw new HerdrRejectionError(REJECTION_CODE.CONSENT_INVALID, "consent receipt was not issued for this approval")
  }
  if (value.message_id !== envelope.message_id) {
    throw new HerdrRejectionError(REJECTION_CODE.CONSENT_INVALID, "consent receipt message_id does not match")
  }
  if (value.target_pane_id !== envelope.recipient.location.pane_id) {
    throw new HerdrRejectionError(REJECTION_CODE.CONSENT_INVALID, "consent receipt target pane does not match")
  }
  if (value.text !== envelope.body.text) {
    throw new HerdrRejectionError(REJECTION_CODE.CONSENT_INVALID, "consent receipt message text does not match")
  }
  if (!sameScope(value.scope, envelope.scope)) {
    throw new HerdrRejectionError(REJECTION_CODE.CONSENT_INVALID, "consent receipt scope does not match")
  }
}

export function createRejectedDeliveryResult(
  error: unknown,
  now: () => Date = () => new Date(),
  messageId?: string,
): RejectedDeliveryResult {
  const reason: DeliveryRejection = error instanceof HerdrRejectionError
    ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    : { code: REJECTION_CODE.INVALID_REQUEST, message: error instanceof Error ? error.message : "invalid request" }
  return {
    ...(messageId === undefined ? {} : { message_id: messageId }),
    state: DELIVERY_STATE.REJECTED,
    recorded_at: now().toISOString(),
    reason,
  }
}

function sameConsentReceipt(left: ConsentReceipt, right: ConsentReceipt): boolean {
  return left.type === right.type
    && left.message_id === right.message_id
    && left.target_pane_id === right.target_pane_id
    && left.text === right.text
    && left.approved_at === right.approved_at
    && sameScope(left.scope, right.scope)
}

function sameScope(left: ExplicitScope, right: ExplicitScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === SCOPE_KIND.TAB && right.kind === SCOPE_KIND.TAB) return left.tab_id === right.tab_id
  if (left.kind === SCOPE_KIND.WORKSPACES && right.kind === SCOPE_KIND.WORKSPACES) {
    return left.workspace_ids.length === right.workspace_ids.length
      && left.workspace_ids.every((workspaceId) => right.workspace_ids.includes(workspaceId))
  }
  return false
}

function isConsentReceipt(value: unknown): value is ConsentReceipt {
  return isRecord(value)
    && value.type === CONSENT.RECEIPT_TYPE
    && typeof value.token === "string"
    && typeof value.message_id === "string"
    && typeof value.target_pane_id === "string"
    && typeof value.text === "string"
    && typeof value.approved_at === "string"
    && isRecord(value.scope)
    && (value.scope.kind === SCOPE_KIND.TAB || value.scope.kind === SCOPE_KIND.WORKSPACES)
}

function requireNonEmpty(value: string, field: string, code: RejectionCode): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HerdrRejectionError(code, `${field} must not be empty`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
