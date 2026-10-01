// Isolated integration test: starts/restarts a relay process and removes only its unique test database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { MongoClient } = require('mongodb');
const WebSocket = require('ws');
const databaseName = `stargate_transfer_test_${randomUUID().replaceAll('-', '')}`;
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error('MONGODB_URI is required for the isolated transfer test');
const port = 47017;
const profile = { World_GameMode: 'Survival', World_OreAmount: 'Normal', Settings_BlueprintsRequireResources: 'True',
  Settings_GameMode: 'Survival', Settings_OreSmeltingDurationFactor: '1' };
const data = { inventory: 'AQID', clothes: 'BAUG', health: 90, hunger: 80, thirst: 70, stamina: 60 };
let relay;
let clients = [];

function startRelay() {
  return new Promise((resolve, reject) => {
    relay = spawn(process.execPath, ['dist/main.js'], { env: { ...process.env, PORT: String(port), DIAL_STEP_MS: "10", GATE_OPEN_MS: "1000", MONGODB_DATABASE: databaseName },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => reject(new Error('relay startup timeout')), 10000);
    relay.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(`relay exited ${code}`)); });
    relay.stderr.on('data', chunk => process.stderr.write(chunk));
    relay.stdout.on('data', chunk => { if (chunk.toString().includes('Stargate relay listening')) { clearTimeout(timeout); resolve(); } });
  });
}

async function stopRelay() {
  for (const client of clients) client.socket.terminate();
  clients = [];
  if (relay && relay.exitCode === null) await new Promise(resolve => { relay.once('exit', resolve); relay.kill('SIGKILL'); });
}

async function connect(serverId, override = 'transfer-smoke', travelEnabled = true) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [], waiters = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.predicate(value));
    if (index < 0) queue.push(value);
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timeout); waiter.resolve(value); }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const client = { socket, code: undefined, send(type, requestId, payload) {
    socket.send(JSON.stringify({ v: 1, type, requestId, networkCode: this.code, payload }));
  }, wait(predicate) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timeout: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('transfer response timeout'));
      }, 15000) };
      waiters.push(waiter);
    });
  }, async request(type, payload) {
    const id = randomUUID(); this.send(type, id, payload); return this.wait(value => value.requestId === id);
  } };
  clients.push(client);
  const ready = await client.request('initNetwork', { serverId, name: serverId, host: '127.0.0.1', port: 30001,
    dialSequenceVersion: 1, travelEnabled, world: profile, plugins: ['transfer-test'], forbiddenActions: { ChangeGameMode: true }, override });
  assert.equal(ready.type, 'networkReady'); client.code = ready.payload.networkCode;
  return client;
}

async function open(a, b, gateA, gateB) {
  await new Promise(resolve => setTimeout(resolve, 1200));
  const request = randomUUID();
  a.send('dialGate', request, { gateId: gateB, originGateId: gateA });
  const incoming = await b.wait(value => value.type === 'dialIn');
  b.send('gateFree', randomUUID(), { gateId: gateB, dialId: incoming.payload.dialId });
  await a.wait(value => value.type === 'gateState' && value.payload.gateId === gateA
    && value.payload.connectionId === incoming.payload.dialId && value.payload.state === 'OPEN');
  const early = await a.request('transferStart', { transferId: randomUUID(), uid: 'too-early',
    sourceGateId: gateA, targetGateId: gateB, data });
  assert.equal(early.payload.code, 'gate_not_open');
  assert.equal((await a.wait(value => value.requestId === request && value.type !== 'dialProgress')).type, 'gateFree');
}

async function prepare(a, b, gateA, gateB, uid) {
  await open(a, b, gateA, gateB);
  const id = randomUUID();
  const queued = await a.request('transferStart', { transferId: id, uid, sourceGateId: gateA, targetGateId: gateB, data });
  assert.equal(queued.type, 'transferQueued');
  assert.equal((await b.wait(value => value.type === 'incomingTransfer' && value.payload.transferId === id)).payload.data.inventory, data.inventory);
  return id;
}

async function acceptAndRelease(a, b, id) {
  assert.equal((await b.request('transferAccepted', { transferId: id })).type, 'transferAcceptedAck');
  await a.wait(value => value.type === 'transferAccepted' && value.payload.transferId === id);
  a.send('transferReleased', randomUUID(), { transferId: id });
  assert.equal((await a.wait(value => value.type === 'transferReleased' && value.payload.transferId === id)).payload.state, 'RELEASED');
}

