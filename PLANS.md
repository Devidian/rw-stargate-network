# Stargate Network plan

2026-10-08: server-scoped address-book code migration is implemented and tested locally. The isolated Development relay has the updated code and reports healthy. The two-server network-code scenario passed player acceptance. Public 0.5.1 release was authorized as the dependency of OZ Stargate 0.6.0. Production deployment remains separate.

Phase 2 is implemented and deployed to the isolated Development stack. The root workspace tracks the cross-repository milestones in `../docs/active/stargate-network-plan.md`; this repository's focused checklist is `docs/active/phase-2.md`.

Phases 2–4 passed two-server player acceptance, including transfers, cancellation, return inventory, controlled source restart and non-admin command access. Prepare the requested public 0.1.0 release; the user supplied the Devidian GitHub repository. Relay exposure remains limited to the controlled test environment until server authentication is designed. A forced target game-process crash after claim remains unverified.

Both 0.1.0 releases are complete. Active work: phase 5A seven-chevron dialing and incoming priority; validate on the two designated test servers and wait for player acceptance before DHD/UI.

- 2026-09-27: default dial cadence increased to 3500ms after player feedback; exact timing
  regression added. Separate native acceptance with the plugin's moving-chevron refinement.

- 2026-09-27: default cadence corrected to 5000ms with additive optional progress stepMs hint; tests and isolated transfer smoke pass, native visual retest pending.
