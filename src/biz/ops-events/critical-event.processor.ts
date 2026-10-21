import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import { OpsEventsRepository } from './repositories/ops-events.repository';
import type { RecordOpsEventInput } from './types/ops-events.types';

export const CRITICAL_OPS_EVENT_QUEUE = 'critical-ops-events';

@Injectable()
export class CriticalEventProcessor implements OnModuleInit {
  constructor(
    @InjectQueue(CRITICAL_OPS_EVENT_QUEUE) private readonly queue: Queue<RecordOpsEventInput>,
    private readonly repository: OpsEventsRepository,
    private readonly failures: QueueFailureService,
  ) {}

  onModuleInit(): void {
    this.queue.process('persist', 2, (job: Job<RecordOpsEventInput>) => this.process(job));
    this.queue.on('failed', (job: Job, error: Error) => {
      void this.failures.exhausted(CRITICAL_OPS_EVENT_QUEUE, job, error);
    });
  }

  async process(job: Job<RecordOpsEventInput>): Promise<void> {
    if (!job.data.occurredAt) throw new Error('Critical event missing original occurrence time');
    const result = await this.repository.upsertOpsEvent({
      ...job.data,
      occurredAt: job.data.occurredAt,
    });
    if (result === 'failed')
      throw new Error(`Critical event persistence failed: ${job.data.eventName}`);
  }
}
