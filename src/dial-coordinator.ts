import { randomUUID } from 'node:crypto';

export interface DialPeer { serverId: string; networkCode: string; host: string; port: number; dialSequenceVersion: number }
type Attempt<P> = { kind: 'dial'; id: string; source: P; sourceGate: string; targetGate: string;
  requestId: string; step: number; nextStep: number; resolving: boolean };
export type Connection<P> = { kind: 'connection'; id: string; source: P; target: P; sourceGate: string;
  targetGate: string; requestId: string; open: boolean; expiresAt: number };
type Resolution<P> = { peer: P } | { reason: string };

/** One authoritative runtime per gate. No inventory or persistent transfer ownership lives here. */
export class DialCoordinator<P extends DialPeer> {
  private readonly gates = new Map<string, Attempt<P> | Connection<P>>();
  constructor(private readonly resolve: (source: P, gate: string) => Promise<Resolution<P>>,
    private readonly send: (peer: P, type: string, requestId: string, payload: Record<string, unknown>) => void,
    private readonly opened: (connection: Connection<P>) => void,
    private readonly closed: (connection: Connection<P>) => void,
    private readonly stepMs = 5000, private readonly openMs = 60000, private readonly replyMs = 10000, private readonly now: () => number = Date.now) {}

  busy(gate: string): boolean { return this.gates.has(gate); }

  start(source: P, sourceGate: string, targetGate: string, requestId: string, now = this.now()): void {
    if (this.busy(sourceGate)) {
      this.send(source, 'dialFail', requestId, { reason: 'source_busy' }); return;
    }
    const attempt: Attempt<P> = { kind: 'dial', id: randomUUID(), source, sourceGate, targetGate,
      requestId, step: 0, nextStep: now + this.stepMs, resolving: false };
    this.gates.set(sourceGate, attempt);
    this.state(source, sourceGate, 'OUTGOING', attempt.id, targetGate);
    this.progress(attempt);
  }

  async tick(now = this.now()): Promise<void> {
    const completing: Promise<void>[] = [];
    for (const state of new Set(this.gates.values())) {
      if (state.kind === 'connection') {
        if (now >= state.expiresAt) this.end(state, state.open ? 'closed' : 'timeout');
      } else if (state.resolving && now >= state.nextStep) {
        this.fail(state, 'timeout');
      } else if (!state.resolving && now >= state.nextStep && this.gates.get(state.sourceGate) === state) {
        state.step++;
        state.nextStep = now + this.stepMs;
        this.progress(state);
        if (state.step === 7) {
          state.resolving = true;
          state.nextStep = now + this.replyMs;
          completing.push(this.establish(state));
        }
      }
    }
    await Promise.all(completing);
  }

  private async establish(attempt: Attempt<P>): Promise<void> {
    let result: Resolution<P>;
    try { result = await this.resolve(attempt.source, attempt.targetGate); }
    catch { result = { reason: 'dial_lookup_failed' }; }
    // An incoming connection or disconnect may have invalidated this asynchronous lookup.
    if (this.gates.get(attempt.sourceGate) !== attempt) return;
    if ('reason' in result) { this.fail(attempt, result.reason); return; }
    const occupied = this.gates.get(attempt.targetGate);
    if (occupied?.kind === 'connection') { this.fail(attempt, 'target_busy', 'gateBlocked'); return; }
    // The first completed lookup wins. Even a seventh-chevron lookup still in flight can be preempted.
    if (occupied?.kind === 'dial') this.fail(occupied, 'incoming_priority');
    const connection: Connection<P> = { kind: 'connection', id: attempt.id, source: attempt.source,
      target: result.peer, sourceGate: attempt.sourceGate, targetGate: attempt.targetGate,
      requestId: attempt.requestId, open: false, expiresAt: this.now() + this.replyMs };
    this.gates.set(connection.sourceGate, connection);
    this.gates.set(connection.targetGate, connection);
    this.state(connection.target, connection.targetGate, 'INCOMING', connection.id, connection.sourceGate);
    this.send(connection.target, 'dialIn', connection.id, { dialId: connection.id,
      gateId: connection.targetGate, originGateId: connection.sourceGate });
  }

  reply(peer: P, dialId: string, gateId: string, free: boolean, now = this.now()): boolean {
    const connection = this.gates.get(gateId);
    if (!connection || connection.kind !== 'connection' || connection.id !== dialId
        || connection.target !== peer || connection.targetGate !== gateId || connection.open) return false;
    if (now >= connection.expiresAt) { this.end(connection, 'timeout'); return false; }
    if (!free) { this.end(connection, 'target_busy', 'gateBlocked'); return true; }
    connection.open = true;
    connection.expiresAt = now + this.openMs;
    this.opened(connection);
    this.state(connection.source, connection.sourceGate, 'OPEN', connection.id, connection.targetGate, 'OUTGOING');
    this.state(connection.target, connection.targetGate, 'OPEN', connection.id, connection.sourceGate, 'INCOMING');
    this.send(connection.source, 'gateFree', connection.requestId, { gateId, sourceGateId: connection.sourceGate,
      connectionId: connection.id, host: peer.host, port: peer.port, expiresInMs: this.openMs });
    return true;
  }

  disconnect(peer: P): void {
    for (const state of new Set(this.gates.values())) {
      if (state.kind === 'dial') {
        if (state.source === peer) this.fail(state, 'disconnected');
      } else if (state.source === peer || state.target === peer) this.end(state, 'disconnected');
    }
  }

  private progress(attempt: Attempt<P>): void {
    this.send(attempt.source, 'dialProgress', attempt.requestId, { gateId: attempt.targetGate,
      sourceGateId: attempt.sourceGate, dialId: attempt.id, chevron: attempt.step, total: 7, stepMs: this.stepMs });
  }

  private fail(attempt: Attempt<P>, reason: string, type = 'dialFail'): void {
    if (this.gates.get(attempt.sourceGate) !== attempt) return;
    this.gates.delete(attempt.sourceGate);
    this.state(attempt.source, attempt.sourceGate, 'IDLE', attempt.id, attempt.targetGate);
    this.send(attempt.source, type, attempt.requestId, { gateId: attempt.targetGate, reason });
  }

  private end(connection: Connection<P>, reason: string, type = 'dialFail'): void {
    if (this.gates.get(connection.sourceGate) !== connection) return;
    this.gates.delete(connection.sourceGate);
    this.gates.delete(connection.targetGate);
    this.closed(connection);
    this.state(connection.source, connection.sourceGate, 'IDLE', connection.id, connection.targetGate);
    this.state(connection.target, connection.targetGate, 'IDLE', connection.id, connection.sourceGate);
    if (!connection.open) this.send(connection.source, type, connection.requestId, { gateId: connection.targetGate, reason });
  }

  private state(peer: P, gateId: string, state: string, connectionId: string, peerGateId: string, direction = state): void {
    this.send(peer, 'gateState', connectionId, { gateId, state, direction, connectionId, peerGateId });
  }
}
