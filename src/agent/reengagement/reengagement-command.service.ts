import { createHash } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { CRITICAL_WRITE_JOB_OPTIONS } from '@infra/queue/queue-policy';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import {
  FollowUpSchedulerService,
  type ScheduleFollowUpInput,
  type ScheduleBookingResolutionInput,
} from './follow-up-scheduler.service';

export const REENGAGEMENT_COMMAND_QUEUE = 'reengagement-commands';
type StopInput = Parameters<FollowUpSchedulerService['stopPendingJobsForSessionScenario']>[0];
type SupersedeInput = Parameters<FollowUpSchedulerService['removeSupersededPendingJobs']>[0];
type StoredScheduleInput = Omit<ScheduleFollowUpInput, 'state'> & {
  state?: Omit<NonNullable<ScheduleFollowUpInput['state']>, 'recalledJobIds'> & {
    recalledJobIds: number[];
  };
};
type Command =
  | { kind: 'schedule'; input: StoredScheduleInput }
  | { kind: 'booking-resolution'; input: ScheduleBookingResolutionInput }
  | { kind: 'stop'; input: StopInput }
  | { kind: 'supersede'; input: SupersedeInput }
  | {
      kind: 'activity';
      input: { corpId: string; userId: string; sessionId: string; timestamp: number };
    };

/** Durable admission for previously unawaited anchor work; execution stays in its owning domain. */
@Injectable()
export class ReengagementCommandService implements OnModuleInit {
  constructor(
    @InjectQueue(REENGAGEMENT_COMMAND_QUEUE) private readonly queue: Queue<Command>,
    private readonly scheduler: FollowUpSchedulerService,
    private readonly session: SessionStateService,
    private readonly failures: QueueFailureService,
  ) {}

  onModuleInit(): void {
    this.queue.process('apply', 1, (job: Job<Command>) => this.process(job));
    this.queue.on('failed', (job: Job, error: Error) => {
      void this.failures.exhausted(REENGAGEMENT_COMMAND_QUEUE, job, error);
    });
  }

  scheduleFollowUp(input: ScheduleFollowUpInput): Promise<void> {
    return this.enqueue(
      {
        kind: 'schedule',
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
      { kind: 'booking-resolution', input },
      `${input.sessionRef.sessionId}:${input.scenarioCode}:${input.anchorEventId}`,
    );
  }

  stopPendingJobsForSessionScenario(input: StopInput & { commandId: string }): Promise<void> {
    return this.enqueue(
      { kind: 'stop', input: { ...input, beforeAnchorAt: Date.now() } },
      input.commandId,
    );
  }

  removeSupersededPendingJobs(input: SupersedeInput & { commandId: string }): Promise<void> {
    return this.enqueue(
      { kind: 'supersede', input: { ...input, beforeAnchorAt: Date.now() } },
      input.commandId,
    );
  }

  recordCandidateActivity(input: Extract<Command, { kind: 'activity' }>['input']): Promise<void> {
    return this.enqueue({ kind: 'activity', input }, `${input.sessionId}:${input.timestamp}`);
  }

  async process(job: Job<Command>): Promise<void> {
    const command = job.data;
    switch (command.kind) {
      case 'schedule': {
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
      case 'booking-resolution': {
        const result = await this.scheduler.scheduleBookingResolution(command.input);
        if (result.reason === 'booking_resolution_schedule_error') throw new Error(result.reason);
        return;
      }
      case 'stop':
        await this.scheduler.stopPendingJobsForSessionScenario(command.input);
        return;
      case 'supersede':
        await this.scheduler.removeSupersededPendingJobs(command.input);
        return;
      case 'activity': {
        const { corpId, userId, sessionId, timestamp } = command.input;
        await this.session.recordCandidateActivity(corpId, userId, sessionId, new Date(timestamp));
        return;
      }
    }
  }

  private async enqueue(command: Command, key: string): Promise<void> {
    const jobId = createHash('sha256').update(`${command.kind}:${key}`).digest('hex');
    try {
      await this.queue.add('apply', command, { ...CRITICAL_WRITE_JOB_OPTIONS, jobId });
    } catch (error) {
      await this.failures.report('reengagement.command_not_durable', command.kind, error);
      throw error;
    }
  }
}
