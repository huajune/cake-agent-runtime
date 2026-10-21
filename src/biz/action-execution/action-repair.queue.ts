import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { ActionRecordsRepository } from './action-records.repository';
import { ActionRecoveryRegistry } from './action-recovery.registry';
import { actionDigest } from './action-identity';
import type { ActionCompletion, ActionRecord } from './action-execution.types';

export const ACTION_REPAIR_QUEUE = 'action-local-repair';
interface RepairJob {
  record: ActionRecord;
  completion: ActionCompletion<unknown>;
}

@Injectable()
export class ActionRepairQueue {
  constructor(@InjectQueue(ACTION_REPAIR_QUEUE) private readonly queue: Queue<RepairJob>) {}
  async enqueue(record: ActionRecord, completion: ActionCompletion<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.queue.add(
          'settle',
          { record, completion },
          {
            jobId: actionDigest([record.actionId, record.owner, completion]),
            attempts: 6,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 90 * 86400 },
          },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Local repair enqueue unconfirmed')), 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

@Processor(ACTION_REPAIR_QUEUE)
export class ActionRepairProcessor {
  private readonly logger = new Logger(ActionRepairProcessor.name);
  constructor(
    private readonly records: ActionRecordsRepository,
    private readonly handlers: ActionRecoveryRegistry,
  ) {}
  @Process('settle')
  async settle(job: Job<RepairJob>): Promise<void> {
    const record = await this.records.settle(job.data.record, job.data.completion);
    if (record.status !== 'succeeded' || record.localSync === 'complete') return;
    const handler = this.handlers.get(record.intent.kind);
    if (!handler) return; // Durable pending work remains discoverable by the scanner.
    if (handler.sync) await handler.sync(record);
    await this.records.markSynced(record);
  }
  @OnQueueFailed()
  failed(job: Job<RepairJob>, error: Error): void {
    if (job.attemptsMade >= (job.opts.attempts ?? 1))
      this.logger.error(`action.repair_queue_exhausted ${job.data.record.actionId}: ${error.name}`);
  }
}
