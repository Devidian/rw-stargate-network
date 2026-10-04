# History

## 0.5.0 — 2026-10-04

- Store an optional alias and both local and network addresses for each gate. Return these details with the personal address book so DHD labels can follow each player's preference.
- Accept owner-checked alias and legacy-local-address updates. Newly registered `LOCAL` gates receive a separate globally dialable network address while retaining their local identity.
- Resolve a dialed network address to its internal gate identity. Keep protocol v1 and existing gate and transfer records compatible.

## 0.4.1 — 2026-10-03

- Document automatic relay access for game servers with arbitrary public IPs. The hosted TLS proxy no longer restricts `/ws` by client IP; network grouping still uses the computed or overridden code.
- Ship a public nginx WebSocket proxy example with the release. Network codes remain routing metadata rather than authentication.

## 0.4.0 — 2026-10-03

- Persist discovered gate addresses per network and player in the indexed MongoDB `address_books` collection. Repeated learning is idempotent; gate deletion removes addresses and notifies connected servers.
- Resolve an unconfigured game host from the proxy-observed address, with an explicit local Docker fallback. Keep the supplied proxy header and network code as routing information, not authentication.
- Preserve protocol v1 and existing gate and transfer records. Existing address books start empty.

## 0.3.0 — 2026-10-01

- Extend the default seven-chevron outgoing cadence to seven seconds per lock for consecutive DHD, ring and chevron cues.
- Open the source gate visually after target acceptance, activate the target's seven chevrons over 2.8 seconds, and create the travel window only when the target opens.
- Keep the accepted connection reserved through its complete incoming animation, even when target acceptance arrives near the reply deadline. Preserve the 60-second travel window and transfer recovery protocol.

## 0.1.0 — 2026-09-26

- First standalone Node 24 / MongoDB relay for OZ Stargate protocol v1.
- Deterministic world/plugin network grouping, persistent gate ownership, discovery, incoming dial reservation and WebSocket heartbeats.
- Persistent player observations and durable release/claim transfer coordination, expiry before claim, reconnect replay and idempotent completion.
- Isolated integration coverage for relay restart, duplicate completion, cancellation, expiry, ownership and return direction.
- Publish versioned Docker images and a GitHub release; operate only behind restricted access for trusted game servers.
