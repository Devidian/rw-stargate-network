import { DialCoordinator, type DialPeer } from './dial-coordinator.js';
import { observedGameHost } from './observed-host.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MongoClient, MongoServerError, type Collection } from 'mongodb';
import WebSocket, { WebSocketServer } from 'ws';
import { canonicalCode, MAX_PAYLOAD, parseMessage, stringValue, TRANSFER_WINDOW_MS, type Message, type WorldProfile, WORLD_KEYS } from './protocol.js';

type ServerRecord = { serverId: string; name: string; host: string; port: number; networkCode: string; computedCode: string; world: WorldProfile; plugins: string[]; forbiddenActions: Record<string, boolean>; travelEnabled: boolean; online: boolean; updatedAt: Date };
type GateRecord = { gateId: string; serverId: string; networkCode: string; createdAt: Date };
type AddressBookRecord = { networkCode: string; uid: string; gateId: string; learnedAt: Date };
type PlayerRecord = { uid: string; serverId: string; networkCode: string; name: string; playTimeSeconds: number; permissionGroup: string | null; updatedAt: Date };
type Session = DialPeer & { socket: WebSocket; travelEnabled: boolean };
type TransferState = 'PENDING' | 'ACCEPTED' | 'RELEASED' | 'CLAIMED' | 'DONE' | 'ABORTED';
type TransferRecord = { transferId: string; uid: string; networkCode: string; sourceServerId: string; targetServerId: string;
  sourceGateId: string; targetGateId: string; state: TransferState; payload: Record<string, unknown>;
  createdAt: Date; updatedAt: Date; expiresAt: Date };
type Window = { sourceServerId: string; targetServerId: string; sourceGateId: string; targetGateId: string; expiresAt: number; connectionId: string };

export class StargateRelay {
  private readonly sessions = new Map<string, Session>();
  private readonly observedHosts = new WeakMap<WebSocket, string>();
  private readonly dialing: DialCoordinator<Session>;
  private readonly windows = new Map<string, Window>();
  constructor(private readonly servers: Collection<ServerRecord>, private readonly gates: Collection<GateRecord>,
    private readonly players: Collection<PlayerRecord>, private readonly transfers: Collection<TransferRecord>,
    private readonly addressBooks: Collection<AddressBookRecord>) {
    const duration = (key: string, fallback: number, max: number) => {
      const value = Number(process.env[key] ?? fallback);
      if (!Number.isInteger(value) || value < 10 || value > max) throw new Error(`invalid_${key}`);
      return value;
    };
    this.dialing = new DialCoordinator(async (source, gateId) => {
      if (!source.travelEnabled) return { reason: 'network_disabled' };
      const gate = await this.gates.findOne({ gateId, networkCode: source.networkCode });
      if (this.sessions.get(source.serverId) !== source) return { reason: 'disconnected' };
      if (!gate) return { reason: 'gate_unavailable' };
      if (gate.serverId === source.serverId) return { reason: 'same_server' };
      const peer = this.sessions.get(gate.serverId);
      if (!peer || peer.networkCode !== source.networkCode || !peer.travelEnabled) return { reason: 'gate_offline' };
      if (peer.dialSequenceVersion !== 1) return { reason: 'dial_sequence_required' };
      return { peer };
    }, (peer, type, id, payload) => this.send(peer.socket, type, id, payload), connection => {
      this.windows.set(`${connection.source.serverId}:${connection.targetGate}`, {
        sourceServerId: connection.source.serverId, targetServerId: connection.target.serverId,
        sourceGateId: connection.sourceGate, targetGateId: connection.targetGate,
        expiresAt: connection.expiresAt, connectionId: connection.id });
    }, connection => {
      const key = `${connection.source.serverId}:${connection.targetGate}`;
      if (this.windows.get(key)?.connectionId === connection.id) this.windows.delete(key);
    }, duration('DIAL_STEP_MS', 7000, 7000), duration('GATE_OPEN_MS', 60000, 60000));
  }

  async tickDialing(): Promise<void> { await this.dialing.tick(); }

