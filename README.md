# Herdr Agent Mesh

Herdr Agent Mesh is a small, provider-neutral TypeScript skeleton for routing explicitly authorized messages between local Herdr panes.

This work unit provides:

- protocol/domain types for identities, Herdr locations, explicit scope, capabilities, envelopes, correlation/idempotency, and delivery states;
- an injectable Herdr transport using the official `herdr api snapshot` and `herdr agent prompt <pane_id> <text>` contract;
- topology discovery with verified-current-tab defaults and explicit cross-tab/workspace scope;
- a read-only discovery CLI, an explicit directed-send CLI, and a JSON-lines daemon;
- an initial `herdr-plugin.toml` manifest.

## Status boundary

The send path reports `submitted_to_herdr` when Herdr accepts the prompt. It does **not** claim that a provider received, displayed, processed, or replied to the message. Provider-specific receive adapters are intentionally out of scope for this work unit.

The current capability model sets `can_receive` and `can_reply` to `false` until those adapters exist. Claude, Codex, Gemini, and Antigravity delivery must not be inferred from discovery or submission.

Consent is issued separately from the message envelope. The CLI `--authorize` flag and daemon `authorize: true` entrypoints call the consent factory, which returns an in-process receipt/token bound to the exact message ID, target pane, scope, and text. A fabricated receipt-shaped object is rejected.

Idempotency is backed by an injectable deduplication store. The default store is memory-only for the current client process: a daemon retains entries for its lifetime, while separate CLI invocations do not share them. A duplicate key returns the existing receipt (or an `unknown` in-flight result) without submitting a second prompt; durable persistence is intentionally deferred.

## Requirements

- Bun 1.1+ or Node 20+ with Bun available for the test/build scripts.
- A local `herdr` executable when using the default transport. Set `HERDR_AGENT_MESH_HERDR_BIN` only when the executable has a different local path.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun run build
bun run validate:manifest
bun run validate:pack
```

## CLI

```sh
# Defaults to the verified current tab when Herdr supplies
# HERDR_WORKSPACE_ID, HERDR_TAB_ID, and HERDR_PANE_ID.

# Cross-tab/workspace routing must be explicit.
bun run src/cli.ts discover --tab-id w1:t1 --json
bun run src/cli.ts discover --workspace-id w1 --workspace-id w2 --json

# Review the exact target and content before supplying --authorize.
bun run src/cli.ts send \
  --target-pane w1:p2 \
  --text "Please review the topology change." \
  --tab-id w1:t1 \
  --authorize \
  --json
```

The CLI never broadcasts. Pane IDs are exact routing identities; labels, cwd, title, and focus are descriptive metadata only. Validation and authorization failures are JSON results with `state: "rejected"` and a machine-readable `reason.code`.

## Daemon

`bun run src/daemon.ts` reads one JSON request per line and writes one JSON response per line. It supports `discover` and `send`. A send request must include `authorize: true`, `target_pane_id`, and `text`. Use an explicit `scope` object for cross-tab/workspace requests.

## Project layout

- `src/protocol.ts` — provider-neutral domain contracts and validation.
- `src/herdr-client.ts` — injectable transport, official Herdr adapter, snapshot normalization, revalidation, and honest receipts.
- `src/context.ts` — exact Herdr pane context parsing.
- `src/cli.ts` and `src/daemon.ts` — local entrypoints only.
- `herdr-plugin.toml` — initial Herdr plugin manifest.
- `docs/` — security, delivery semantics, and future adapter boundary.

## License

MIT. See `LICENSE`.
