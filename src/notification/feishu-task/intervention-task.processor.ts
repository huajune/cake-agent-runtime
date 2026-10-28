import { DelegatedTaskAssignmentService } from './delegated-task-assignment.service';
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
    private readonly delegation: DelegatedTaskAssignmentService,
  ) {}

  onModuleInit(): void {
    this.queue.process('create', 1, (job: Job<InterventionTaskJob>) => this.process(job));
    this.queue.on('failed', (job: Job, error: Error) => {
      void this.failures.exhausted(INTERVENTION_TASK_QUEUE, job, error);
    });
  }

  async process(job: Job<InterventionTaskJob>): Promise<void> {
    let data = job.data;
    if (!data.taskGuid) {
      if (data.dispatchStartedAt) {
        // An ambiguous create must be reconciled, never repeated after idempotency expires.
        throw new Error('Feishu task result unknown; human reconciliation required before retry');
      }
      const request = data.request ?? (await this.preparation.prepareRequest(data));
      if (!request) return;
      let assignment = data.assignment;
      if (!assignment && this.delegation.isRequired(request.tasklistGuid)) {
        const tasklistGuid = request.tasklistGuid!;
        const members = request.members ?? [];
        const delegatedBy = await this.delegation.prepare(tasklistGuid, members);
        assignment = { tasklistGuid, delegatedBy, members };
      }
      data = { ...data, request, assignment, dispatchStartedAt: Date.now() };
      await job.update(data);
      const task = await this.client.createTask({
        ...request,
        // External users cannot be assigned through the tenant identity.
        members: assignment ? undefined : request.members,
        startAt: request.startAt ? new Date(request.startAt) : undefined,
        dueAt: request.dueAt ? new Date(request.dueAt) : undefined,
      });
      if (!task) throw new Error('Feishu task create has no authoritative success result');
      data = { ...data, taskGuid: task.guid };
      // Persist the external side effect before attempting assignment.
      await job.update(data);
    }
    if (data.assignment && !data.assignment.completedAt) {
      const { tasklistGuid, delegatedBy, members } = data.assignment;
      await this.delegation.assign(data.taskGuid!, tasklistGuid, delegatedBy, members);
      await job.update({ ...data, assignment: { ...data.assignment, completedAt: Date.now() } });
    }
  }
}
