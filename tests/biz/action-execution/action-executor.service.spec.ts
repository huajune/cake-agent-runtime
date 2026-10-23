import { ConfigService } from '@nestjs/config';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecordsRepository } from '@biz/action-execution/action-records.repository';
import type { SupabaseService } from '@infra/supabase/supabase.service';
import type {
  ActionCompletion,
  ActionIntent,
  ActionRecord,
} from '@biz/action-execution/action-execution.types';
import { identifyAction } from '@biz/action-execution/action-identity';

const now = '2026-10-21T04:00:00.000Z';
const intent: ActionIntent = {
  corpId: 'test',
  accountId: 'account',
  chatId: 'chat',
  logicalTurnId: 'turn',
  intentId: 'turn',
  kind: 'booking',
  target: 'phone-job',
  parameters: { jobId: 1 },
  occurredAt: now,
  identityReliable: true,
};
const completion: ActionCompletion<{ workOrderId: number }> = {
  status: 'succeeded',
  result: { workOrderId: 123 },
  evidence: { kind: 'completed', externalId: '123', requestTerminated: true },
};

function setup(mode = 'execute', cutover: string | null = '2026-10-20T00:00:00Z') {
  let row: ActionRecord | null = null;
  const repository = {
    prepare: jest.fn(async (input: ActionIntent, requestedMode: ActionRecord['mode']) => {
      if (!row)
        row = {
          ...identifyAction(input),
          intent: input,
          mode: requestedMode,
          status: 'registered',
          localSync: 'complete',
          owner: null,
          fence: 0,
          attempts: 0,
          result: null,
          retryable: false,
          nextCheckAt: null,
          recoveryDeadline: '2026-10-22T04:00:00Z',
          reviewRequired: false,
        };
      return {
        record: { ...row },
        conflict:
          row.payloadHash !== identifyAction(input).payloadHash
            ? 'identity_payload_mismatch'
            : undefined,
      };
    }),
    claim: jest.fn(async (_record: ActionRecord, owner: string) => {
      if (!row || !['registered', 'failed'].includes(row.status)) return null;
      row = {
        ...row,
        status: 'executing',
        owner,
        fence: row.fence + 1,
        attempts: row.attempts + 1,
      };
      return { ...row };
    }),
    settle: jest.fn(async (_record: ActionRecord, result: ActionCompletion<unknown>) => {
      row = {
        ...row!,
        status: result.status,
        result: result.result,
        evidence: result.evidence,
        localSync: result.status === 'succeeded' ? 'pending' : 'complete',
      };
      return { ...row };
    }),
    markSynced: jest.fn(async () => {
      row = { ...row!, localSync: 'complete' };
    }),
    cancel: jest.fn(async () => true),
    validateClaim: jest.fn(async () => true),
  };
  const config = {
    get: (key: string, fallback?: string) =>
      key === 'ACTION_EXECUTION_MODE'
        ? mode
        : key === 'ACTION_EXECUTION_CUTOVER_AT'
          ? cutover
          : fallback,
  };
  return {
    repository,
    service: new ActionExecutorService(
      repository as unknown as ActionRecordsRepository,
      config as ConfigService,
    ),
    get: () => row,
    set: (value: ActionRecord) => {
      row = value;
    },
  };
}

