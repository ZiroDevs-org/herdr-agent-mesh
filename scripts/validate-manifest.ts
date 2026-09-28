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
process.stdout.write("herdr-plugin.toml: required sections and identifiers present\n")
