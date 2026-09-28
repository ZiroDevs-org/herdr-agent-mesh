import { describe, expect, test } from "bun:test"
import { runCli } from "../src/cli"
import type { HerdrCommandResult, HerdrSnapshot, HerdrTransport } from "../src/herdr-client"
import type { AgentDescriptor } from "../src/protocol"

function agent(): AgentDescriptor {
  return {
    identity: {
      provider: "opencode",
      session_id: "ses-current",
      location: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    },
    availability: "idle",
    capabilities: { can_discover: true, can_submit_to_herdr: true, can_receive: false, can_reply: false },
    metadata: { label: "Primary", title: "", cwd: "/workspace", focused: false },
  }
}

class FakeTransport implements HerdrTransport {
  readonly prompts: Array<{ pane_id: string; text: string }> = []
  private readonly state: HerdrSnapshot[]

  constructor(...state: HerdrSnapshot[]) {
    this.state = state
  }

  async snapshot(): Promise<HerdrSnapshot> {
    return this.state.length > 1 ? this.state.shift()! : this.state[0]
  }

  async prompt(paneId: string, text: string): Promise<HerdrCommandResult> {
    this.prompts.push({ pane_id: paneId, text })
    return { stdout: "ok", stderr: "", exit_code: 0 }
  }
}

function topology(): HerdrSnapshot {
  return { protocol: 22, version: "0.9.0", agents: [agent()] }
}

describe("Herdr Agent Mesh CLI", () => {
  test("exposes read-only discovery with explicit tab scope", async () => {
    const output: string[] = []
    const code = await runCli(["discover", "--tab-id", "w1:t1", "--json"], {
      env: {},
      transport: new FakeTransport(topology()),
      write: (line) => output.push(line),
    })

    expect(code).toBe(0)
    expect(JSON.parse(output[0])).toMatchObject({ scope: { kind: "tab", tab_id: "w1:t1" } })
  })

  test("requires the explicit authorization flag before directed send", async () => {
    const transport = new FakeTransport(topology())
    const output: string[] = []
    const code = await runCli(["send", "--target-pane", "w1:p1", "--text", "hello"], {
      env: {
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
        HERDR_PANE_ID: "w1:p1",
      },
      transport,
      write: (line) => output.push(line),
    })

    expect(code).toBe(2)
    expect(JSON.parse(output[0])).toMatchObject({
      state: "rejected",
      reason: { code: "authorization_required" },
    })
    expect(transport.prompts).toHaveLength(0)
  })

  test("uses an exact target and reports submitted_to_herdr, not delivered", async () => {
    const transport = new FakeTransport(topology(), topology(), topology())
    const output: string[] = []
    const code = await runCli([
      "send",
      "--target-pane", "w1:p1",
      "--text", "hello; $(not-shell-code)",
      "--tab-id", "w1:t1",
      "--authorize",
      "--json",
    ], {
      env: {
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
        HERDR_PANE_ID: "w1:p1",
      },
      transport,
      makeId: () => "msg-cli",
      write: (line) => output.push(line),
    })

    const result = JSON.parse(output[0]) as { state: string }
    expect(code).toBe(0)
    expect(transport.prompts).toEqual([{ pane_id: "w1:p1", text: "hello; $(not-shell-code)" }])
    expect(result.state).toBe("submitted_to_herdr")
  })
})