  async initialize(): Promise<void> {
    await Promise.all([
      this.servers.createIndex({ serverId: 1 }, { unique: true }),
      this.servers.createIndex({ networkCode: 1, online: 1 }),
      this.gates.createIndex({ gateId: 1 }, { unique: true }),
      this.gates.createIndex({ networkCode: 1, serverId: 1 }),
      this.addressBooks.createIndex({ networkCode: 1, uid: 1, gateId: 1 }, { unique: true }),
      this.addressBooks.createIndex({ networkCode: 1, gateId: 1 }),
      this.players.createIndex({ uid: 1, serverId: 1 }, { unique: true }),
      this.players.createIndex({ networkCode: 1, uid: 1 }),
      this.transfers.createIndex({ transferId: 1 }, { unique: true }),
      this.transfers.createIndex({ networkCode: 1, uid: 1 }, { unique: true,
        partialFilterExpression: { state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED', 'CLAIMED'] } } }),
      this.transfers.createIndex({ targetServerId: 1, state: 1 }),
      this.transfers.createIndex({ sourceServerId: 1, state: 1 })
    ]);
    await this.servers.updateMany({}, { $set: { online: false } });
  }

  async disconnect(socket: WebSocket): Promise<void> {
    const disconnected = [...this.sessions.values()].find(s => s.socket === socket)?.serverId;
    for (const [id, session] of this.sessions) {
      if (session.socket !== socket) continue;
      this.dialing.disconnect(session);
      this.sessions.delete(id);
      await this.servers.updateOne({ serverId: id }, { $set: { online: false, updatedAt: new Date() } });
    }
    for (const [key, window] of this.windows) if (window.sourceServerId === disconnected
        || window.targetServerId === disconnected) this.windows.delete(key);
  }

  async receive(socket: WebSocket, raw: string): Promise<void> {
    let message: Message;
    try { message = parseMessage(raw); }
    catch (error) { this.send(socket, 'error', 'invalid', { code: error instanceof Error ? error.message : 'invalid_message' }); return; }
    try {
      if (message.type === 'resolveHost') {
        const host = this.observedHosts.get(socket);
        if (!host) throw new Error('host_detection_unavailable');
        this.send(socket, 'hostResolved', message.requestId, { host });
        return;
      }
      if (message.type === 'initNetwork') { await this.initNetwork(socket, message); return; }
      const session = [...this.sessions.values()].find(candidate => candidate.socket === socket);
      if (!session || session.networkCode !== message.networkCode) throw new Error('network_not_initialized');
      switch (message.type) {
        case 'registerGate': await this.registerGate(session, message); break;
        case 'unregisterGate': await this.unregisterGate(session, message); break;
        case 'getAddressList': await this.addressList(session, message); break;
        case 'syncAddressBook': await this.syncAddressBook(session, message); break;
        case 'dialGate': await this.dialGate(session, message); break;
        case 'gateFree': case 'gateBlocked': await this.dialReply(session, message); break;
        case 'updatePlayer': await this.updatePlayer(session, message); break;
        case 'playerTrust': await this.playerTrust(session, message); break;
        case 'transferStart': await this.transferStart(session, message); break;
        case 'transferAccepted': await this.transferAccepted(session, message); break;
        case 'transferReleased': await this.transferReleased(session, message); break;
        case 'transferClaim': await this.transferClaim(session, message); break;
        case 'transferDone': await this.transferDone(session, message); break;
        case 'transferAbort': case 'transferInterrupted': await this.transferAbort(session, message); break;
        case 'transferStatus': await this.transferStatus(session, message); break;
        default: throw new Error('unknown_event');
      }
    } catch (error) {
      this.send(socket, 'error', message.requestId, { code: error instanceof Error ? error.message : 'internal_error' });
    }
  }

  setObservedHost(socket: WebSocket, host: string | null): void {
    if (host) this.observedHosts.set(socket, host);
  }

  private async initNetwork(socket: WebSocket, msg: Message): Promise<void> {
    const p = msg.payload;
    const serverId = stringValue(p.serverId, 128);
    const name = stringValue(p.name, 128);
    const host = stringValue(p.host, 255);
    const port = p.port;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error('invalid_port');
    if (!p.world || typeof p.world !== 'object' || Array.isArray(p.world)) throw new Error('invalid_world');
    if (!Array.isArray(p.plugins) || p.plugins.length > 256) throw new Error('invalid_plugins');
    const world = p.world as WorldProfile;
    for (const key of WORLD_KEYS) stringValue(world[key], 256);
    const plugins = p.plugins.map(value => stringValue(value, 256));
    if (p.forbiddenActions !== undefined && (typeof p.forbiddenActions !== 'object'
        || p.forbiddenActions === null || Array.isArray(p.forbiddenActions))) {
      throw new Error('invalid_forbidden_actions');
    }
    const forbiddenActions = (p.forbiddenActions || {}) as Record<string, boolean>;
    if (p.travelEnabled !== undefined && typeof p.travelEnabled !== 'boolean') throw new Error('invalid_travel_enabled');
    // Legacy plugin clients did not send this field and retain their existing routing.
    const travelEnabled = p.travelEnabled !== false;
    const computedCode = canonicalCode(world, plugins, forbiddenActions);
    const override = typeof p.override === 'string' && p.override.trim() ? stringValue(p.override, 128) : '';
    if (override && !/^[a-zA-Z0-9_-]+$/.test(override)) throw new Error('invalid_override');
    const networkCode = override || computedCode;
    const active = this.sessions.get(serverId);
    if (active && active.socket !== socket && active.socket.readyState === WebSocket.OPEN) {
      this.dialing.disconnect(active);
      active.socket.close(4001, 'replaced by server reconnect');
    }
    const prior = await this.servers.findOne({ serverId });
    await this.servers.updateOne({ serverId }, { $set: { serverId, name, host, port: port as number,
      networkCode, computedCode, world, plugins, forbiddenActions, travelEnabled, online: true, updatedAt: new Date() } }, { upsert: true });
    if (prior && prior.networkCode !== networkCode) {
      await this.gates.updateMany({ serverId, networkCode: prior.networkCode }, { $set: { networkCode } });
      await this.players.updateMany({ serverId, networkCode: prior.networkCode }, { $set: { networkCode } });
    }
    this.sessions.set(serverId, { socket, serverId, networkCode, host, port: port as number, travelEnabled,
      dialSequenceVersion: p.dialSequenceVersion === 1 ? 1 : 0 });
    this.send(socket, 'networkReady', msg.requestId, { networkCode, computedCode, dialSequenceVersion: 1, changed: !!prior && prior.networkCode !== networkCode });
    await this.replayTransfers(this.sessions.get(serverId)!);
  }

  private async registerGate(session: Session, msg: Message): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const gateId = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
      try {
        await this.gates.insertOne({ gateId, serverId: session.serverId, networkCode: session.networkCode, createdAt: new Date() });
        this.send(session.socket, 'gateRegistered', msg.requestId, { gateId });
        return;
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      }
    }
    throw new Error('gate_address_exhausted');
  }

  private async unregisterGate(session: Session, msg: Message): Promise<void> {
    const gateId = stringValue(msg.payload.gateId, 80);
    if (!await this.gates.findOne({ gateId, serverId: session.serverId, networkCode: session.networkCode })) {
      throw new Error('gate_not_owned_or_missing');
    }
    if (this.dialing.busy(gateId)) throw new Error('gate_busy');
    const result = await this.gates.deleteOne({ gateId, serverId: session.serverId, networkCode: session.networkCode });
    if (!result.deletedCount) throw new Error('gate_not_owned_or_missing');
    await this.addressBooks.deleteMany({ networkCode: session.networkCode, gateId });
    this.send(session.socket, 'gateUnregistered', msg.requestId, { gateId });
    for (const peer of this.sessions.values()) if (peer.networkCode === session.networkCode)
      this.send(peer.socket, 'addressRemoved', randomUUID(), { gateId });
  }

  private async syncAddressBook(session: Session, msg: Message): Promise<void> {
    const uid = stringValue(msg.payload.uid, 128);
    if (!/^[A-Za-z0-9_-]+$/.test(uid)) throw new Error('invalid_uid');
    const pending = msg.payload.pending;
    if (!Array.isArray(pending) || pending.length > 256) throw new Error('invalid_pending_addresses');
    for (const raw of new Set(pending)) {
      const gateId = stringValue(raw, 16);
      if (!/^[A-Z0-9]{16}$/.test(gateId)) throw new Error('invalid_gate_address');
      if (!await this.gates.findOne({ networkCode: session.networkCode, gateId })) continue;
      await this.addressBooks.updateOne({ networkCode: session.networkCode, uid, gateId },
        { $setOnInsert: { networkCode: session.networkCode, uid, gateId, learnedAt: new Date() } }, { upsert: true });
    }
    const rows = await this.addressBooks.find({ networkCode: session.networkCode, uid })
      .project({ _id: 0, gateId: 1 }).sort({ gateId: 1 }).toArray();
    const existing = new Set((await this.gates.find({ networkCode: session.networkCode,
      gateId: { $in: rows.map(row => row.gateId) } }).project({ _id: 0, gateId: 1 }).toArray()).map(row => row.gateId));
    const stale = rows.filter(row => !existing.has(row.gateId)).map(row => row.gateId);
    if (stale.length) await this.addressBooks.deleteMany({ networkCode: session.networkCode, uid, gateId: { $in: stale } });
    this.send(session.socket, 'addressBook', msg.requestId, { uid, gates: rows.map(row => row.gateId).filter(id => existing.has(id)) });
  }

  private async addressList(session: Session, msg: Message): Promise<void> {
    if (!session.travelEnabled) throw new Error('network_disabled');
    const online = [...this.sessions.values()].filter(value => value.travelEnabled && value.networkCode === session.networkCode).map(value => value.serverId);
    const rows = await this.gates.find({ networkCode: session.networkCode, serverId: { $in: online } }).project({ _id: 0, gateId: 1, serverId: 1 }).limit(256).toArray();
    this.send(session.socket, 'addressList', msg.requestId, { gates: rows });
  }

  private async dialGate(session: Session, msg: Message): Promise<void> {
    if (!session.travelEnabled) throw new Error('network_disabled');
    const gateId = stringValue(msg.payload.gateId, 80);
    const originGateId = stringValue(msg.payload.originGateId, 80);
    const originGate = await this.gates.findOne({ gateId: originGateId, serverId: session.serverId, networkCode: session.networkCode });
    if (!originGate) throw new Error('origin_gate_not_owned');
    if (this.sessions.get(session.serverId) !== session) throw new Error('network_not_initialized');
    if (session.dialSequenceVersion !== 1) throw new Error('dial_sequence_required');
    this.dialing.start(session, originGateId, gateId, msg.requestId);
  }

  private async dialReply(session: Session, msg: Message): Promise<void> {
    const dialId = stringValue(msg.payload.dialId, 80);
    const gateId = stringValue(msg.payload.gateId, 80);
    if (!this.dialing.reply(session, dialId, gateId, msg.type === 'gateFree')) throw new Error('unknown_dial');
  }

  private async updatePlayer(session: Session, msg: Message): Promise<void> {
    const p = msg.payload;
    const uid = stringValue(p.uid, 128);
    const name = stringValue(p.name, 128);
    if (!Number.isInteger(p.playTimeSeconds) || (p.playTimeSeconds as number) < 0) throw new Error('invalid_play_time');
    const permissionGroup = p.permissionGroup == null ? null : stringValue(p.permissionGroup, 128);
    await this.players.updateOne({ uid, serverId: session.serverId }, { $set: {
      uid, serverId: session.serverId, networkCode: session.networkCode, name,
      playTimeSeconds: p.playTimeSeconds as number, permissionGroup, updatedAt: new Date()
    } }, { upsert: true });
    this.send(session.socket, 'playerUpdated', msg.requestId, { uid });
  }

  private async playerTrust(session: Session, msg: Message): Promise<void> {
    const uid = stringValue(msg.payload.uid, 128);
    const observations = await this.players.find({ networkCode: session.networkCode, uid })
      .project({ _id: 0, serverId: 1, name: 1, playTimeSeconds: 1, permissionGroup: 1, updatedAt: 1 })
      .limit(256).toArray();
    this.send(session.socket, 'playerTrust', msg.requestId, { uid, observations });
  }

  private transferId(msg: Message): string {
    const id = stringValue(msg.payload.transferId, 80);
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid_transfer_id');
    return id;
  }

  private async transferStart(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const uid = stringValue(msg.payload.uid, 128);
    const sourceGateId = stringValue(msg.payload.sourceGateId, 80);
    const targetGateId = stringValue(msg.payload.targetGateId, 80);
    const existing = await this.transfers.findOne({ transferId });
    if (existing) {
      if (existing.sourceServerId !== session.serverId || existing.uid !== uid || existing.networkCode !== session.networkCode
          || existing.sourceGateId !== sourceGateId || existing.targetGateId !== targetGateId) throw new Error('transfer_id_conflict');
      this.send(session.socket, 'transferStatus', msg.requestId, this.statusPayload(existing));
      return;
    }
    const window = this.windows.get(`${session.serverId}:${targetGateId}`);
    if (!window || window.expiresAt <= Date.now() || window.sourceGateId !== sourceGateId) throw new Error('gate_not_open');
    const target = this.sessions.get(window.targetServerId);
    if (!target || target.networkCode !== session.networkCode) throw new Error('gate_offline');
    if (!await this.gates.findOne({ gateId: sourceGateId, serverId: session.serverId, networkCode: session.networkCode })
        || !await this.gates.findOne({ gateId: targetGateId, serverId: target.serverId, networkCode: session.networkCode })) {
      throw new Error('gate_unavailable');
    }
    const data = msg.payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_transfer_data');
    const payload = data as Record<string, unknown>;
    for (const key of ['inventory', 'clothes']) {
      const value = payload[key];
      if (typeof value !== 'string' || value.length > 650_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error('invalid_transfer_data');
      }
    }
    for (const key of ['health', 'hunger', 'thirst', 'stamina']) {
      if (!Number.isInteger(payload[key]) || (payload[key] as number) < 0 || (payload[key] as number) > 100_000) {
        throw new Error('invalid_transfer_data');
      }
    }
    const now = new Date();
    const transfer: TransferRecord = { transferId, uid, networkCode: session.networkCode,
      sourceServerId: session.serverId, targetServerId: target.serverId, sourceGateId, targetGateId,
      state: 'PENDING', payload, createdAt: now, updatedAt: now,
      expiresAt: new Date(now.getTime() + TRANSFER_WINDOW_MS) };
    try { await this.transfers.insertOne(transfer); }
    catch (error) {
      if (error instanceof Error && /E11000/.test(error.message)) {
        const duplicate = await this.transfers.findOne({ transferId, uid, sourceServerId: session.serverId,
          networkCode: session.networkCode, sourceGateId, targetGateId });
        if (duplicate) { this.send(session.socket, 'transferStatus', msg.requestId, this.statusPayload(duplicate)); return; }
        throw new Error('player_transfer_active');
      }
      throw error;
    }
    // A trip does not consume the wormhole. Its coordinator closes the window on
    // expiry/disconnect; the durable per-player active-transfer index prevents duplicates.
    this.send(session.socket, 'transferQueued', msg.requestId, this.statusPayload(transfer));
    this.deliverIncoming(transfer);
  }

  private async transferAccepted(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const transfer = await this.transfers.findOne({ transferId, targetServerId: session.serverId,
      networkCode: session.networkCode });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'PENDING') {
      if (transfer.expiresAt.getTime() <= Date.now()) throw new Error('transfer_expired');
      await this.transfers.updateOne({ transferId, state: 'PENDING' },
        { $set: { state: 'ACCEPTED', updatedAt: new Date() } });
    } else if (transfer.state !== 'ACCEPTED' && transfer.state !== 'RELEASED' && transfer.state !== 'CLAIMED' && transfer.state !== 'DONE') {
      throw new Error('transfer_aborted');
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'ACCEPTED' && latest.state !== 'RELEASED' && latest.state !== 'CLAIMED' && latest.state !== 'DONE') throw new Error('transfer_aborted');
    this.send(session.socket, 'transferAcceptedAck', msg.requestId, this.statusPayload(latest));
    this.notifySource(latest, 'transferAccepted');
  }

