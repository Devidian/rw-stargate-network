# Phase 2: gate discovery and dialing

## Objective

Connect two Development game servers through the dedicated relay. Admins can register a gate at their current position, list reachable addresses, and dial a remote server. No player data moves in this phase.

## Constraints

- Plugin remains the only game-facing component and the entry class remains the sole Listener.
- Relay code groups servers and is forgeable; use only controlled Development hosts.
- Local SQLite owns arrival transforms; MongoDB owns globally visible addresses.
- A command response has a ten-second deadline; incoming gate reservation lasts one minute.

## Checklist

- [x] Versioned protocol, request IDs, validation, bounded payload, deadlines, and explicit error responses.
- [x] MongoDB server/gate indexes, online state, ownership checks, same-server rejection, and dial relay.
- [x] Plugin network init, reconnect, world/plugin inventory, trusted-code persistence, local gate data, and admin commands.
- [x] Local TypeScript and Maven builds/tests.
- [x] Deploy isolated relay/MongoDB behind `sgn.omega-zirkel.de` TLS and install plugin on Development and rw-demo. Verify two distinct online IDs and the same test override.
- [x] Player test registration, list, remote dial, busy state, same-server rejection and reconnect accepted; later phase-3/4 travel and non-admin tests also passed.

The first player test found 90-second idle disconnects and a remote dial that reached the target but timed out at the origin. The target plugin omitted `networkCode` in its dial reply, which the relay correctly rejected. Repeat player testing accepted the heartbeat/proxy timeout and corrected replies.

## Validation and rollback

Use `yarn test`, `mvn test`, and controlled WebSocket interactions, then inspect Development logs. For rollback, stop the isolated relay compose and remove only its dedicated nginx virtual host; preserve MongoDB and both world-local SQLite databases. Inventory pack/unpack remains independent.
