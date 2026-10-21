import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import { FeishuTaskClient } from './feishu-task.client';
import { InterventionTaskService } from './intervention-task.service';
import { INTERVENTION_TASK_QUEUE, type InterventionTaskJob } from './intervention-task-job';

@Injectable()
export class InterventionTaskProcessor implements OnModuleInit {
  constructor(
    @InjectQueue(INTERVENTION_TASK_QUEUE) private readonly queue: Queue<InterventionTaskJob>,
    private readonly client: FeishuTaskClient,
    private readonly failures: QueueFailureService,
    private readonly preparation: InterventionTaskService,
  ) {}

  onModuleInit(): void {
    this.queue.process('create', 1, (job: Job<InterventionTaskJob>) => this.process(job));
    this.queue.on('failed', (job: Job, error: Error) => {
      void this.failures.exhausted(INTERVENTION_TASK_QUEUE, job, error);
    });
  }

  async process(job: Job<InterventionTaskJob>): Promise<void> {
    if (job.data.taskGuid) return;
    if (job.data.dispatchStartedAt) {
      // The provider key's validity is not verified here. A restarted worker must not turn
      // an ambiguous create into a second task, especially after its short idempotency window.
      throw new Error('Feishu task result unknown; human reconciliation required before retry');
    }
    const request = job.data.request ?? (await this.preparation.prepareRequest(job.data));
    if (!request) return;
    const data = { ...job.data, request, dispatchStartedAt: Date.now() };
    await job.update(data);
    const task = await this.client.createTask({
      ...request,
      startAt: request.startAt ? new Date(request.startAt) : undefined,
      dueAt: request.dueAt ? new Date(request.dueAt) : undefined,
    });
    if (!task) throw new Error('Feishu task create has no authoritative success result');
    // Failure here is accounting failure, not permission to create again.
    await job.update({ ...data, taskGuid: task.guid });
  }
}
