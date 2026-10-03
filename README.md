# OZ Stargate Network

WebSocket/MongoDB relay for OZ Stargate. Requires Node 24, Yarn 4.15, and MongoDB. Its HTTP `/health` endpoint and WebSocket `/ws` endpoint listen on port 47016 by default.

When a plugin has no configured advertised host, it sends `resolveHost` before
`initNetwork`. The relay replies with the public IPv4 from the proxy's
`X-Real-IP` header. The TLS proxy must overwrite this header with its actual
client address. For game servers on the relay's own Docker network, set
`LOCAL_GAME_PUBLIC_IP` to their shared public host IP; this fallback applies
only to clients seen on `172.20.0.0/16`. If neither yields a public IPv4, the
plugin asks the admin to enter a reachable host manually. The resolved address
is routing information, not proof that the game port is reachable.

Each server identifies itself by a stable UUID derived from its configured `relay.advertisedHost`, game port, and world name; the game API server UID was not ready at plugin startup. `initNetwork` computes a deterministic 24-character SHA-256 prefix from five world settings, the sorted plugin name/version list, and sorted `forbiddenActions` boolean flags. An optional `networkCode.override` groups servers manually. The returned `networkCode.trusted` is recorded by the plugin. Servers may connect without an IP allowlist and join the network selected by the computed or overridden code. This code is routing metadata, **not authentication**. A client can forge a server ID, network code, gate or player event; public relay access does not establish trust in a peer. Server identity and abuse protection remain future work.

Protocol v1 uses JSON envelopes: `{ "v": 1, "type": "...", "requestId": "...", "networkCode": "...", "payload": {} }`. `initNetwork` omits `networkCode`; subsequent client events include the relay-returned code. Replies carry the same `requestId`, except `dialIn`, which uses a relay-generated `dialId`. Commands: `initNetwork` → `networkReady`; `registerGate` → `gateRegistered`; `unregisterGate` → `gateUnregistered`; `getAddressList` → `addressList`; `dialGate` → `dialFail` or a `dialIn` to the target; target `gateBlocked` or `gateFree` → origin response. Phase 3A adds `updatePlayer` → `playerUpdated` and `playerTrust` → `playerTrust`. Player records contain UID, name, world play time, permission group, server ID, and update time; they do not transfer player data or assign a trust score. The target has ten seconds to answer a dial. The relay sends WebSocket ping frames every 30 seconds to keep idle proxy connections alive. Gates are visible only while their owner server is connected. Server, gate, and player-observation data survive relay restarts in MongoDB; online state is reset on startup.

The discovery address book uses `syncAddressBook` with `{uid,pending:[gateId...]}`
and replies `addressBook` with the complete known ID list for that network and
UID. Learning is idempotent and only existing gates are accepted. The MongoDB
`address_books` collection has a unique `(networkCode,uid,gateId)` index.
Unregistering a gate deletes every matching book entry and sends
`addressRemoved` to connected servers. A reconnecting plugin submits pending
discoveries before replacing its local cache with the relay snapshot. The
legacy `getAddressList` command remains for older clients; new plugin UI and
player commands use only discovered addresses.

Run `yarn install && yarn test`, then set `MONGODB_URI` and `yarn start`. `docker-compose.example.yml` illustrates an isolated MongoDB and a loopback-only port for a TLS proxy. `examples/nginx-ws.conf` shows the public WebSocket location and the required proxy-owned `X-Real-IP` header. Expose only `/ws` through TLS. The endpoint may accept arbitrary server IPs, but the experimental protocol must not be presented as an authenticated or trusted transfer service.

Phase 3B uses `transferStart`, target `transferAccepted`, source `transferReleased`, target `transferClaim`, and `transferDone`. Persisted states are `PENDING → ACCEPTED → RELEASED → CLAIMED → DONE`; only the first three states may become `ABORTED`. A unique partial index prevents multiple active transfers for the same network/player. The relay accepts a transfer only through an unexpired dial window. Its one-minute transfer deadline can abort unclaimed transfers; a claimed transfer remains blocked until target completion. `transferStatus` and reconnect replay reconcile durable state. Terminal records retain metadata while their binary payload is removed. Messages are bounded at 1 MiB and inventory/clothes base64 fields at 650,000 characters each.

With a test MongoDB reachable through `MONGODB_URI`, run `node scripts/transfer-smoke.js`. It creates a unique temporary database, starts and force-restarts a child relay, validates transfer ownership, release/claim, abort, expiry, return direction and idempotent completion, and drops only that test database afterward.

## Docker release

Use `devidian/rw-stargate-network:0.4.1` with the example Compose file. Copy the example to your own deployment directory and run `docker compose -f docker-compose.example.yml up -d`. Keep MongoDB on the private Compose network and persist its volume. The hosted `/ws` proxy was opened to arbitrary client IPs on 2026-10-03; installing this image alone does not configure a public proxy.

Back up MongoDB and every participating plugin/player database before upgrades. Stop new travel and resolve active transfers before rollback. Do not downgrade one side while transfers are in flight. Protocol v1 and the initial schemas are unchanged by the 0.1.0 packaging release.

## Development: phase 5A dialing

See [dialing design and validation](docs/active/phase-5-dialing.md). The relay owns IDLE/OUTGOING/INCOMING/OPEN state, seven-chevron progress, incoming priority and connection expiry. Protocol v1 adds dialSequenceVersion=1 negotiation, dialProgress and gateState. Legacy clients cannot initiate or receive a new dial; existing transfer reconciliation is unchanged. Default DIAL_STEP_MS=7000 and GATE_OPEN_MS=60000; shorter values are for isolated tests. The target reply deadline remains 10 seconds; a successful reply opens the source gate immediately, then opens the target and permits travel after seven incoming chevrons at 400 ms each (2800 ms total).

An open wormhole supports further trips until its original expiry or disconnect. Starting or declining one transfer does not consume that gate window. The unique active-transfer guard still allows only one outstanding trip per network/player; retries do not extend the wormhole lifetime.

Dial progress includes optional `stepMs` for cosmetic client synchronization; older clients ignore it. Default seven-step duration is nominally 49 seconds, allowing the DHD, ring and chevron reference clips to play in sequence.
