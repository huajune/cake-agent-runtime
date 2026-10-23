import { ConfigService } from '@nestjs/config';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import { identifyAction } from '@biz/action-execution/action-identity';
import type {
  ActionIntent,
  ActionRecord,
  ActionCompletion,
} from '@biz/action-execution/action-execution.types';
import {
  GroupTaskActionService,
  GroupTaskDeferredError,
} from '@biz/group-task/services/group-task-action.service';
import { GroupTaskType } from '@biz/group-task/group-task.types';
import type { Job } from 'bull';
import type { SendJobData } from '@biz/group-task/queue/group-task-queue.constants';

describe('Group task independently settled messages', () => {
  const states = new Map<string, ActionRecord>();
  const values = new Map<string, unknown>();
  const redis = {
    setNx: jest.fn(async (key, value) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    }),
    get: jest.fn(async (key) => values.get(key) ?? null),
    exists: jest.fn(async (key) => Number(values.has(key))),
    setex: jest.fn(async (key, _ttl, value) => {
      values.set(key, value);
    }),
  };
  let registry: ActionRecoveryRegistry;
  const queue = { getJob: jest.fn() };
  const brands = { recordPushedBrandOnce: jest.fn() };
  let service: GroupTaskActionService;
  let job: Job<SendJobData>;
  const parts = [
    { id: 'main', messageType: 7, payload: { text: 'original main' }, delayMs: 0 },
    { id: 'follow-up', messageType: 7, payload: { text: 'original follow-up' }, delayMs: 1 },
  ];
  const cache = { message: 'original main', summary: 'summary' };

  beforeEach(() => {
    registry = new ActionRecoveryRegistry();
    states.clear();
    values.clear();
    jest.clearAllMocks();
    const records = {
      prepare: jest.fn(async (intent: ActionIntent, mode) => {
        const identity = identifyAction(intent);
        const previous = states.get(identity.actionId);
        if (previous)
          return {
            record: previous,
            ...(previous.payloadHash !== identity.payloadHash
              ? { conflict: 'identity_payload_mismatch' }
              : {}),
          };
        const record: ActionRecord = {
          ...identity,
          intent,
          mode,
          status: 'registered',
          localSync: 'pending',
          owner: null,
          fence: 0,
          attempts: 0,
          result: null,
          retryable: false,
          nextCheckAt: null,
          recoveryDeadline: new Date(Date.now() + 86400_000).toISOString(),
          reviewRequired: false,
        };
        states.set(record.actionId, record);
        return { record };
      }),
      claim: jest.fn(async (record: ActionRecord, owner: string) => ({
        ...record,
        owner,
        dispatchAttemptId: owner,
        fence: record.fence + 1,
      })),
      settle: jest.fn(async (record: ActionRecord, completion: ActionCompletion<unknown>) => {
        const next = { ...record, ...completion, localSync: 'pending' as const };
        states.set(record.actionId, next);
        return next;
      }),
      markSynced: jest.fn(async (record: ActionRecord) => {
        states.set(record.actionId, { ...record, localSync: 'complete' });
      }),
      defer: jest.fn(),
      cancel: jest.fn().mockResolvedValue(true),
      validateClaim: jest.fn().mockResolvedValue(true),
    };
    const config = new ConfigService({
      ACTION_EXECUTION_MODE: 'execute',
      ACTION_EXECUTION_CUTOVER_AT: new Date(Date.now() - 86400_000).toISOString(),
    });
    const executor = new ActionExecutorService(records as never, config);
    service = new GroupTaskActionService(
      executor,
      registry,
      redis as never,
      brands as never,
      config,
      { getConfiguredBotList: async () => [{ wxid: 'bot', corpId: 'corp' }] } as never,
      queue as never,
    );
    job = {
      id: 'original-job',
      timestamp: Date.now(),
      data: {
        execId: 'exec',
        type: GroupTaskType.ORDER_GRAB,
        dryRun: false,
        groupKey: 'group',
        msgRedisKey: 'cache',
        execDate: '20261021',
        totalGroups: 1,
        sendDelayMs: 1,
        group: {
          imRoomId: 'room',
          imBotId: 'bot',
          chatId: 'chat',
          token: 'never-record-this',
          groupName: 'Group',
          city: 'City',
          tag: 'Tag',
        },
      },
      update: jest.fn(async () => undefined),
    } as unknown as Job<SendJobData>;
  });

  it('freezes original task time and payload before dispatch; changing prepare output does not replace it', async () => {
    await service.freezePlan(job, parts);
    const original = job.data.dispatchPlan;
    await service.freezePlan(job, [{ ...parts[0], payload: { text: 'changed' } }]);
    expect(job.data.dispatchPlan).toEqual(original);
    expect(original?.occurredAt).toBe(new Date(job.timestamp).toISOString());
    expect(JSON.stringify(original)).not.toContain('never-record-this');
  });

  it('after main success, an unknown follow-up cannot resend the main message or change payload', async () => {
    await service.freezePlan(job, parts);
    const sendMain = jest.fn().mockResolvedValue(undefined);
    const sendExtra = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(
      service.executePart(job, cache, parts[0], sendMain, async () => true),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    expect(sendMain).toHaveBeenCalledWith(expect.stringMatching(/^cake_/));
    const main = [...states.values()][0];
    states.set(main.actionId, {
      ...main,
      status: 'succeeded',
      result: { sent: true },
      evidence: { kind: 'completed', requestTerminated: true },
    });
    await service.executePart(job, cache, parts[0], sendMain, async () => true);
    await expect(
      service.executePart(job, cache, parts[1], sendExtra, async () => true),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    await service.executePart(job, cache, parts[0], sendMain, async () => true);
    await expect(
      service.executePart(job, cache, parts[1], sendExtra, async () => true),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    expect(sendMain).toHaveBeenCalledTimes(1);
    expect(sendExtra).toHaveBeenCalledTimes(1);
    await expect(
      service.executePart(
        job,
        cache,
        { ...parts[0], payload: { text: 'changed' } },
        sendMain,
        async () => true,
      ),
    ).rejects.toThrow('identity_payload_mismatch');
    expect(states.size).toBe(2);
  });

  it('keeps known external success while the local projection is unavailable', async () => {
    await service.freezePlan(job, parts);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    await expect(
      service.executePart(job, cache, parts[0], dispatch, async () => true),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    const main = [...states.values()][0];
    states.set(main.actionId, { ...main, status: 'succeeded', result: { sent: true } });
    redis.setex.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      service.executePart(job, cache, parts[0], dispatch, async () => true),
    ).resolves.toBeUndefined();
    expect(states.get(main.actionId)?.status).toBe('succeeded');
    expect(states.get(main.actionId)?.localSync).toBe('pending');
    await service.executePart(job, cache, parts[0], dispatch, async () => true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses a new remaining dispatch once the original task is stale', async () => {
    await service.freezePlan(job, parts);
    job.data.dispatchPlan!.occurredAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    const dispatch = jest.fn();
    await expect(
      service.executePart(job, cache, parts[0], dispatch, async () => true),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('recovery stops before each projection write if shared chat ownership is lost', async () => {
    service.onModuleInit();
    await service.freezePlan(job, [parts[0]]);
    await expect(
      service.executePart(
        job,
        cache,
        parts[0],
        async () => undefined,
        async () => true,
      ),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    const record = [...states.values()][0];
    const assertOwned = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('lease lost'));
    redis.setex.mockClear();
    await expect(
      registry.get('group_task.message')!.sync!(
        { ...record, status: 'succeeded' },
        { assertOwned },
      ),
    ).rejects.toThrow('lease lost');
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.setex.mock.calls[0][0]).toContain(':part:main');
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('confirmed callback repairs the projection and resumes only the original failed job', async () => {
    service.onModuleInit();
    await service.freezePlan(job, parts);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    await expect(
      service.executePart(job, cache, parts[0], dispatch, async () => true),
    ).rejects.toBeInstanceOf(GroupTaskDeferredError);
    const record = [...states.values()][0];
    const retry = jest.fn();
    queue.getJob.mockResolvedValue({ isFailed: async () => true, retry });
    const assertOwned = jest.fn();
    await registry.get('group_task.message')!.sync!(
      { ...record, status: 'succeeded' },
      { assertOwned },
    );
    expect(queue.getJob).toHaveBeenCalledWith('original-job');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
