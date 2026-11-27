import type { Collection } from 'mongodb';

export type TransferState = 'PENDING' | 'ACCEPTED' | 'RELEASED' | 'CLAIMED' | 'DONE' | 'ABORTED';
export type TransferRecord = {
  transferId: string; uid: string; networkCode: string; sourceServerId: string; targetServerId: string;
  sourceGateId: string; targetGateId: string; state: TransferState; payload: Record<string, unknown>;
  createdAt: Date; updatedAt: Date; expiresAt: Date;
};

/** Durable transition rules. The relay owns sessions, authorization routing and notifications. */
export class TransferStateStore {
  constructor(private readonly transfers: Collection<TransferRecord>) {}

  async accept(transferId: string, serverId: string, networkCode: string): Promise<TransferRecord> {
    const transfer = await this.transfers.findOne({ transferId, targetServerId: serverId, networkCode });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'PENDING') {
      if (transfer.expiresAt.getTime() <= Date.now()) throw new Error('transfer_expired');
      await this.transfers.updateOne({ transferId, state: 'PENDING' },
        { $set: { state: 'ACCEPTED', updatedAt: new Date() } });
    } else if (transfer.state !== 'ACCEPTED' && transfer.state !== 'RELEASED'
        && transfer.state !== 'CLAIMED' && transfer.state !== 'DONE') {
      throw new Error('transfer_aborted');
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'ACCEPTED' && latest.state !== 'RELEASED'
        && latest.state !== 'CLAIMED' && latest.state !== 'DONE') throw new Error('transfer_aborted');
    return latest;
  }

  async release(transferId: string, serverId: string, networkCode: string): Promise<TransferRecord> {
    const transfer = await this.transfers.findOne({ transferId, sourceServerId: serverId, networkCode });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'ACCEPTED' && transfer.expiresAt.getTime() > Date.now()) {
      await this.transfers.updateOne({ transferId, state: 'ACCEPTED' },
        { $set: { state: 'RELEASED', updatedAt: new Date() } });
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'RELEASED' && latest.state !== 'CLAIMED' && latest.state !== 'DONE') {
      throw new Error('transfer_not_released');
    }
    return latest;
  }

  async claim(transferId: string, serverId: string, networkCode: string): Promise<TransferRecord> {
    const transfer = await this.transfers.findOne({ transferId, targetServerId: serverId, networkCode });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'RELEASED' && transfer.expiresAt.getTime() > Date.now()) {
      await this.transfers.updateOne({ transferId, state: 'RELEASED' },
        { $set: { state: 'CLAIMED', updatedAt: new Date() } });
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'CLAIMED' && latest.state !== 'DONE') throw new Error('transfer_not_claimable');
    return latest;
  }

  async complete(transferId: string, serverId: string, networkCode: string): Promise<TransferRecord> {
    const transfer = await this.transfers.findOne({ transferId, targetServerId: serverId, networkCode });
    if (!transfer || (transfer.state !== 'CLAIMED' && transfer.state !== 'DONE')) throw new Error('transfer_not_claimed');
    if (transfer.state === 'CLAIMED') await this.transfers.updateOne({ transferId, state: 'CLAIMED' },
      { $set: { state: 'DONE', updatedAt: new Date(), payload: {} } });
    return (await this.transfers.findOne({ transferId }))!;
  }

  async abort(transferId: string, serverId: string, networkCode: string, interrupted: boolean): Promise<TransferRecord> {
    const transfer = await this.transfers.findOne({ transferId, networkCode,
      ...(interrupted ? { targetServerId: serverId } : { sourceServerId: serverId }) });
    if (!transfer) throw new Error('transfer_not_found');
    if (transfer.state === 'PENDING' || transfer.state === 'ACCEPTED' || transfer.state === 'RELEASED') {
      await this.transfers.updateOne({ transferId, state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED'] } },
        { $set: { state: 'ABORTED', updatedAt: new Date(), payload: {} } });
    }
    const latest = (await this.transfers.findOne({ transferId }))!;
    if (latest.state !== 'ABORTED') throw new Error('transfer_already_claimed');
    return latest;
  }
  async *expire(): AsyncGenerator<TransferRecord> {
    const expired = await this.transfers.find({ state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED'] },
      expiresAt: { $lte: new Date() } }).limit(256).toArray();
    for (const transfer of expired) {
      const result = await this.transfers.updateOne({ transferId: transfer.transferId,
        state: { $in: ['PENDING', 'ACCEPTED', 'RELEASED'] } },
        { $set: { state: 'ABORTED', updatedAt: new Date(), payload: {} } });
      if (result.modifiedCount) yield { ...transfer, state: 'ABORTED' };
    }
  }

}
