import { describe, expect, test } from "bun:test"
import {
  HerdrAgentMeshClient,
  MemoryDeduplicationStore,
  normalizeHerdrSnapshot,
  type HerdrCommandResult,
  type HerdrSnapshot,
  type HerdrTransport,
  type HerdrCallerContext,
} from "../src/herdr-client"
import {
  DELIVERY_STATE,
  issueConsentReceipt,
  type ConsentReceipt,
  type AgentDescriptor,
  type ExplicitScope,
  type MessageEnvelope,
} from "../src/protocol"

function agent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    identity: {
      provider: "opencode",
      session_id: "ses-current",
      location: {
        workspace_id: "w1",
        tab_id: "w1:t1",
        pane_id: "w1:p1",
      },
    },
    availability: "idle",
    capabilities: {
      can_discover: true,
      can_submit_to_herdr: true,
      can_receive: false,
      can_reply: false,
    },
    metadata: {
      label: "Primary",
      title: "Current agent",
      cwd: "/workspace/app",
      focused: false,
    },
    ...overrides,
  }
}

function snapshot(...agents: AgentDescriptor[]): HerdrSnapshot {
  return {
    protocol: 22,
    version: "0.9.0",
    agents,
  }
}

class FakeTransport implements HerdrTransport {
  readonly prompts: Array<{ pane_id: string; text: string }> = []
  private readonly snapshots: HerdrSnapshot[]

  constructor(...snapshots: HerdrSnapshot[]) {
    this.snapshots = snapshots
  }

  async snapshot(): Promise<HerdrSnapshot> {
    return this.snapshots.length > 1 ? this.snapshots.shift()! : this.snapshots[0]
  }

  async prompt(paneId: string, text: string): Promise<HerdrCommandResult> {
    this.prompts.push({ pane_id: paneId, text })
    return { stdout: "submitted", stderr: "", exit_code: 0 }
  }
}

const caller: HerdrCallerContext = {
  location: {
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
  },
}

