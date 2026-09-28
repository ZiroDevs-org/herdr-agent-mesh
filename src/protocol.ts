export const PROTOCOL = {
  NAME: "herdr-team",
  MESSAGE_SCHEMA: "herdr-team.message/v1",
  TOPOLOGY_SCHEMA: "herdr-team.topology/v1",
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

export type ScopeKind = (typeof SCOPE_KIND)[keyof typeof SCOPE_KIND]
export type AgentAvailability = (typeof AGENT_AVAILABILITY)[keyof typeof AGENT_AVAILABILITY]
export type DeliveryState = (typeof DELIVERY_STATE)[keyof typeof DELIVERY_STATE]

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

export interface MessageConsent {
  target_authorized: true
  content_authorized: true
  authorized_at: string
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
  consent: MessageConsent
}

export interface SendAuthorization {
  authorized: true
  message_id: string
  target_pane_id: string
  scope: ExplicitScope
  text: string
  authorized_at: string
}

export interface DeliveryReceipt {
  message_id: string
  state: DeliveryState
  recorded_at: string
  detail?: string
}

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
  requireNonEmpty(location.workspace_id, "workspace_id")
  requireNonEmpty(location.tab_id, "tab_id")
  requireNonEmpty(location.pane_id, "pane_id")
}

export function validateAgentIdentity(identity: AgentIdentity): void {
  requireNonEmpty(identity.provider, "provider")
  requireNonEmpty(identity.session_id, "session_id")
  validateHerdrLocation(identity.location)
}

export function validateExplicitScope(scope: ExplicitScope): void {
  if (scope.kind === SCOPE_KIND.TAB) {
    requireNonEmpty(scope.tab_id, "tab_id")
    return
  }

  if (scope.kind === SCOPE_KIND.WORKSPACES) {
    if (scope.workspace_ids.length === 0) throw new Error("workspace_ids must not be empty")
    for (const workspaceId of scope.workspace_ids) requireNonEmpty(workspaceId, "workspace_ids")
    return
  }

  throw new Error("scope kind is not supported")
}

export function validateMessageEnvelope(envelope: MessageEnvelope): void {
  if (envelope.schema !== PROTOCOL.MESSAGE_SCHEMA) throw new Error("unsupported message schema")
  requireNonEmpty(envelope.message_id, "message_id")
  requireNonEmpty(envelope.correlation_id, "correlation_id")
  requireNonEmpty(envelope.idempotency_key, "idempotency_key")
  requireNonEmpty(envelope.body.text, "message text")
  validateAgentIdentity(envelope.sender)
  validateAgentIdentity(envelope.recipient)
  validateExplicitScope(envelope.scope)
  if (envelope.consent.target_authorized !== true || envelope.consent.content_authorized !== true) {
    throw new Error("message consent must explicitly authorize target and content")
  }
  requireNonEmpty(envelope.consent.authorized_at, "authorized_at")
}

export function validateSendAuthorization(envelope: MessageEnvelope, authorization: SendAuthorization): void {
  validateMessageEnvelope(envelope)
  if (authorization.authorized !== true) throw new Error("message authorization is required")
  if (authorization.message_id !== envelope.message_id) throw new Error("authorization message_id does not match")
  if (authorization.target_pane_id !== envelope.recipient.location.pane_id) {
    throw new Error("authorization target pane does not match message recipient")
  }
  if (authorization.text !== envelope.body.text) throw new Error("authorization message text does not match")
  if (!sameScope(authorization.scope, envelope.scope)) throw new Error("authorization scope does not match")
  requireNonEmpty(authorization.authorized_at, "authorized_at")
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

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must not be empty`)
}
