# Provider adapter boundary

Provider-specific receive adapters are intentionally deferred. HT-001 through HT-003 only define the neutral envelope and local Herdr submission path.

Future adapters must:

1. declare capabilities instead of implying them from a provider label;
2. bind evidence to the exact `workspace_id`, `tab_id`, `pane_id`, and `session_id` from the envelope;
3. preserve `message_id`, `correlation_id`, and `idempotency_key`;
4. report `observed`, `delivered`, `processed`, or `replied` only when the adapter has provider-specific evidence;
5. fail closed when the target identity changes or when the provider session cannot be verified;
6. add tests for duplicate delivery, stale panes, provider disconnects, and unsupported provider paths.

No Claude, Codex, Gemini, or Antigravity receive adapter is included or claimed by this repository.
