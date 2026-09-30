# Phase 5A: dialing and incoming priority

## Objective and ownership

Relay owns the per-gate state machine and conflict arbitration. Plugin displays localized progress and consumes correlated state; future DHD/UI and area triggers use the same states. No Tools change or new dependency. No public release in this milestone.

## Lore and gameplay decisions

- Seven steps for the first Milky Way-style sequence. DHD dialing differs from the slower SGC dialing computer; 2 seconds per chevron is a gameplay default, not a canon duration.
- Incoming connections override an unfinished outgoing sequence. Once a source/target pair is reserved for the final handshake, other dials cannot replace it. Simultaneous completions resolve in relay event-loop order; an invalidated asynchronous lookup must never resurrect a cancelled attempt.
- Failed lookup/offline/busy target produces no OPEN state. Inventory remains untouched until the existing warp transfer flow starts after OPEN.
- IDLE -> OUTGOING (seven chevrons) -> final handshake; receiver INCOMING -> both OPEN with direction. Expiry/disconnect -> IDLE. Final handshake has a 10-second deadline; OPEN lasts 60 seconds. Incoming priority discards the old sequence; no automatic restart.
- Existing opaque gate IDs remain unchanged. Glyph addresses, gate-model differences, sound and animations are separate future work.

Sources: [SG-1 1.20 transcript](https://stargate-sg1-solutions.com/wiki/1.20_%22There_But_For_The_Grace_Of_God%22_Transcript), [DHD lexicon](https://rdanderson.com/stargate/lexicon/entries/dhd.htm). The script explicitly links the seventh lock with preventing an incoming wormhole. No claim of a universal per-chevron timing.

## Compatibility and rollback

Protocol v1 gains dialSequenceVersion=1 capability in initNetwork/networkReady and dialProgress/gateState events. Upgraded relay rejects dialing involving legacy peers; upgraded plugin refuses dialing with an old relay. Existing transfer reconciliation remains available during upgrade. No database schema changes. Upgrade relay and both designated test plugins together with no active transfers. Rollback both components together, preserving all databases; runtime gate state is ephemeral and clears on reconnect.

## Validation

- [x] Deterministic state-machine tests: delayed open, failure, busy gates, crossed dials, incoming priority, late lookup/reply, timeout, disconnect, expiry and independent gates.
- [x] Existing protocol/transfer integration tests and plugin Maven tests/package (five SQLite tests).
- [x] Scoped relay/plugin test deployment and reload/network-ready evidence; real TLS gate smoke passed.
- [ ] Native player test of progress, early warp denial, success/failure, preemption and gate reuse.

Relay DIAL_STEP_MS defaults to 2000 (10–5000); GATE_OPEN_MS defaults to 60000 (10–60000). Short values are for isolated tests only. Transfer expiry stays independent at 60 seconds.

## Phase 5C acceptance fix: travel retry

Player reported that declining travel, leaving and re-entering the passage zone produced gate_not_open while the wormhole remained OPEN. transferStart deleted the relay's window after queuing the first transfer, contradicting the coordinator's gate state. A wormhole now retains its travel window until coordinator expiry/disconnect. Per-player active-transfer uniqueness and transfer IDs continue to enforce custody safety; no gate lifetime extension, schema or protocol change.

Regression coverage in scripts/transfer-smoke.js: abort RELEASED transfer, start the same player again through the same open window without redialing, deny concurrent second transfer, abort retry, then deny a new attempt after the original window expires. Validate in an isolated UUID-named Mongo database before updating the test relay. Game plugin artifacts do not change.

Validation complete: local yarn test and Docker build tests pass. Updated isolated transfer smoke fails at the retry against the previous image and passes against the corrected image. Test relay activated with no active transfers; health HTTP 200 and both game servers reconnected. Native retry accepted by the player on 2026-09-27. No schema migration or plugin update.

## Cadence refinement — 2026-09-27

Following player feedback, the default DIAL_STEP_MS is now 3500 (previously 2000).
Seven steps nominally take 24.5 seconds. Existing explicit overrides, incoming priority,
10-second lookup/reply budgets and 60-second open duration are retained. The plugin's
60-second dial request deadline still covers the default sequence plus lookup/reply.
Regression checks include exact default step boundaries and no early target contact.
No protocol/database migration; rollback uses the previous image/default or an explicit
DIAL_STEP_MS=2000 override. Native player timing acceptance remains pending.

## V-stroke correction — 2026-09-27

Default cadence is now 5000ms/symbol (35s nominal) to accommodate visible acceleration,
braking, pause and a complete inward/return stroke. `dialProgress.payload.stepMs` is an
additive optional duration hint, bounded by existing DIAL_STEP_MS validation (1..5000).
Old plugins ignore it; current plugin uses 3500ms fallback with old relays. No v1 envelope,
state/transfer semantics or persistence change. Tests assert the default deadline boundaries
and emitted hint. The 60s plugin request timeout still covers the default + lookup/reply budgets.
