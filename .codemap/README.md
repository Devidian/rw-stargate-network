# Stargate relay
<!-- codemap-id: rw-stargate-network -->

## Purpose

Standalone WebSocket relay and MongoDB registry for gates, networks and durable transfers. [Main](../src/main.ts) starts the relay and [protocol](../src/protocol.ts) defines the message envelope.

## Modules

- [Protocol and dial coordination](modules/protocol.md)
- [Registry and transfers](modules/registry.md)

## Build and tests

Run `yarn test` from [package scripts](../package.json). [Transfer smoke](../scripts/transfer-smoke.js) provides an isolated integration check.
