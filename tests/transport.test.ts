import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { HerdrCliTransport, type HerdrCommandResult, type SpawnedHerdrProcess } from "../src/herdr-client"

describe("Herdr CLI transport", () => {
  test("uses argv without shell interpolation and sets the official environment flag", async () => {
    const calls: Array<{ command: string; args: string[]; shell: boolean | undefined; env: NodeJS.ProcessEnv | undefined }> = []
    const spawnProcess = (command: string, args: string[], options: { shell?: boolean; env?: NodeJS.ProcessEnv }): SpawnedHerdrProcess => {
      calls.push({ command, args, shell: options.shell, env: options.env })
      return completedProcess({ stdout: "{\"result\":{\"snapshot\":{\"agents\":[]}}}", stderr: "", exit_code: 0 })
    }
    const transport = new HerdrCliTransport({ command: "/custom/herdr", spawnProcess })

    await transport.snapshot()
    await transport.prompt("w1:p1", "hello; $(not-shell-code)")

    expect(calls[0]).toMatchObject({ command: "/custom/herdr", args: ["api", "snapshot"], shell: false })
    expect(calls[1]).toMatchObject({ command: "/custom/herdr", args: ["agent", "prompt", "w1:p1", "hello; $(not-shell-code)"], shell: false })
    expect(calls[0].env?.HERDR_ENV).toBe("1")
  })
})

function completedProcess(result: HerdrCommandResult): SpawnedHerdrProcess {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let closeHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let errorHandler: ((error: Error) => void) | undefined
  const process: SpawnedHerdrProcess = {
    stdout,
    stderr,
    on(event, listener) {
      if (event === "close") closeHandler = listener as (code: number | null, signal: NodeJS.Signals | null) => void
      if (event === "error") errorHandler = listener as (error: Error) => void
      return process
    },
  }
  queueMicrotask(() => {
    stdout.end(result.stdout)
    stderr.end(result.stderr)
    if (result.exit_code === null) errorHandler?.(new Error("transport failed"))
    else closeHandler?.(result.exit_code, null)
  })
  return process
}
