import { createHash } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { CRITICAL_WRITE_JOB_OPTIONS } from '@infra/queue/queue-policy';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import {
  businessTenant,
  BusinessTenantResolver,
  runForTenant,
} from '@infra/supabase/business-tenant';
import { SessionStateService } from '@memory/short-term/session-state.service';
import {
  FollowUpSchedulerService,
  type ScheduleFollowUpInput,
  type ScheduleBookingResolutionInput,
} from './follow-up-scheduler.service';

export const REENGAGEMENT_COMMAND_QUEUE = 'reengagement-commands';
export const REENGAGEMENT_COMMAND_JOB = 'apply';
export const REENGAGEMENT_COMMAND_KIND = {
  SCHEDULE: 'schedule',
  BOOKING_RESOLUTION: 'booking-resolution',
  STOP: 'stop',
  SUPERSEDE: 'supersede',
  ACTIVITY: 'activity',
} as const;
type StopInput = Parameters<FollowUpSchedulerService['stopPendingJobsForSessionScenario']>[0];
type SupersedeInput = Parameters<FollowUpSchedulerService['removeSupersededPendingJobs']>[0];
type StoredScheduleInput = Omit<ScheduleFollowUpInput, 'state'> & {
  state?: Omit<NonNullable<ScheduleFollowUpInput['state']>, 'recalledJobIds'> & {
    recalledJobIds: number[];
  };
};
type Command =
  | { kind: typeof REENGAGEMENT_COMMAND_KIND.SCHEDULE; input: StoredScheduleInput }
  | {
      kind: typeof REENGAGEMENT_COMMAND_KIND.BOOKING_RESOLUTION;
      input: ScheduleBookingResolutionInput;
    }
  | { kind: typeof REENGAGEMENT_COMMAND_KIND.STOP; input: StopInput }
  | { kind: typeof REENGAGEMENT_COMMAND_KIND.SUPERSEDE; input: SupersedeInput }
  | {
      kind: typeof REENGAGEMENT_COMMAND_KIND.ACTIVITY;
      input: { corpId: string; userId: string; sessionId: string; timestamp: number };
    };
type StoredCommand = Command & { tenantId?: string | null };

/** Durable admission for previously unawaited anchor work; execution stays in its owning domain. */
@Injectable()
export class ReengagementCommandService implements OnModuleInit {
  constructor(
    @InjectQueue(REENGAGEMENT_COMMAND_QUEUE) private readonly queue: Queue<StoredCommand>,
    private readonly scheduler: FollowUpSchedulerService,
    private readonly session: SessionStateService,
    private readonly failures: QueueFailureService,
    private readonly tenants: BusinessTenantResolver,
  ) {}

  onModuleInit(): void {
    this.queue.process(REENGAGEMENT_COMMAND_JOB, 1, (job: Job<StoredCommand>) => this.process(job));
    this.queue.on('failed', (job: Job, error: Error) => {
      void this.failures.exhausted(REENGAGEMENT_COMMAND_QUEUE, job, error);
    });
  }

  scheduleFollowUp(input: ScheduleFollowUpInput): Promise<void> {
    return this.enqueue(
      {
        kind: REENGAGEMENT_COMMAND_KIND.SCHEDULE,
        input: {
          ...input,
          state: input.state
            ? { ...input.state, recalledJobIds: [...input.state.recalledJobIds] }
            : undefined,
        },
      },
      `${input.sessionRef.sessionId}:${input.scenarioCode}:${input.anchorEventId}`,
    );
  }

  scheduleBookingResolution(input: ScheduleBookingResolutionInput): Promise<void> {
    return this.enqueue(
      { kind: REENGAGEMENT_COMMAND_KIND.BOOKING_RESOLUTION, input },
      `${input.sessionRef.sessionId}:${input.scenarioCode}:${input.anchorEventId}`,
    );
  }

  stopPendingJobsForSessionScenario(input: StopInput & { commandId: string }): Promise<void> {
    return this.enqueue(
      { kind: REENGAGEMENT_COMMAND_KIND.STOP, input: { ...input, beforeAnchorAt: Date.now() } },
      input.commandId,
    );
  }

  removeSupersededPendingJobs(input: SupersedeInput & { commandId: string }): Promise<void> {
    return this.enqueue(
      {
        kind: REENGAGEMENT_COMMAND_KIND.SUPERSEDE,
        input: { ...input, beforeAnchorAt: Date.now() },
      },
      input.commandId,
    );
  }

  recordCandidateActivity(
    input: Extract<Command, { kind: typeof REENGAGEMENT_COMMAND_KIND.ACTIVITY }>['input'],
  ): Promise<void> {
    return this.enqueue(
      { kind: REENGAGEMENT_COMMAND_KIND.ACTIVITY, input },
      `${input.sessionId}:${input.timestamp}`,
    );
  }

  async process(job: Job<StoredCommand>): Promise<void> {
    const command = job.data;
    let tenantId = command.tenantId;
    if (tenantId === undefined && command.kind === REENGAGEMENT_COMMAND_KIND.ACTIVITY) {
      // Older activity jobs contain only the session and the original message timestamp.
      const { sessionId, timestamp } = command.input;
      const botId = await this.tenants.historicalBot(sessionId, timestamp);
      tenantId = botId ? (await this.tenants.resolve([{ botId, at: timestamp }]))[0] : null;
    }
    if (tenantId === null) throw new Error('暂时无法核实复聊任务的组织');
    if (tenantId === undefined) return this.apply(command);
    return runForTenant(tenantId, () => this.apply(command));
  }

  private async apply(command: Command): Promise<void> {
    switch (command.kind) {
      case REENGAGEMENT_COMMAND_KIND.SCHEDULE: {
        const stored = command.input;
        const result = await this.scheduler.scheduleFollowUp({
          ...stored,
          state: stored.state
            ? { ...stored.state, recalledJobIds: new Set(stored.state.recalledJobIds) }
            : undefined,
        });
        if (result.reason === 'enqueue_error') throw new Error(result.reason);
        return;
      }
      case REENGAGEMENT_COMMAND_KIND.BOOKING_RESOLUTION: {
        const result = await this.scheduler.scheduleBookingResolution(command.input);
        if (result.reason === 'booking_resolution_schedule_error') throw new Error(result.reason);
        return;
      }
      case REENGAGEMENT_COMMAND_KIND.STOP:
        await this.scheduler.stopPendingJobsForSessionScenario(command.input);
        return;
      case REENGAGEMENT_COMMAND_KIND.SUPERSEDE:
        await this.scheduler.removeSupersededPendingJobs(command.input);
        return;
      case REENGAGEMENT_COMMAND_KIND.ACTIVITY: {
        const { corpId, userId, sessionId, timestamp } = command.input;
        await this.session.recordCandidateActivity(corpId, userId, sessionId, new Date(timestamp));
        return;
      }
    }
  }

  private async enqueue(command: Command, key: string): Promise<void> {
    const jobId = createHash('sha256').update(`${command.kind}:${key}`).digest('hex');
    try {
      await this.queue.add(
        REENGAGEMENT_COMMAND_JOB,
        { ...command, tenantId: businessTenant() },
        {
          ...CRITICAL_WRITE_JOB_OPTIONS,
          jobId,
        },
      );
    } catch (error) {
      await this.failures.report('reengagement.command_not_durable', command.kind, error);
      throw error;
    }
  }
}
