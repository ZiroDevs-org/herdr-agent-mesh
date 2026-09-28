import { describe, expect, test } from "bun:test"
import {
  HerdrTeamClient,
  normalizeHerdrSnapshot,
  type HerdrCommandResult,
  type HerdrSnapshot,
  type HerdrTransport,
  type HerdrCallerContext,
} from "../src/herdr-client"
import {
  DELIVERY_STATE,
  type AgentDescriptor,
  type ExplicitScope,
  type MessageEnvelope,
  type SendAuthorization,
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
    const client = new HerdrTeamClient({ transport: new FakeTransport(snapshot(current, peer, otherTab)), caller })

    const roster = await client.discover()

    expect(roster.scope).toEqual({ kind: "tab", tab_id: "w1:t1" })
    expect(roster.agents.map((item) => item.identity.location.pane_id)).toEqual(["w1:p1", "w1:p2"])
  })

  test("requires explicit scope when caller context is unavailable", async () => {
    const client = new HerdrTeamClient({ transport: new FakeTransport(snapshot(agent())) })

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
    const client = new HerdrTeamClient({ transport: new FakeTransport(snapshot(first, second)), caller })

    const roster = await client.discover(scope)

    expect(roster.agents).toHaveLength(2)
    expect(roster.scope).toEqual(scope)
  })

  test("rejects authorization that does not match the exact target and text", async () => {
    const transport = new FakeTransport(snapshot(agent()), snapshot(agent()))
    const client = new HerdrTeamClient({ transport, caller })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, "hello")
    const authorization: SendAuthorization = {
      authorized: true,
      message_id: envelope.message_id,
      target_pane_id: "w1:p1",
      scope: envelope.scope,
      text: "different text",
      authorized_at: envelope.created_at,
    }

    await expect(client.sendAuthorized(envelope, authorization)).rejects.toThrow("message text")
    expect(transport.prompts).toHaveLength(0)
  })

  test("revalidates a target against a fresh snapshot before transport", async () => {
    const transport = new FakeTransport(snapshot(agent()), snapshot())
    const client = new HerdrTeamClient({ transport, caller })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, "hello")
    const authorization = authorizationFor(envelope)

    await expect(client.sendAuthorized(envelope, authorization)).rejects.toThrow("not an eligible target")
    expect(transport.prompts).toHaveLength(0)
  })

  test("passes exact pane and text argv values and reports only submission", async () => {
    const text = "hello; $(must-not-run)\nsecond line"
    const transport = new FakeTransport(snapshot(agent()), snapshot(agent()))
    const client = new HerdrTeamClient({ transport, caller })
    const envelope = messageFor(agent(), agent(), { kind: "tab", tab_id: "w1:t1" }, text)

    const receipt = await client.sendAuthorized(envelope, authorizationFor(envelope))

    expect(transport.prompts).toEqual([{ pane_id: "w1:p1", text }])
    expect(receipt.state).toBe(DELIVERY_STATE.SUBMITTED_TO_HERDR)
    expect(receipt.state).not.toBe(DELIVERY_STATE.DELIVERED)
    expect(receipt.state).not.toBe(DELIVERY_STATE.PROCESSED)
  })
})

function messageFor(sender: AgentDescriptor, recipient: AgentDescriptor, scope: ExplicitScope, text: string): MessageEnvelope {
  return {
    schema: "herdr-team.message/v1",
    message_id: "msg-1",
    correlation_id: "corr-1",
    idempotency_key: "idem-1",
    sender: sender.identity,
    recipient: recipient.identity,
    scope,
    body: { text },
    created_at: "2026-09-28T00:00:00.000Z",
    consent: {
      target_authorized: true,
      content_authorized: true,
      authorized_at: "2026-09-28T00:00:00.000Z",
    },
  }
}

function authorizationFor(envelope: MessageEnvelope): SendAuthorization {
  return {
    authorized: true,
    message_id: envelope.message_id,
    target_pane_id: envelope.recipient.location.pane_id,
    scope: envelope.scope,
    text: envelope.body.text,
    authorized_at: envelope.consent.authorized_at,
  }
}
