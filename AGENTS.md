# OZ Stargate Network

This standalone repository owns the experimental WebSocket relay and MongoDB gate/transfer registry. Keep Rising World PluginAPI calls and inventory application in `rw-plugin-oz-stargate`; this relay persists bounded opaque transfer payloads and coordinates durable transfer states. Preserve the versioned protocol, owner checks, correlation IDs, deadline behavior, and separate MongoDB state. Never automatically abort a claimed transfer. Validate with `yarn test`, the isolated `scripts/transfer-smoke.js`, and a two-server Development player test. Do not deploy to production game servers.

## CodeMap

For unfamiliar modules and cross-repository impact, start at [the local CodeMap](.codemap/README.md) and use the [CodeMap skill](.agents/skills/codemap/SKILL.md). Verify relevant source and update and validate affected entries when indexed information changes.
