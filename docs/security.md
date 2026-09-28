# Security and authorization

Herdr Agent Mesh treats a message as an explicit user-authorized action, not as a discovery side effect.

## Routing rules

1. `workspace_id`, `tab_id`, `pane_id`, and `session_id` are the routing identity.
2. Labels, terminal titles, cwd, and focus are descriptive metadata only.
3. No request broadcasts. A directed send names one exact `pane_id`.
4. The default scope is the verified current tab from the exact Herdr caller context. A request without that context must provide an explicit scope.
5. Cross-tab and cross-workspace scope must be present in the request. Focus never supplies it.
6. The sender and target identities are checked before submission and revalidated from a fresh snapshot immediately before submission. A changed session, tab, workspace, or pane is rejected.

## Authorization

The send path requires all of the following:

- explicit `--authorize` in the CLI, or `authorize: true` in the daemon protocol;
- exact target pane ID;
- exact message text;
- a consent receipt issued by the entrypoint consent factory; the receipt is bound to the exact message ID, target, scope, and text;
- correlation and idempotency fields.

Transport arguments are passed as an argv array with `shell: false`; message text is never shell-interpolated.

The envelope itself never carries approved boolean consent flags. A caller that fabricates a receipt-shaped object without a token issued by the local consent factory is rejected. Idempotency is process-local memory by default: the daemon shares its store across requests for its lifetime, but separate CLI processes do not share it. Inject a durable store only when a later work unit defines its security and persistence policy.

## Provider boundary

This repository does not pretend to authenticate to or deliver inside Claude, Codex, Gemini, or Antigravity. Those receive adapters require separate capability declarations, tests, and user-visible delivery evidence.
