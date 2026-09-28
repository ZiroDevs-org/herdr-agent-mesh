import { describe, expect, test } from "bun:test"
import { handleDaemonRequest, runDaemon } from "../src/daemon"
import type { HerdrCommandResult, HerdrSnapshot, HerdrTransport } from "../src/herdr-client"
import type { AgentDescriptor } from "../src/protocol"

function agent(): AgentDescriptor {
  return {
    identity: {
      provider: "codex",
      session_id: "ses-current",
      location: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    },
    availability: "idle",
    capabilities: { can_discover: true, can_submit_to_herdr: true, can_receive: false, can_reply: false },
    metadata: { label: "", title: "", cwd: "/workspace", focused: true },
  }
}

class FakeTransport implements HerdrTransport {
  readonly prompts: string[] = []
  async snapshot(): Promise<HerdrSnapshot> {
    return { protocol: 22, version: "0.9.0", agents: [agent()] }
  }
  async prompt(paneId: string, _text: string): Promise<HerdrCommandResult> {
    this.prompts.push(paneId)
    return { stdout: "ok", stderr: "", exit_code: 0 }
  }
}

const env = { HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1" }

describe("Herdr Team daemon", () => {
  test("handles read-only discovery as JSON-lines", async () => {
    const output: string[] = []
    await runDaemon(
      (async function* () { yield '{"id":"d1","command":"discover"}' })(),
      (line) => output.push(line),
      { env, transport: new FakeTransport() },
    )

    expect(JSON.parse(output[0])).toMatchObject({ id: "d1", ok: true, result: { scope: { kind: "tab", tab_id: "w1:t1" } } })
  })

  test("rejects directed send without explicit authorization", async () => {
    const response = await handleDaemonRequest({
      id: "d2", command: "send", target_pane_id: "w1:p1", text: "hello",
    }, { env, transport: new FakeTransport() })

    expect(response).toMatchObject({
      id: "d2",
      ok: false,
      result: { state: "rejected", reason: { code: "authorization_required" } },
    })
  })

  test("returns a typed rejected result for invalid daemon input", async () => {
    const response = await handleDaemonRequest({ id: "d3", command: "send", text: "hello" }, { env, transport: new FakeTransport() })

    expect(response).toMatchObject({
      id: "d3",
      ok: false,
      result: { state: "rejected", reason: { code: "missing_argument" } },
    })
  })
})
