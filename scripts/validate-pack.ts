import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

interface PackageMetadata {
  bin?: Record<string, string>
}

interface PackedFile {
  path: string
}

interface PackResult {
  files?: PackedFile[]
}

const manifest = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8")
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageMetadata
const packageBins = packageJson.bin ?? {}
const manifestCommands = [...manifest.matchAll(/^command = \["([^"]+)"/gm)].map((match) => match[1])
const manifestTargets = [...new Set(manifestCommands.filter((command): command is string => command !== undefined && command in packageBins))]

if (manifestTargets.length === 0) throw new Error("manifest has no package binary targets")

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
})
const packResults = JSON.parse(output) as PackResult[]
const packedPaths = new Set(packResults[0]?.files?.map((file) => file.path) ?? [])

for (const target of manifestTargets) {
  const packagedPath = packageBins[target]
  if (packagedPath === undefined || !packedPaths.has(packagedPath)) {
    throw new Error(`manifest target '${target}' is not present in npm pack --dry-run output`)
  }
}

process.stdout.write(`npm pack --dry-run: ${manifestTargets.join(", ")} resolve to packed entrypoints\n`)
