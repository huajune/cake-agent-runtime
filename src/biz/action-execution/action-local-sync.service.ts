import { Injectable } from '@nestjs/common';
import { RedisLeaseService } from '@infra/queue/redis-lease.service';
import { conversationProcessingLeaseKey } from '@infra/queue/lease-keys';
import type {
  ActionRecord,
  ActionRecoveryHandler,
  ActionSyncContext,
} from './action-execution.types';

/** Background projection repair must serialize with the live conversation worker. */
@Injectable()
export class ActionLocalSyncService {
  constructor(private readonly leases: RedisLeaseService) {}

  async run(record: ActionRecord, handler: ActionRecoveryHandler): Promise<void> {
    if (!handler.sync) return;
    const lease = await this.leases.acquire(
      conversationProcessingLeaseKey(record.intent.chatId),
      90,
    );
    if (!lease) throw new Error('action_local_sync_conversation_busy');
    const deadline = Date.now() + 30_000;
    const context: ActionSyncContext = {
      assertOwned: async () => {
        if (Date.now() >= deadline || !(await this.leases.renew(lease)))
          throw new Error('action_local_sync_lease_lost');
      },
    };
    try {
      await context.assertOwned();
      await handler.sync(record, context);
      await context.assertOwned();
    } finally {
      await this.leases.release(lease);
    }
  }
}
