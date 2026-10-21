import type { JobOptions, QueueOptions } from 'bull';

/** Defaults apply to every Redis connection. Individual jobs may narrow retry behavior. */
export const QUEUE_JOB_DEFAULTS: JobOptions = {
  attempts: 1,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 1000,
};

export const QUEUE_WORKER_SETTINGS: QueueOptions['settings'] = {
  stalledInterval: 30000,
  lockDuration: 60000,
  lockRenewTime: 15000,
  maxStalledCount: 2,
  guardInterval: 1000,
};

/** Safe only for idempotent local persistence / commands, never arbitrary external sends. */
export const CRITICAL_WRITE_JOB_OPTIONS: JobOptions = {
  ...QUEUE_JOB_DEFAULTS,
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
  removeOnFail: false,
};

/** Shared retention profiles preserve each queue's existing cap. */
export function retainedJobs(
  count: number,
  failedDays = 7,
): Pick<JobOptions, 'removeOnComplete' | 'removeOnFail'> {
  return {
    removeOnComplete: { age: 7 * 86400, count },
    removeOnFail: { age: failedDays * 86400, count },
  };
}

export const MESSAGE_MERGE_JOB_OPTIONS: JobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,
};

export const FOLLOW_UP_JOB_OPTIONS: JobOptions = {
  ...retainedJobs(500),
  attempts: 2,
  backoff: { type: 'fixed', delay: 30000 },
};
