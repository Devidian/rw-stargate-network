const assert = require('node:assert/strict');
const { TransferStateStore } = require('../dist/transfer-state.js');

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[key]);
    if (value && typeof value === 'object' && '$lte' in value) return row[key] <= value.$lte;
    return row[key] === value;
  });
}

class Transfers {
  constructor(row) { this.row = row; }
  async findOne(filter) {
    return matches(this.row, filter) ? { ...this.row } : null;
  }
  find(filter) {
    return { limit: () => ({ toArray: async () => matches(this.row, filter) ? [{ ...this.row }] : [] }) };
  }
  async updateOne(filter, update) {
    if (!matches(this.row, filter)) return { modifiedCount: 0 };
    Object.assign(this.row, update.$set);
    return { modifiedCount: 1 };
  }
}

function record(state = 'PENDING', expired = false) {
  const now = new Date();
  return { transferId: 'transfer-1', uid: 'player', networkCode: 'network',
    sourceServerId: 'source', targetServerId: 'target', sourceGateId: 'a', targetGateId: 'b',
    state, payload: { inventory: 'AQID' }, createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)) };
}

async function main() {
  const transfers = new Transfers(record());
  const state = new TransferStateStore(transfers);
  await assert.rejects(state.accept('transfer-1', 'source', 'network'), /transfer_not_found/);
  await assert.rejects(state.accept('transfer-1', 'target', 'other'), /transfer_not_found/);
  assert.equal((await state.accept('transfer-1', 'target', 'network')).state, 'ACCEPTED');
  assert.equal((await state.accept('transfer-1', 'target', 'network')).state, 'ACCEPTED');
  await assert.rejects(state.release('transfer-1', 'target', 'network'), /transfer_not_found/);
  assert.equal((await state.release('transfer-1', 'source', 'network')).state, 'RELEASED');
  assert.equal((await state.claim('transfer-1', 'target', 'network')).state, 'CLAIMED');
  await assert.rejects(state.abort('transfer-1', 'source', 'network', false), /transfer_already_claimed/);
  assert.equal((await state.complete('transfer-1', 'target', 'network')).state, 'DONE');
  assert.deepEqual(transfers.row.payload, {});
  assert.equal((await state.complete('transfer-1', 'target', 'network')).state, 'DONE');

  const expired = new TransferStateStore(new Transfers(record('PENDING', true)));
  await assert.rejects(expired.accept('transfer-1', 'target', 'network'), /transfer_expired/);

  const interrupted = new Transfers(record('RELEASED'));
  const interruptedState = new TransferStateStore(interrupted);
  await assert.rejects(interruptedState.abort('transfer-1', 'source', 'network', true), /transfer_not_found/);
  assert.equal((await interruptedState.abort('transfer-1', 'target', 'network', true)).state, 'ABORTED');
  assert.deepEqual(interrupted.row.payload, {});
  await assert.rejects(interruptedState.claim('transfer-1', 'target', 'network'), /transfer_not_claimable/);

  // Simulate an abort winning the conditional write between claim read and update.
  const raced = new Transfers(record('RELEASED'));
  const update = raced.updateOne.bind(raced);
  raced.updateOne = async (filter, patch) => {
    raced.row.state = 'ABORTED';
    return update(filter, patch);
  };
  await assert.rejects(new TransferStateStore(raced).claim('transfer-1', 'target', 'network'), /transfer_not_claimable/);
  assert.equal(raced.row.state, 'ABORTED');
  const expiryRows = new Transfers(record('PENDING', true));
  const expiredResults = [];
  for await (const result of new TransferStateStore(expiryRows).expire()) expiredResults.push(result.state);
  assert.deepEqual(expiredResults, ['ABORTED']);
  assert.deepEqual(expiryRows.row.payload, {});
  const claimedRows = new Transfers(record('CLAIMED', true));
  for await (const result of new TransferStateStore(claimedRows).expire()) assert.fail(result.state);
  assert.equal(claimedRows.row.state, 'CLAIMED');

  const expiryRace = new Transfers(record('RELEASED', true));
  const expiryUpdate = expiryRace.updateOne.bind(expiryRace);
  expiryRace.updateOne = async (filter, patch) => {
    expiryRace.row.state = 'CLAIMED';
    return expiryUpdate(filter, patch);
  };
  for await (const result of new TransferStateStore(expiryRace).expire()) assert.fail(result.state);
  assert.equal(expiryRace.row.state, 'CLAIMED');

  console.log('Transfer state smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
