const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const url = process.env.STARGATE_WS_URL || 'ws://127.0.0.1:47016/ws';
const profile = {
  World_GameMode: 'Survival', World_OreAmount: 'Normal', Settings_BlueprintsRequireResources: 'True',
  Settings_GameMode: 'Survival', Settings_OreSmeltingDurationFactor: '1'
};
function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue = [];
    const waiters = [];
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const waiter = waiters.find(item => item.predicate(message));
      if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timeout); waiter.resolve(message); }
      else queue.push(message);
    });
    socket.once('open', () => resolve({ socket, wait(predicate) {
      const existing = queue.find(predicate);
      if (existing) { queue.splice(queue.indexOf(existing), 1); return Promise.resolve(existing); }
      return new Promise((done, fail) => {
        const waiter = { predicate, resolve: done, timeout: setTimeout(() => fail(new Error('response timeout')), 5000) };
        waiters.push(waiter);
      });
    }, send(type, requestId, networkCode, payload) {
      socket.send(JSON.stringify({ v: 1, type, requestId, networkCode, payload }));
    } }));
    socket.once('error', reject);
  });
}
async function run() {
  const unique = randomUUID();
  const a = await connect();
  const b = await connect();
  let gateA, gateB;
  try {
    for (const [client, suffix, port] of [[a, 'a', 30001], [b, 'b', 30002]]) {
      const id = `init-${suffix}`;
      client.send('initNetwork', id, undefined, { serverId: `smoke-${unique}-${suffix}`, name: `Smoke ${suffix}`,
        host: '127.0.0.1', port, world: profile, plugins: ['OZ - Tools:0.26.2', 'OZ - Stargate:0.0.1'],
        forbiddenActions: { ChangeGameMode: true } });
      const reply = await client.wait(msg => msg.requestId === id);
      assert.equal(reply.type, 'networkReady');
      client.code = reply.payload.networkCode;
    }
    assert.equal(a.code, b.code);
    a.send('updatePlayer', 'player-a', a.code, { uid: `smoke-player-${unique}`, name: 'Smoke Player',
      playTimeSeconds: 120, permissionGroup: 'Test' });
    assert.equal((await a.wait(msg => msg.requestId === 'player-a')).type, 'playerUpdated');
    b.send('playerTrust', 'trust-b', b.code, { uid: `smoke-player-${unique}` });
    const trust = await b.wait(msg => msg.requestId === 'trust-b');
    assert.equal(trust.type, 'playerTrust');
    assert.equal(trust.payload.observations.length, 1);
    assert.equal(trust.payload.observations[0].playTimeSeconds, 120);
    b.send('updatePlayer', 'player-b', b.code, { uid: `smoke-player-${unique}`, name: 'Smoke Player',
      playTimeSeconds: 5 });
    assert.equal((await b.wait(msg => msg.requestId === 'player-b')).type, 'playerUpdated');
    a.send('playerTrust', 'trust-a', a.code, { uid: `smoke-player-${unique}` });
    const trustBoth = await a.wait(msg => msg.requestId === 'trust-a');
    assert.equal(trustBoth.payload.observations.length, 2);
    assert.equal(trustBoth.payload.observations.find(row => row.serverId.endsWith('-b')).permissionGroup, null);
    for (const [client, id] of [[a, 'reg-a'], [b, 'reg-b']]) {
      client.send('registerGate', id, client.code, {});
      const reply = await client.wait(msg => msg.requestId === id);
      assert.equal(reply.type, 'gateRegistered');
      if (client === a) gateA = reply.payload.gateId; else gateB = reply.payload.gateId;
    }
    a.send('getAddressList', 'list', a.code, {});
    const list = await a.wait(msg => msg.requestId === 'list');
    assert.deepEqual(new Set(list.payload.gates.map(row => row.gateId)), new Set([gateA, gateB]));
    a.send('dialGate', 'dial-free', a.code, { gateId: gateB, originGateId: gateA });
    const incoming = await b.wait(msg => msg.type === 'dialIn');
    b.send('gateFree', 'free-answer', b.code, { gateId: gateB, dialId: incoming.payload.dialId });
    const free = await a.wait(msg => msg.requestId === 'dial-free');
    assert.equal(free.type, 'gateFree');
    assert.equal(free.payload.port, 30002);
    a.send('dialGate', 'dial-blocked', a.code, { gateId: gateB, originGateId: gateA });
    const blockedIncoming = await b.wait(msg => msg.type === 'dialIn');
    b.send('gateBlocked', 'blocked-answer', b.code, { gateId: gateB, dialId: blockedIncoming.payload.dialId });
    assert.equal((await a.wait(msg => msg.requestId === 'dial-blocked')).type, 'gateBlocked');
    a.send('dialGate', 'same-server', a.code, { gateId: gateA, originGateId: gateA });
    assert.equal((await a.wait(msg => msg.requestId === 'same-server')).payload.reason, 'same_server');
    a.send('unregisterGate', 'bad-owner', a.code, { gateId: gateB });
    assert.equal((await a.wait(msg => msg.requestId === 'bad-owner')).payload.code, 'gate_not_owned_or_missing');
    console.log('Stargate relay integration smoke passed');
  } finally {
    if (gateA) a.send('unregisterGate', 'cleanup-a', a.code, { gateId: gateA });
    if (gateB) b.send('unregisterGate', 'cleanup-b', b.code, { gateId: gateB });
    await new Promise(resolve => setTimeout(resolve, 200));
    a.socket.close(); b.socket.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
