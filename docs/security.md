# Security and authorization

Herdr Team treats a message as an explicit user-authorized action, not as a discovery side effect.

## Routing rules

1. `workspace_id`, `tab_id`, `pane_id`, and `session_id` are the routing identity.
2. Labels, terminal titles, cwd, and focus are descriptive metadata only.
3. No request broadcasts. A directed send names one exact `pane_id`.
4. The default scope is the verified current tab from the exact Herdr caller context. A request without that context must provide an explicit scope.
5. Cross-tab and cross-workspace scope must be present in the request. Focus never supplies it.
6. The target identity is checked before submission and revalidated from a fresh snapshot immediately before submission. A changed session, tab, workspace, or pane is rejected.

## Authorization

The send path requires all of the following:

- explicit `--authorize` in the CLI, or `authorize: true` in the daemon protocol;
- exact target pane ID;
- exact message text;
- envelope consent for both target and content;
- correlation and idempotency fields.

Transport arguments are passed as an argv array with `shell: false`; message text is never shell-interpolated.

## Provider boundary

This repository does not pretend to authenticate to or deliver inside Claude, Codex, Gemini, or Antigravity. Those receive adapters require separate capability declarations, tests, and user-visible delivery evidence.
