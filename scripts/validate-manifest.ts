import { readFileSync } from "node:fs"

const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8")
const required = [
  'id = "herdr-team"',
  'name = "Herdr Team"',
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
if (!manifest.includes('command = ["herdr-team"') || !manifest.includes('command = ["herdr-team-daemon"')) {
  throw new Error("manifest must invoke the packaged herdr-team binaries")
}
process.stdout.write("herdr-plugin.toml: required sections and identifiers present\n")