async function run() {
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  try {
    await startRelay();
    let a = await connect('source'), b = await connect('target');
    const gateA = (await a.request('registerGate', {})).payload.gateId;
    const gateB = (await b.request('registerGate', {})).payload.gateId;
    assert.match(gateA, /^[0-9A-F]{16}$/);
    const localOnly = await connect('local-only', 'transfer-smoke', false);
    const localGate = (await localOnly.request('registerGate', {})).payload.gateId;
    assert.match(localGate, /^[0-9A-F]{16}$/);
    assert.equal((await localOnly.request('getAddressList', {})).payload.code, 'network_disabled');
    assert.equal((await localOnly.request('dialGate', { gateId: gateB, originGateId: localGate })).payload.code, 'network_disabled');
    const visible = await a.request('getAddressList', {});
    assert.equal(visible.payload.gates.some(gate => gate.gateId === localGate), false);
    const disabledRequest = randomUUID();
    a.send('dialGate', disabledRequest, { gateId: localGate, originGateId: gateA });
    const disabledDial = await a.wait(value => value.requestId === disabledRequest && value.type === 'dialFail');
    assert.equal(disabledDial.payload.reason, 'gate_offline');
    // Wire-level priority: start the reverse dial after two source chevrons.
    a.send('dialGate', 'priority-a', { gateId: gateB, originGateId: gateA });
    await a.wait(value => value.requestId === 'priority-a' && value.type === 'dialProgress' && value.payload.chevron === 2);
    const early = await a.request('transferStart', { transferId: randomUUID(), uid: 'too-early', sourceGateId: gateA, targetGateId: gateB, data });
    assert.equal(early.payload.code, 'gate_not_open');
    b.send('dialGate', 'priority-b', { gateId: gateA, originGateId: gateB });
    assert.equal((await b.wait(value => value.requestId === 'priority-b' && value.type === 'dialFail')).payload.reason, 'incoming_priority');
    const priorityIncoming = await b.wait(value => value.type === 'dialIn');
    b.send('gateFree', randomUUID(), { gateId: gateB, dialId: priorityIncoming.payload.dialId });
    assert.equal((await a.wait(value => value.requestId === 'priority-a' && value.type === 'gateFree')).type, 'gateFree');
    const first = await prepare(a, b, gateA, gateB, 'traveller-1');
    assert.equal((await b.request('transferClaim', { transferId: first })).payload.code, 'transfer_not_claimable');
    assert.equal((await a.request('transferClaim', { transferId: first })).payload.code, 'transfer_not_found');
    await acceptAndRelease(a, b, first);
    assert.equal((await b.request('transferClaim', { transferId: first })).payload.state, 'CLAIMED');
    // A crash after claim cannot permit the origin to restore its inventory.
    await stopRelay(); await startRelay();
    a = await connect('source'); b = await connect('target');
    assert.equal((await b.request('transferStatus', { transferId: first })).payload.state, 'CLAIMED');
    assert.equal((await a.request('transferAbort', { transferId: first })).payload.code, 'transfer_already_claimed');
    assert.equal((await b.request('transferDone', { transferId: first })).type, 'transferDoneAck');
    assert.equal((await a.wait(value => value.type === 'transferDone' && value.payload.transferId === first)).payload.state, 'DONE');
    assert.equal((await b.request('transferDone', { transferId: first })).payload.state, 'DONE');
    assert.equal((await a.request('transferStart', { transferId: first, uid: 'traveller-1', sourceGateId: gateA, targetGateId: gateB, data })).payload.state, 'DONE');

    const returning = await prepare(b, a, gateB, gateA, 'traveller-1');
    await acceptAndRelease(b, a, returning);
    assert.equal((await a.request('transferClaim', { transferId: returning })).payload.state, 'CLAIMED');
    assert.equal((await a.request('transferDone', { transferId: returning })).payload.state, 'DONE');
    await b.wait(value => value.type === 'transferDone' && value.payload.transferId === returning);

    const second = await prepare(a, b, gateA, gateB, 'traveller-1');
    await acceptAndRelease(a, b, second);
    assert.equal((await a.request('transferAbort', { transferId: second })).payload.state, 'ABORTED');
    assert.equal((await b.request('transferClaim', { transferId: second })).payload.code, 'transfer_not_claimable');
    assert.equal((await a.request('transferAbort', { transferId: second })).payload.state, 'ABORTED');

    // Declining a native confirmation must allow the same player to retry the
    // SAME open wormhole, without another dial and without extending its expiry.
    const retry = randomUUID();
    const retryPayload = { transferId: retry, uid: 'traveller-1', sourceGateId: gateA, targetGateId: gateB, data };
    assert.equal((await a.request('transferStart', retryPayload)).type, 'transferQueued');
    await b.wait(value => value.type === 'incomingTransfer' && value.payload.transferId === retry);
    assert.equal((await a.request('transferStart', { ...retryPayload, transferId: randomUUID() })).payload.code, 'player_transfer_active');
    await acceptAndRelease(a, b, retry);
    assert.equal((await a.request('transferAbort', { transferId: retry })).payload.state, 'ABORTED');
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await a.request('transferStart', { ...retryPayload, transferId: randomUUID() })).payload.code, 'gate_not_open');

    const third = await prepare(a, b, gateA, gateB, 'traveller-1');
    await stopRelay(); await startRelay();
    a = await connect('source'); b = await connect('target');
    assert.equal((await b.wait(value => value.type === 'incomingTransfer' && value.payload.transferId === third)).payload.state, 'PENDING');
    await open(a, b, gateA, gateB);
    assert.equal((await a.request('transferStart', { transferId: randomUUID(), uid: 'traveller-1', sourceGateId: gateA, targetGateId: gateB, data })).payload.code, 'player_transfer_active');
    await mongo.db(databaseName).collection('transfers').updateOne({ transferId: third }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await a.wait(value => value.type === 'transferFailed' && value.payload.transferId === third)).payload.state, 'ABORTED');
    assert.equal((await b.request('transferClaim', { transferId: third })).payload.code, 'transfer_not_claimable');
    const foreign = await connect('foreign', 'other-network');
    assert.equal((await foreign.request('transferStatus', { transferId: first })).payload.code, 'transfer_not_found');
    console.log('Stargate transfer integration passed: dial priority, early warp denial, claim, crash/restart, pending replay, duplicate completion, return, abort/retry through same window, window expiry, ownership and single active transfer');
  } finally {
    await stopRelay();
    await mongo.db(databaseName).dropDatabase();
    await mongo.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