  private async transferReleased(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const transfer = await this.transfers.findOne({ transferId, sourceServerId: session.serverId,
      networkCode: session.networkCode });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'ACCEPTED' && transfer.expiresAt.getTime() > Date.now()) {
      await this.transfers.updateOne({ transferId, state: 'ACCEPTED' },
        { $set: { state: 'RELEASED', updatedAt: new Date() } });
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'RELEASED' && latest.state !== 'CLAIMED' && latest.state !== 'DONE') throw new Error('transfer_not_released');
    this.notifySource(latest, 'transferReleased');
  }

  private async transferClaim(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const transfer = await this.transfers.findOne({ transferId, targetServerId: session.serverId,
      networkCode: session.networkCode });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'RELEASED' && transfer.expiresAt.getTime() > Date.now()) {
      await this.transfers.updateOne({ transferId, state: 'RELEASED' },
        { $set: { state: 'CLAIMED', updatedAt: new Date() } });
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'CLAIMED' && latest.state !== 'DONE') throw new Error('transfer_not_claimable');
    this.send(session.socket, 'transferClaimed', msg.requestId, this.statusPayload(latest));
  }

  private async transferDone(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const transfer = await this.transfers.findOne({ transferId, targetServerId: session.serverId,
      networkCode: session.networkCode });
    if (!transfer || (transfer.state !== 'CLAIMED' && transfer.state !== 'DONE')) throw new Error('transfer_not_claimed');
    if (transfer.state === 'CLAIMED') await this.transfers.updateOne({ transferId, state: 'CLAIMED' },
      { $set: { state: 'DONE', updatedAt: new Date(), payload: {} } });
    const latest = (await this.transfers.findOne({ transferId }))!;
    this.send(session.socket, 'transferDoneAck', msg.requestId, this.statusPayload(latest));
    this.notifySource(latest, 'transferDone');
  }

  private async transferAbort(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const transfer = await this.transfers.findOne({ transferId, networkCode: session.networkCode,
      ...(msg.type === 'transferInterrupted' ? { targetServerId: session.serverId } : { sourceServerId: session.serverId }) });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'PENDING' || transfer.state === 'ACCEPTED' || transfer.state === 'RELEASED') {
      await this.transfers.updateOne({ transferId, state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED'] } },
        { $set: { state: 'ABORTED', updatedAt: new Date(), payload: {} } });
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'ABORTED') throw new Error('transfer_already_claimed');
    this.send(session.socket, 'transferAborted', msg.requestId, this.statusPayload(latest));
    this.notifySource(latest, 'transferFailed');
    this.notifyTarget(latest, 'transferCancelled');
  }

  private async transferStatus(session: Session, msg: Message): Promise<void> {
    const transferId = this.transferId(msg);
    const transfer = await this.transfers.findOne({ transferId, networkCode: session.networkCode,
      $or: [{ sourceServerId: session.serverId }, { targetServerId: session.serverId }] });
    if (!transfer) throw new Error('transfer_not_found');
    const target = transfer.sourceServerId === session.serverId
      ? await this.servers.findOne({ serverId: transfer.targetServerId }) : null;
    this.send(session.socket, 'transferStatus', msg.requestId,
      { ...this.statusPayload(transfer), ...(target ? { host: target.host, port: target.port } : {}) });
  }

  private statusPayload(transfer: TransferRecord): Record<string, unknown> {
    return { transferId: transfer.transferId, uid: transfer.uid, state: transfer.state,
      sourceGateId: transfer.sourceGateId, targetGateId: transfer.targetGateId,
      expiresAt: transfer.expiresAt.getTime() };
  }

  private deliverIncoming(transfer: TransferRecord): void {
    const target = this.sessions.get(transfer.targetServerId);
    if (target?.networkCode === transfer.networkCode) this.send(target.socket, 'incomingTransfer', transfer.transferId,
      { ...this.statusPayload(transfer), data: transfer.payload });
  }

  private notifySource(transfer: TransferRecord, type: string): void {
    const source = this.sessions.get(transfer.sourceServerId);
    if (!source || source.networkCode !== transfer.networkCode) return;
    const target = this.sessions.get(transfer.targetServerId);
    void this.servers.findOne({ serverId: transfer.targetServerId }).then(server => {
      this.send(source.socket, type, transfer.transferId,
        { ...this.statusPayload(transfer), ...(server && target ? { host: server.host, port: server.port } : {}) });
    }).catch(error => console.error('transfer_notify_error', error));
  }

  private notifyTarget(transfer: TransferRecord, type: string): void {
    const target = this.sessions.get(transfer.targetServerId);
    if (target?.networkCode === transfer.networkCode) this.send(target.socket, type, transfer.transferId,
      this.statusPayload(transfer));
  }

  private async replayTransfers(session: Session): Promise<void> {
    const targetPending = await this.transfers.find({ targetServerId: session.serverId,
      networkCode: session.networkCode, state: 'PENDING' }).limit(256).toArray();
    for (const transfer of targetPending) if (transfer.expiresAt.getTime() > Date.now()) this.deliverIncoming(transfer);
    const sourceAccepted = await this.transfers.find({ sourceServerId: session.serverId,
      networkCode: session.networkCode, state: { $in: ['ACCEPTED', 'RELEASED', 'CLAIMED', 'DONE', 'ABORTED'] } })
      .sort({ updatedAt: -1 }).limit(256).toArray();
    for (const transfer of sourceAccepted) this.notifySource(transfer,
      transfer.state === 'DONE' ? 'transferDone' : transfer.state === 'ABORTED' ? 'transferFailed' : transfer.state === 'RELEASED' ? 'transferReleased' : 'transferAccepted');
  }

  async expireTransfers(): Promise<void> {
    const expired = await this.transfers.find({ state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED'] },
      expiresAt: { $lte: new Date() } }).limit(256).toArray();
    for (const transfer of expired) {
      const result = await this.transfers.updateOne({ transferId: transfer.transferId,
        state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED'] } }, { $set: { state: 'ABORTED', updatedAt: new Date(), payload: {} } });
      if (!result.modifiedCount) continue;
      const aborted = { ...transfer, state: 'ABORTED' as const };
      this.notifySource(aborted, 'transferFailed');
      this.notifyTarget(aborted, 'transferCancelled');
    }
  }

  private send(socket: WebSocket, type: string, requestId: string, payload: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type, requestId, payload }));
  }
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is required');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE || 'rw_stargate_network');
  const relay = new StargateRelay(db.collection<ServerRecord>('servers'), db.collection<GateRecord>('gates'),
    db.collection<PlayerRecord>('players'), db.collection<TransferRecord>('transfers'),
    db.collection<AddressBookRecord>('address_books'));
  await relay.initialize();
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const ws = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  // Keep the reverse proxy and clients active while no gate commands are sent.
  const heartbeat = setInterval(() => {
    for (const socket of ws.clients) if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, 30_000);
  const dialing = setInterval(() => void relay.tickDialing().catch(error => console.error('dial_tick_error', error)), 100);
  const expiry = setInterval(() => void relay.expireTransfers().catch(error => console.error('transfer_expiry_error', error)), 5_000);
  ws.on('connection', (socket, request) => {
    const realIp = typeof request.headers['x-real-ip'] === 'string' ? request.headers['x-real-ip'] : undefined;
    relay.setObservedHost(socket, observedGameHost(realIp, process.env.LOCAL_GAME_PUBLIC_IP));
    socket.on('message', data => void relay.receive(socket, data.toString()).catch(error => console.error('relay_receive_error', error)));
    socket.on('close', () => void relay.disconnect(socket).catch(error => console.error('relay_disconnect_error', error)));
  });
  const port = Number(process.env.PORT || 47016);
  server.listen(port, '0.0.0.0', () => console.log(`Stargate relay listening on ${port}`));
  const shutdown = async () => { clearInterval(heartbeat); clearInterval(dialing); clearInterval(expiry); ws.close(); server.close(); await client.close(); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
