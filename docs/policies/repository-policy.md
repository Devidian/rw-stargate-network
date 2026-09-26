# Repository policy

This repository owns the Stargate WebSocket relay, protocol, MongoDB server/gate registry, and deployment examples. It does not own Rising World PluginAPI interactions, local gate coordinates, inventory custody, or player UI; those belong in `rw-plugin-oz-stargate`. Keep changes backward compatible within protocol version 1 or bump the protocol version with a documented migration. Validate with `yarn test` and the two-client TLS integration smoke before deployment. Do not store real credentials or server-local configuration in Git.
