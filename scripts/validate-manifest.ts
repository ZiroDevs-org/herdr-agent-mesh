import { readFileSync } from "node:fs"

const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8")
const required = [
  'id = "herdr-agent-mesh"',
  'name = "Herdr Agent Mesh"',
  '[[actions]]',
  'id = "discover"',
  'id = "send"',
  '[[panes]]',
  '[[startup]]',
  '[[events]]',
]
const missing = required.filter((entry) => !manifest.includes(entry))
if (missing.length > 0) throw new Error(`manifest is missing: ${missing.join(", ")}`)
if (manifest.includes("broadcast")) throw new Error("manifest must not expose broadcast")
if (manifest.includes("src/cli.ts") || manifest.includes("src/daemon.ts")) {
  throw new Error("manifest must invoke package-shipped entrypoints, not source files")
}
if (!manifest.includes('command = ["herdr-agent-mesh"') || !manifest.includes('command = ["herdr-agent-mesh-daemon"')) {
  throw new Error("manifest must invoke the packaged herdr-agent-mesh binaries")
}
process.stdout.write("herdr-plugin.toml: required sections and identifiers present\n")
