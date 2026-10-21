import { Injectable } from '@nestjs/common';
import { RedisLeaseService } from '@infra/queue/redis-lease.service';
import { conversationProcessingLeaseKey } from '@infra/queue/lease-keys';
import { ReplyDeferredError } from './reply-execution.types';

/** Serializes local repair with live chat work; database fences remain authoritative. */
@Injectable()
export class ReplyRecoveryLeaseService {
  constructor(private readonly leases: RedisLeaseService) {}

  async run<T>(
    chatId: string,
    task: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    const lease = await this.leases.acquire(conversationProcessingLeaseKey(chatId), 90);
    if (!lease) return undefined;
    const deadline = Date.now() + 30_000;
    const assertOwned = async () => {
      if (Date.now() >= deadline || !(await this.leases.renew(lease)))
        throw new ReplyDeferredError('reply_recovery_lease_or_budget_lost');
    };
    try {
      await assertOwned();
      return await task(assertOwned);
    } finally {
      await this.leases.release(lease);
    }
  }
}
