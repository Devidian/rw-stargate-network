const assert = require('node:assert/strict');
const { StargateRelay } = require('../dist/main.js');

function matches(row, filter) {
  return Object.entries(filter).every(([key, wanted]) => {
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      if ('$in' in wanted) return wanted.$in.includes(row[key]);
      if ('$ne' in wanted) return row[key] !== wanted.$ne;
    }
    return row[key] === wanted;
  });
}

class Collection {
  constructor(rows = []) { this.rows = rows; }
  async findOne(filter) { return this.rows.find(row => matches(row, filter)) ?? null; }
  find(filter) {
    const rows = this.rows.filter(row => matches(row, filter));
    const cursor = { toArray: async () => rows, limit: () => cursor, sort: () => cursor };
    return cursor;
  }
  async updateOne(filter, change, options = {}) {
    let row = this.rows.find(value => matches(value, filter));
    if (!row && options.upsert) {
      row = { ...filter, ...change.$setOnInsert };
      this.rows.push(row);
    }
    if (row && change.$set) Object.assign(row, change.$set);
    return { matchedCount: row ? 1 : 0 };
  }
  async updateMany(filter, change) {
    for (const row of this.rows.filter(value => matches(value, filter))) Object.assign(row, change.$set);
  }
  async deleteMany(filter) { this.rows = this.rows.filter(row => !matches(row, filter)); }
}

const profile = { World_GameMode: 'Survival', World_OreAmount: 'Normal', Settings_BlueprintsRequireResources: 'True',
  Settings_GameMode: 'Survival', Settings_OreSmeltingDurationFactor: '1' };
const servers = new Collection();
const gates = new Collection([
  { gateId: 'AAAAAAAAAAAAAAAA', serverId: 'A', networkCode: 'OLD', address: '1111111111111111' },
  { gateId: 'BBBBBBBBBBBBBBBB', serverId: 'B', networkCode: 'OLD', address: '2222222222222222' }
]);
const books = new Collection([
  { networkCode: 'OLD', uid: 'alice', gateId: 'AAAAAAAAAAAAAAAA', learnedAt: new Date(1) },
  { networkCode: 'OLD', uid: 'alice', gateId: 'BBBBBBBBBBBBBBBB', learnedAt: new Date(2) }
]);
const relay = new StargateRelay(servers, gates, new Collection(), new Collection(), books);
const socket = { readyState: 1, send: () => {} };
async function register(serverId, override) {
  await relay.initNetwork(socket, { requestId: serverId, payload: { serverId, name: serverId,
    host: '127.0.0.1', port: 30001, world: profile, plugins: [], override } });
}

(async () => {
  await register('B', 'OLD');
  await register('B', 'NEW');
  await register('B', 'NEW');
  assert.equal(gates.rows.find(row => row.serverId === 'A').networkCode, 'OLD');
  assert.equal(gates.rows.find(row => row.serverId === 'B').networkCode, 'NEW');
  assert.deepEqual(books.rows.map(row => [row.networkCode, row.gateId]).sort(), [
    ['NEW', 'BBBBBBBBBBBBBBBB'], ['OLD', 'AAAAAAAAAAAAAAAA']
  ]);
  gates.rows.push({ gateId: 'CCCCCCCCCCCCCCCC', serverId: 'C', networkCode: 'THIRD', address: '1111111111111111' });
  await register('C', 'THIRD');
  await assert.rejects(register('C', 'OLD'), /network_address_collision/);
  assert.equal(gates.rows.find(row => row.serverId === 'C').networkCode, 'THIRD');
  console.log('Stargate address book code migration passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
