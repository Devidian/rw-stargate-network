import assert from 'node:assert/strict';
import { canonicalCode, parseMessage } from './protocol.js';

const world = {
  World_GameMode: 'Survival', World_OreAmount: 'Normal', Settings_BlueprintsRequireResources: 'True',
  Settings_GameMode: 'Survival', Settings_OreSmeltingDurationFactor: '1'
};
const one = canonicalCode(world, ['OZ - Stargate:0.0.1', 'OZ - Tools:0.26.2']);
const two = canonicalCode({ ...world }, ['OZ - Tools:0.26.2', 'OZ - Stargate:0.0.1']);
assert.equal(one, two, 'plugin order must not affect the network code');
assert.notEqual(one, canonicalCode({ ...world, World_GameMode: 'Creative' }, ['OZ - Tools:0.26.2', 'OZ - Stargate:0.0.1']));
assert.notEqual(canonicalCode(world, ['OZ - Tools:0.26.2'], { ChangeGameMode: true }),
  canonicalCode(world, ['OZ - Tools:0.26.2'], { ChangeGameMode: false }));
assert.throws(() => canonicalCode(world, [], { ChangeGameMode: 'yes' } as unknown as Record<string, boolean>),
  /invalid_forbidden_action/);
assert.deepEqual(parseMessage(JSON.stringify({ v: 1, type: 'getAddressList', requestId: 'a1', payload: {} })),
  { v: 1, type: 'getAddressList', requestId: 'a1', networkCode: undefined, payload: {} });
assert.throws(() => parseMessage(JSON.stringify({ v: 2, type: 'getAddressList', requestId: 'a1', payload: {} })), /unsupported_version/);
assert.throws(() => parseMessage(JSON.stringify({ v: 1, type: 'getAddressList', requestId: 'a1', payload: [] })), /invalid_payload/);
console.log('Stargate protocol smoke passed');
