# Protocol and dial coordination
<!-- codemap-id: rw-stargate-network/protocol -->

## Responsibility

Versioned WebSocket message parsing and dial coordination. Keep plugin and relay protocol changes compatible and preserve deadlines and correlation IDs.

## Source and tests

- [`parseMessage`](../../src/protocol.ts) validates envelopes; [`DialCoordinator`](../../src/dial-coordinator.ts) coordinates gate dialing. [`StargateRelay`](../../src/main.ts) dispatches messages.
- [Protocol smoke](../../src/contract-smoke.ts) and [dial smoke](../../src/dial-smoke.ts) validate protocol and dial behavior.

## Dependencies

- `rw-plugin-oz-stargate/network` — WebSocket protocol peer. [Protocol](../../src/protocol.ts)
