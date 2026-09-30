import assert from 'node:assert/strict';
import { DialCoordinator, type DialPeer } from './dial-coordinator.js';

type Event = { peer: string; type: string; id: string; p: Record<string, unknown> };
const a: DialPeer = { serverId: 'a', networkCode: 'test', host: 'localhost', port: 1, dialSequenceVersion: 1 };
const b: DialPeer = { ...a, serverId: 'b', port: 2 };
const c: DialPeer = { ...a, serverId: 'c', port: 3 };
function fixture() {
  let time = 0, opens = 0, closes = 0;
  const events: Event[] = [];
  const peers: Record<string, DialPeer> = { A: a, B: b, C: c, A2: a, B2: b };
  const coordinator = new DialCoordinator<DialPeer>(async (source, gate) => {
    const peer = peers[gate];
    return !peer ? { reason: 'gate_unavailable' } : peer === source ? { reason: 'same_server' } : { peer };
  }, (peer, type, id, p) => events.push({ peer: peer.serverId, type, id, p }),
  () => opens++, () => closes++, 2000, 60000, 10000, () => time);
  return { coordinator, events, get opens() { return opens; }, get closes() { return closes; },
    advance(ms: number) { time += ms; return coordinator.tick(time); },
    async steps(count = 7) { for (let i = 0; i < count; i++) await this.advance(2000); },
    incoming(gate = 'B') { return [...events].reverse().find(e => e.type === 'dialIn' && e.p.gateId === gate)!; } };
}

async function run() {
  { // Default cadence: no target contact before all seven 5-second steps.
    const events: Event[] = [];
    const dial = new DialCoordinator<DialPeer>(async () => ({ peer: b }),
      (peer, type, id, p) => events.push({ peer: peer.serverId, type, id, p }),
      () => assert.fail('must wait for target acknowledgement'), () => {});
    dial.start(a, 'A', 'B', 'default-cadence', 0);
    for (let step = 1; step <= 7; step++) {
      await dial.tick(step * 5000 - 1);
      assert.equal(events.filter(e => e.type === 'dialProgress').length, step);
      assert.equal(events.some(e => e.type === 'dialIn'), false);
      await dial.tick(step * 5000);
      assert.equal(events.filter(e => e.type === 'dialProgress').length, step + 1);
    }
    assert.equal(events.filter(e => e.type === 'dialIn').length, 1);
    assert.ok(events.filter(e => e.type === 'dialProgress').every(e => e.p.stepMs === 5000));
  }
  { // No early wormhole; seven steps, target acknowledgement, one open, expiry on both ends.
    const f = fixture(); f.coordinator.start(a, 'A', 'B', 'one');
    await f.steps(6); assert.equal(f.incoming(), undefined); assert.equal(f.opens, 0);
    await f.steps(1); const incoming = f.incoming(); assert.ok(incoming); assert.equal(f.opens, 0);
    assert.deepEqual(f.events.filter(e => e.type === 'dialProgress').map(e => e.p.chevron), [0,1,2,3,4,5,6,7]);
    assert.equal(f.coordinator.reply(c, incoming.id, 'B', true), false);
    assert.equal(f.coordinator.reply(b, incoming.id, 'B', true), true);
    assert.equal(f.coordinator.reply(b, incoming.id, 'B', true), false); assert.equal(f.opens, 1);
    f.coordinator.start(a, 'A', 'C', 'busy');
    assert.ok(f.events.some(e => e.id === 'busy' && e.p.reason === 'source_busy'));
    await f.advance(60000); assert.equal(f.closes, 1); assert.equal(f.coordinator.busy('A'), false); assert.equal(f.coordinator.busy('B'), false);
  }
  { // A finishes first; B's outgoing attempt is discarded, never resumes after closure.
    const f = fixture(); f.coordinator.start(a, 'A', 'B', 'a-out'); await f.steps(2);
    f.coordinator.start(b, 'B', 'A', 'b-out'); await f.steps(5);
    assert.ok(f.events.some(e => e.id === 'b-out' && e.p.reason === 'incoming_priority'));
    assert.equal(f.events.some(e => e.type === 'dialIn' && e.peer === 'a'), false);
    assert.equal(f.coordinator.reply(b, f.incoming().id, 'B', true), true);
    await f.advance(60000); await f.steps(); assert.equal(f.opens, 1); assert.equal(f.coordinator.busy('B'), false);
  }
  { // Exactly simultaneous crossed dials resolve to one connection.
    const f = fixture(); f.coordinator.start(a, 'A', 'B', 'a'); f.coordinator.start(b, 'B', 'A', 'b');
    await f.steps(); assert.equal(f.events.filter(e => e.type === 'dialIn').length, 1);
    assert.equal(f.events.filter(e => e.p.reason === 'incoming_priority').length, 1);
  }
  { // Invalid destination fails after the sequence; same-server fails without an incoming event.
    const f = fixture(); f.coordinator.start(a, 'A', 'missing', 'missing'); await f.steps(6);
    assert.equal(f.events.some(e => e.type === 'dialFail'), false);
    await f.steps(1); assert.ok(f.events.some(e => e.p.reason === 'gate_unavailable')); assert.equal(f.opens, 0);
    f.coordinator.start(a, 'A', 'A2', 'same'); await f.steps(); assert.ok(f.events.some(e => e.p.reason === 'same_server'));
  }
  { // Busy target, independent source gates, refusal, timeout and stale reply.
    const f = fixture(); f.coordinator.start(a, 'A', 'B', 'first'); await f.steps();
    const incoming = f.incoming(); f.coordinator.reply(b, incoming.id, 'B', true);
    f.coordinator.start(c, 'C', 'B', 'second'); await f.steps();
    assert.ok(f.events.some(e => e.id === 'second' && e.type === 'gateBlocked'));
    f.coordinator.start(a, 'A2', 'B2', 'independent'); await f.steps();
    const refused = f.incoming('B2'); assert.ok(refused); f.coordinator.reply(b, refused.id, 'B2', false);
    assert.equal(f.coordinator.busy('A2'), false); assert.equal(f.coordinator.busy('A'), true);
    f.coordinator.start(a, 'A2', 'B2', 'timeout'); await f.steps(); const late = f.incoming('B2');
    await f.advance(10000); assert.equal(f.coordinator.reply(b, late.id, 'B2', true), false);
    assert.equal(f.events.some(e => e.id === 'timeout' && e.p.reason === 'timeout'), true);
    f.coordinator.disconnect(b); assert.equal(f.coordinator.busy('A'), false);
  }
  { // Slow lookup cannot resurrect a disconnected attempt, or remain busy forever.
    let resolve!: (value: { peer: DialPeer }) => void;
    let time = 0;
    const events: Event[] = [];
    const dial = new DialCoordinator<DialPeer>(() => new Promise(r => { resolve = r; }),
      (peer, type, id, p) => events.push({ peer: peer.serverId, type, id, p }), () => assert.fail('unexpected open'), () => {},
      1, 60, 10, () => time);
    dial.start(a, 'A', 'B', 'slow');
    for (time = 1; time < 7; time++) await dial.tick();
    const pending = dial.tick(); time = 17; await dial.tick();
    assert.equal(dial.busy('A'), false); resolve({ peer: b }); await pending;
    assert.equal(events.some(e => e.type === 'dialIn'), false);
    dial.start(a, 'A', 'B', 'disconnect'); dial.disconnect(a); time += 100; await dial.tick();
    assert.equal(dial.busy('A'), false);
  }
  console.log('Stargate dial state-machine checks passed');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
