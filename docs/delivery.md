# Delivery semantics

Herdr Team records the strongest state supported by local evidence and no stronger.

| State | Meaning |
| --- | --- |
| `rejected` | Validation or authorization prevented submission. |
| `submitted_to_herdr` | Herdr accepted the directed prompt command. Recipient observation is not confirmed. |
| `observed` | A later adapter observed the message in the target pane. Not implemented in this work unit. |
| `delivered` | A receive adapter has evidence that the provider received the message. Not implemented. |
| `processed` | A receive adapter has evidence that the provider processed the message. Not implemented. |
| `replied` | A receive adapter observed a reply. Not implemented. |
| `failed` | Herdr returned a non-zero command result. |
| `unknown` | The process or observation ended without a trustworthy outcome. |

`submitted_to_herdr` must never be rendered as `delivered` or `processed`. The protocol carries `message_id`, `correlation_id`, and `idempotency_key` independently so later adapters can correlate evidence without changing the submission claim.
