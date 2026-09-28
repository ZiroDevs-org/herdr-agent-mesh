# Herdr Team

## Objective

Create an open-source, local-first Herdr plugin and provider-neutral bridge so independent AI Coding CLI sessions can discover one another and exchange explicitly authorized messages.

## Problem

Herdr can see agents in panes, tabs, and workspaces, but communication is currently tied to individual CLI integrations and does not provide one stable protocol across OpenCode, Codex CLI, Claude Code, Gemini CLI, and Antigravity CLI.

## Scope

- Provider-neutral message identity, envelope, scope, consent, delivery states, and correlation IDs.
- Herdr topology discovery across tabs and explicitly selected workspaces.
- Local-only Herdr transport with honest acknowledgement semantics.
- OpenCode adapter as the first verified adapter.
- Adapter contracts and capability matrix for Claude Code, Codex CLI, Gemini CLI, and Antigravity CLI.
- Herdr plugin manifest, local daemon/CLI entrypoint, documentation, and tests.

## Constraints

- Local-only MVP; no remote Herdr, TCP relay, SSH tunnel, cloud broker, or secret transport.
- Focus and labels are never identity; use Herdr pane IDs and provider session IDs.
- Current-tab scope is the default. Cross-tab/workspace scope must be explicit.
- No autonomous broadcast or guessed target.
- `submitted_to_herdr` is not equivalent to `delivered` or `processed`.
- Existing provider support is evidence-driven; unverified receive paths remain adapters/TODOs.
- Remote publication is separate from local implementation and requires an explicit repository destination.

## Authorized scope

- Local repository: `/home/guayaba/herdr-team`
- Local Herdr integration only.
- No remote GitHub operation has been authorized with a destination yet.

## Tasks

- [x] HT-001 Define provider-neutral protocol types, identity, scopes, capabilities, message envelopes, and delivery state machine.
- [x] HT-002 Implement Herdr snapshot client, topology discovery, explicit scope validation, consent boundary, and honest directed delivery.
- [x] HT-003 Add the Herdr plugin manifest and local command/daemon entrypoints.
- [ ] HT-004 Add OpenCode adapter and adapter interfaces/stubs for Claude Code, Codex CLI, Gemini CLI, and Antigravity CLI.
- [ ] HT-005 Add unit/integration tests for stale targets, scope violations, consent rejection, idempotency, and cross-workspace routing.
- [ ] HT-006 Write README, security model, delivery semantics, adapter matrix, and contribution guidance.

## Acceptance criteria

- A user can discover eligible agents in the current tab without relying on focus.
- Cross-tab/workspace discovery requires an explicit scope.
- A message requires explicit target and message authorization before transport.
- The system distinguishes rejected, submitted, observed, processed, replied, failed, and unknown outcomes.
- The OpenCode path is tested end-to-end through Herdr when available.
- Unsupported CLI receive paths are documented honestly rather than simulated.
- Tests and documentation run locally without remote credentials.

## Applicable checks

- `npm test` or the repository's configured test command.
- TypeScript typecheck/build.
- Herdr manifest/config validation.
- Local Herdr smoke test with an isolated target pane when available.
- Read-only structural review of the final repository tree.

## Route evidence

- Substantial multi-file architecture and implementation: delegated direct writer.
- Mapping trigger fired because the design spans the Herdr plugin contract, existing OpenCode integration, and five CLI adapter boundaries.
- Work-unit route: protocol/core first, Herdr/plugin integration second, adapters/tests/docs alongside behavior.

## Progress

- Repository initialized locally on `feature/herdr-team-core`; HT-001 through HT-003 implemented as the first local work unit.
- Corrective gate work completed: manifest commands now use packaged `herdr-team` and `herdr-team-daemon` binaries; live-shaped `agent: "opencode"` snapshots normalize correctly; CLI/daemon validation and authorization failures return typed `rejected` results; sender and target are both freshly revalidated; consent requires an issued receipt/token; and an injectable process-local deduplication store prevents duplicate prompt submission.
- Corrective evidence after implementation: `bun test` — 22 pass, 0 fail, 47 expect() calls across 5 files; `bunx tsc --noEmit` — exit 0 with no output; `bun run validate:manifest` — required sections and identifiers present; `bun run build` — 5 modules bundled (`dist/cli.js`, `dist/daemon.js`); `bun run validate:pack` — both manifest binaries resolve to packed entrypoints; `npm pack --dry-run` — tarball contains `dist/cli.js` and `dist/daemon.js` (9 files total); `git diff --check` — exit 0 with no output.

## Next step

Next: implement HT-004 with evidence-driven provider receive adapters, beginning with the verified OpenCode path; do not claim unsupported Claude, Codex, Gemini, or Antigravity delivery.
