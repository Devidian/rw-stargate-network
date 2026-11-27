# Registry and transfers
<!-- codemap-id: rw-stargate-network/registry -->

## Responsibility

Persist network, server, gate and transfer state in MongoDB. Relay coordinates bounded opaque transfers while the plugin owns game inventory. Claimed transfers must not be automatically aborted.

## Source and tests

- [`StargateRelay`](../../src/main.ts) handles registry and transfer requests. [`TransferStateStore`](../../src/transfer-state.ts) owns durable acceptance, release, claim, completion, abort and expiry transitions. [Protocol](../../src/protocol.ts) supplies payload limits and timing.
- [Transfer state smoke](../../scripts/transfer-state-smoke.js), [Mongo transfer smoke](../../scripts/transfer-smoke.js) and [migration smoke](../../scripts/code-migration-smoke.js) cover persistence-sensitive behavior. MongoDB and relay settings are read in [startup](../../src/main.ts).