describe("Herdr topology client", () => {
  test("normalizes the official Herdr snapshot identity fields without routing by focus", () => {
    const normalized = normalizeHerdrSnapshot({
      protocol: 22,
      version: "0.9.0",
      result: {
        agents: [
          {
            workspace_id: "w1",
            tab_id: "w1:t2",
            pane_id: "w1:p9",
            agent_session: { value: "ses-herdr" },
            agent: { provider: "gemini-cli" },
            agent_status: "working",
            cwd: "/workspace",
            focused: true,
          },
        ],
      },
    })

    expect(normalized.agents[0]).toMatchObject({
      identity: {
        provider: "gemini-cli",
        session_id: "ses-herdr",
        location: { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p9" },
      },
      metadata: { focused: true },
    })
  })

  test("recognizes the live snapshot provider when agent is the string opencode", () => {
    const normalized = normalizeHerdrSnapshot({
      protocol: 22,
      version: "0.9.0",
      result: {
        agents: [
          {
            workspace_id: "w1",
            tab_id: "w1:t1",
            pane_id: "w1:p1",
            agent_session: { value: "ses-opencode" },
            agent: "opencode",
            agent_status: "idle",
            cwd: "/workspace",
          },
        ],
      },
    })

    expect(normalized.agents[0]?.identity.provider).toBe("opencode")
  })

  test("defaults to the verified caller tab and never uses focus", async () => {
    const current = agent({ metadata: { label: "Current", title: "", cwd: "/a", focused: false } })
    const peer = agent({
      identity: {
        provider: "codex",
        session_id: "ses-peer",
        location: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2" },
      },
      metadata: { label: "Focused peer", title: "", cwd: "/b", focused: true },
    })
    const otherTab = agent({
      identity: {
        provider: "gemini-cli",
        session_id: "ses-other",
        location: { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3" },
      },
    })
    const client = new HerdrAgentMeshClient({ transport: new FakeTransport(snapshot(current, peer, otherTab)), caller })

    const roster = await client.discover()

    expect(roster.scope).toEqual({ kind: "tab", tab_id: "w1:t1" })
    expect(roster.agents.map((item) => item.identity.location.pane_id)).toEqual(["w1:p1", "w1:p2"])
  })

  test("requires explicit scope when caller context is unavailable", async () => {
    const client = new HerdrAgentMeshClient({ transport: new FakeTransport(snapshot(agent())) })

    await expect(client.discover()).rejects.toThrow("explicit scope")
  })

  test("allows cross-workspace discovery only with explicit scope", async () => {
    const first = agent()
    const second = agent({
      identity: {
        provider: "claude-code",
        session_id: "ses-two",
        location: { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" },
      },
    })
    const scope: ExplicitScope = { kind: "workspaces", workspace_ids: ["w1", "w2"] }
    const client = new HerdrAgentMeshClient({ transport: new FakeTransport(snapshot(first, second)), caller })

    const roster = await client.discover(scope)

    expect(roster.agents).toHaveLength(2)
    expect(roster.scope).toEqual(scope)
  })

  test("rejects authorization that does not match the exact target and text", async () => {
    const transport = new FakeTransport(snapshot(agent()), snapshot(agent()), snapshot(agent()))
    const client = new HerdrAgentMeshClient({ transport, caller })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, "hello")
    const authorization = issueConsentReceipt({
      message_id: envelope.message_id,
      target_pane_id: envelope.recipient.location.pane_id,
      scope: envelope.scope,
      text: "different text",
    })

    await expect(client.sendAuthorized(envelope, authorization)).rejects.toThrow("message text")
    expect(transport.prompts).toHaveLength(0)
  })

  test("revalidates a target against a fresh snapshot before transport", async () => {
    const sender = agent()
    const recipient = agent({
      identity: {
        provider: "gemini-cli",
        session_id: "ses-target",
        location: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2" },
      },
    })
    const transport = new FakeTransport(snapshot(sender, recipient), snapshot(sender))
    const client = new HerdrAgentMeshClient({ transport, caller })
    const envelope = messageFor(sender, recipient, { kind: "tab", tab_id: "w1:t1" }, "hello")
    const authorization = authorizationFor(envelope)

    await expect(client.sendAuthorized(envelope, authorization)).rejects.toThrow("not an eligible target")
    expect(transport.prompts).toHaveLength(0)
  })

  test("passes exact pane and text argv values and reports only submission", async () => {
    const text = "hello; $(must-not-run)\nsecond line"
    const transport = new FakeTransport(snapshot(agent()), snapshot(agent()), snapshot(agent()))
    const client = new HerdrAgentMeshClient({ transport, caller })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, text)

    const receipt = await client.sendAuthorized(envelope, authorizationFor(envelope))

    expect(transport.prompts).toEqual([{ pane_id: "w1:p1", text }])
    expect(receipt.state).toBe(DELIVERY_STATE.SUBMITTED_TO_HERDR)
    expect(receipt.state).not.toBe(DELIVERY_STATE.DELIVERED)
    expect(receipt.state).not.toBe(DELIVERY_STATE.PROCESSED)
  })

  test("revalidates the sender identity against the fresh snapshot", async () => {
    const staleSender = agent()
    const currentSender = agent({ identity: { ...staleSender.identity, session_id: "ses-new" } })
    const recipient = agent({
      identity: {
        provider: "gemini-cli",
        session_id: "ses-target",
        location: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2" },
      },
    })
    const transport = new FakeTransport(snapshot(staleSender, recipient), snapshot(currentSender, recipient))
    const client = new HerdrAgentMeshClient({ transport, caller })
    const envelope = messageFor(staleSender, recipient, { kind: "tab", tab_id: "w1:t1" }, "hello")

    await expect(client.sendAuthorized(envelope, authorizationFor(envelope))).rejects.toThrow("sender identity changed")
    expect(transport.prompts).toHaveLength(0)
  })

  test("requires a consent receipt issued by the explicit consent factory", async () => {
    const transport = new FakeTransport(snapshot(agent()), snapshot(agent()))
    const client = new HerdrAgentMeshClient({ transport, caller })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, "hello")

    await expect(client.sendAuthorized(envelope, undefined as unknown as ConsentReceipt)).rejects.toThrow("consent receipt")
    await expect(client.sendAuthorized(envelope, {
      type: "herdr-agent-mesh.consent/v1",
      token: "fabricated",
      message_id: envelope.message_id,
      target_pane_id: envelope.recipient.location.pane_id,
      scope: envelope.scope,
      text: envelope.body.text,
      approved_at: envelope.created_at,
    })).rejects.toThrow("consent receipt")
    expect(transport.prompts).toHaveLength(0)
  })

  test("does not create an envelope with approved consent flags", async () => {
    const client = new HerdrAgentMeshClient({ transport: new FakeTransport(snapshot(agent())), caller })

    const envelope = await client.createEnvelope({
      target_pane_id: "w1:p1",
      text: "hello",
      scope: { kind: "tab", tab_id: "w1:t1" },
    })

    expect("consent" in envelope).toBe(false)
  })

  test("deduplicates the same idempotency key without submitting a second prompt", async () => {
    const transport = new FakeTransport(snapshot(agent()), snapshot(agent()), snapshot(agent()))
    const client = new HerdrAgentMeshClient({
      transport,
      caller,
      deduplicationStore: new MemoryDeduplicationStore(),
    })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, "hello")
    const consent = authorizationFor(envelope)

    const first = await client.sendAuthorized(envelope, consent)
    const second = await client.sendAuthorized(envelope, consent)

    expect(first.state).toBe(DELIVERY_STATE.SUBMITTED_TO_HERDR)
    expect(second.state).toBe(DELIVERY_STATE.SUBMITTED_TO_HERDR)
    expect(second.detail).toContain("idempotency")
    expect(transport.prompts).toHaveLength(1)
  })
})

function messageFor(sender: AgentDescriptor, recipient: AgentDescriptor, scope: ExplicitScope, text: string): MessageEnvelope {
  return {
    schema: "herdr-agent-mesh.message/v1",
    message_id: "msg-1",
    correlation_id: "corr-1",
    idempotency_key: "idem-1",
    sender: sender.identity,
    recipient: recipient.identity,
    scope,
    body: { text },
    created_at: "2026-09-28T00:00:00.000Z",
  }
}

function authorizationFor(envelope: MessageEnvelope): ConsentReceipt {
  return issueConsentReceipt({
    message_id: envelope.message_id,
    target_pane_id: envelope.recipient.location.pane_id,
    scope: envelope.scope,
    text: envelope.body.text,
  })
}