describe('external action failure boundaries', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(now));
  });
  afterEach(() => jest.useRealTimers());

  it('never dispatches when registration is unconfirmed', async () => {
    const { service, repository } = setup();
    repository.prepare.mockRejectedValue(new Error('timeout after commit'));
    const dispatch = jest.fn();
    expect((await service.execute(intent, { dispatch })).status).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('never dispatches when claim is unconfirmed', async () => {
    const { service, repository } = setup();
    repository.claim.mockRejectedValue(new Error('ambiguous claim'));
    const dispatch = jest.fn();
    expect((await service.execute(intent, { dispatch })).status).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('allows only one dispatch across racing callers', async () => {
    const { service } = setup();
    const dispatch = jest.fn(async () => completion);
    await Promise.all([
      service.execute(intent, { dispatch }),
      service.execute(intent, { dispatch }),
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps external success when result and repair writeback fail, without calling business again', async () => {
    const { service, repository, get } = setup();
    repository.settle.mockRejectedValue(new Error('database down'));
    const dispatch = jest.fn(async () => completion);
    const sync = jest.fn();
    expect(await service.execute(intent, { dispatch, sync })).toMatchObject({
      status: 'succeeded',
      localSync: 'pending',
      result: { workOrderId: 123 },
    });
    expect(get()?.status).toBe('executing');
    expect(sync).not.toHaveBeenCalled();
    await service.execute(intent, { dispatch, sync });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('repairs local projections after success without repeating the external request', async () => {
    const { service, get } = setup();
    const dispatch = jest.fn(async () => completion);
    const sync = jest
      .fn()
      .mockRejectedValueOnce(new Error('projection down'))
      .mockResolvedValue(undefined);
    expect((await service.execute(intent, { dispatch, sync })).localSync).toBe('pending');
    expect(get()).toMatchObject({ status: 'succeeded', localSync: 'pending' });
    expect((await service.execute(intent, { dispatch, sync })).localSync).toBe('complete');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('treats timeout as unknown and prevents an outer retry', async () => {
    const { service } = setup();
    const dispatch = jest.fn().mockRejectedValue(new Error('timeout'));
    expect((await service.execute(intent, { dispatch })).status).toBe('unknown');
    expect((await service.execute(intent, { dispatch })).status).toBe('unknown');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps current goal satisfaction unresolved without authoritative request termination', async () => {
    const { service } = setup();
    const dispatch = jest.fn(async () => ({
      ...completion,
      evidence: {
        kind: 'already_satisfied' as const,
        goalSatisfied: true,
        requestTerminated: false,
      },
    }));
    expect((await service.execute(intent, { dispatch })).status).toBe('unknown');
  });
  it('rejects changed payload under the same intent', async () => {
    const { service } = setup();
    const dispatch = jest.fn(async () => completion);
    await service.execute(intent, { dispatch });
    expect(
      (await service.execute({ ...intent, parameters: { jobId: 2 } }, { dispatch })).reason,
    ).toBe('identity_payload_mismatch');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('rechecks authority after acquiring the dispatch claim', async () => {
    const { service } = setup();
    const dispatch = jest.fn();
    const authorize = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await service.execute(intent, { dispatch, authorize })).status).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not dispatch when the claim expires or its final confirmation fails', async () => {
    const { service, repository } = setup();
    repository.validateClaim.mockResolvedValue(false);
    const dispatch = jest.fn();
    expect((await service.execute(intent, { dispatch })).status).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('returns a blocked receipt for malformed identity instead of raising an outer tool retry', async () => {
    const { service } = setup();
    const dispatch = jest.fn();
    expect((await service.execute({ ...intent, accountId: '' }, { dispatch })).reason).toBe(
      'invalid_action_identity',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not promote observation evidence during cutover', async () => {
    const { service, set } = setup();
    const observed = setup('observe', null);
    await observed.service.execute(intent, { dispatch: async () => completion });
    set(observed.get()!);
    const dispatch = jest.fn();
    expect((await service.execute(intent, { dispatch })).status).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('retains old execute obligations when global mode is rolled back', async () => {
    const original = setup();
    await original.service.execute(intent, {
      dispatch: async () => {
        throw new Error('unknown');
      },
    });
    const rolledBack = setup('off');
    rolledBack.set(original.get()!);
    const dispatch = jest.fn();
    expect((await rolledBack.service.execute(intent, { dispatch })).status).toBe('unknown');
    expect(dispatch).not.toHaveBeenCalled();
    rolledBack.repository.prepare.mockRejectedValue(new Error('db unavailable'));
    expect((await rolledBack.service.execute(intent, { dispatch })).status).toBe('blocked');
  });
  it('fails closed for missing durable identity and old inputs', async () => {
    const { service } = setup();
    const dispatch = jest.fn();
    expect(
      (await service.execute({ ...intent, identityReliable: false }, { dispatch })).status,
    ).toBe('blocked');
    expect(
      (await service.execute({ ...intent, occurredAt: '2026-01-01T00:00:00Z' }, { dispatch }))
        .status,
    ).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('observes duplicates without changing dispatch decisions or provider mode', async () => {
    const { service } = setup('observe', null);
    const dispatch = jest.fn(async () => completion);
    await service.execute(intent, { dispatch });
    await service.execute(intent, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]).toEqual([identifyAction(intent).requestId, 'observe']);
  });

  it('gives a delayed reminder its frozen dispatch window while retaining the original input', async () => {
    const scheduled = {
      ...intent,
      occurredAt: '2026-10-14T04:00:00Z',
      recoveryWindowStartedAt: now,
    };
    const rpc = jest.fn(() => ({
      abortSignal: jest.fn().mockResolvedValue({ data: { record: null }, error: null }),
    }));
    const records = new ActionRecordsRepository({
      getSupabaseClient: () => ({ rpc }),
    } as unknown as SupabaseService);
    await records.prepare(scheduled, 'execute');
    expect(rpc).toHaveBeenCalledWith('transition_agent_action', {
      p_operation: 'prepare',
      p_input: expect.objectContaining({
        intent: scheduled,
        recoveryDeadline: '2026-10-22T04:00:00.000Z',
      }),
    });
    const { service } = setup('execute', '2026-10-01T00:00:00Z');
    expect((await service.execute(scheduled, { dispatch: async () => completion })).status).toBe(
      'succeeded',
    );
  });

  it('cannot reopen an unknown action by advancing its frozen window', async () => {
    const { service } = setup();
    const scheduled = { ...intent, recoveryWindowStartedAt: now };
    const dispatch = jest.fn().mockRejectedValue(new Error('ambiguous transport'));
    expect((await service.execute(scheduled, { dispatch })).status).toBe('unknown');
    jest.setSystemTime(new Date('2026-10-22T04:00:00Z'));
    expect(
      (
        await service.execute(
          { ...scheduled, recoveryWindowStartedAt: '2026-10-22T04:00:00Z' },
          { dispatch },
        )
      ).reason,
    ).toBe('identity_payload_mismatch');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid scheduled windows and preserves original cutover and retention checks', async () => {
    const { service, repository } = setup();
    const dispatch = jest.fn();
    for (const input of [
      { ...intent, recoveryWindowStartedAt: 'invalid' },
      { ...intent, recoveryWindowStartedAt: '2026-10-20T04:00:00Z' },
      { ...intent, recoveryWindowStartedAt: '2026-10-22T04:00:00Z' },
      { ...intent, occurredAt: '2026-10-19T04:00:00Z', recoveryWindowStartedAt: now },
      { ...intent, occurredAt: '2026-01-01T04:00:00Z', recoveryWindowStartedAt: now },
    ]) {
      expect((await service.execute(input, { dispatch })).status).toBe('blocked');
    }
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
