import { Test, type TestingModule } from '@nestjs/testing';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ActionRecordsRepository } from '@biz/action-execution/action-records.repository';
import type {
  ActionCompletion,
  ActionIntent,
  ActionRecord,
} from '@biz/action-execution/action-execution.types';
import { RuntimePostgresClientFixture } from '../../helpers/runtime-postgres-client.fixture';

const completion: ActionCompletion<{ workOrderId: number }> = {
  status: 'succeeded',
  result: { workOrderId: 42 },
  evidence: { kind: 'completed', requestTerminated: true },
};

const intent = (): ActionIntent => ({
  corpId: 'attempt-test',
  accountId: 'account',
  chatId: 'chat',
  logicalTurnId: 'turn',
  intentId: 'turn',
  kind: 'booking',
  target: 'work-order:42',
  parameters: { jobId: 1 },
  occurredAt: new Date().toISOString(),
  identityReliable: true,
});

describe('original dispatch identity is required for evidence', () => {
  let module: TestingModule;
  let records: ActionRecordsRepository;
  const client = { rpc: jest.fn(), from: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    module = await Test.createTestingModule({
      providers: [
        ActionRecordsRepository,
        { provide: SupabaseService, useValue: { getSupabaseClient: () => client } },
      ],
    }).compile();
    records = module.get(ActionRecordsRepository);
  });

  afterEach(async () => module.close());

  it('anchors the recovery deadline to the original input rather than preparation time', async () => {
    const input = { ...intent(), occurredAt: '2026-10-21T04:00:00.000Z' };
    client.rpc.mockReturnValue({
      abortSignal: jest.fn().mockResolvedValue({ data: { record: null }, error: null }),
    });
    await records.prepare(input, 'execute');
    expect(client.rpc).toHaveBeenCalledWith('transition_agent_action', {
      p_operation: 'prepare',
      p_input: expect.objectContaining({
        intent: input,
        recoveryDeadline: '2026-10-22T04:00:00.000Z',
      }),
    });
  });

  it.each([null, undefined, '', '   '])(
    'does not use the current lease owner when dispatchAttemptId is %p',
    async (dispatchAttemptId) => {
      // A serialized old/corrupt repair job is a runtime input, not a typed producer.
      const record = {
        intent: intent(),
        actionId: 'action',
        owner: 'reconciliation-owner',
        fence: 2,
        dispatchAttemptId,
      } as ActionRecord;
      await expect(records.terminalEvidence(record)).rejects.toThrow(
        'Original action dispatch attempt is required',
      );
      await expect(records.settle(record, completion)).rejects.toThrow(
        'Original action dispatch attempt is required',
      );
      await expect(records.validateClaim(record)).rejects.toThrow(
        'Original action dispatch attempt is required',
      );
      expect(client.from).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );
});

const container = process.env.CAKE_ACTION_TEST_CONTAINER;
const database = process.env.CAKE_ACTION_TEST_DATABASE;
const isolated = container && database ? describe : describe.skip;

isolated('dispatch attempt identity with actual PostgreSQL', () => {
  let module: TestingModule;
  let records: ActionRecordsRepository;
  let client: RuntimePostgresClientFixture;

  beforeAll(async () => {
    if (!database?.startsWith('cake_projection_action_attempts_'))
      throw new Error('Use a disposable action_attempts database');
    client = new RuntimePostgresClientFixture(container!, database);
    module = await Test.createTestingModule({
      providers: [
        ActionRecordsRepository,
        { provide: SupabaseService, useValue: { getSupabaseClient: () => client } },
      ],
    }).compile();
    records = module.get(ActionRecordsRepository);
  });

  beforeEach(() => client.query('TRUNCATE public.agent_action_records CASCADE;'));
  afterAll(async () => module?.close());

  it('keeps registered and cancelled actions without a fabricated dispatch attempt', async () => {
    const prepared = (await records.prepare(intent(), 'execute')).record!;
    expect(prepared.dispatchAttemptId).toBeNull();
    expect(await records.cancel(prepared)).toBe(true);
    expect(
      client.query(`SELECT row_to_json(a) FROM (
        SELECT status,dispatch_attempt_id,attempts FROM public.agent_action_records
        WHERE corp_id='attempt-test'
      ) a;`),
    ).toEqual({ status: 'cancelled', dispatch_attempt_id: null, attempts: 0 });
  });

  it('accepts a late result only for the original attempt after the recovery owner changes', async () => {
    const prepared = (await records.prepare(intent(), 'execute')).record!;
    const dispatched = (await records.claim(prepared, 'dispatch-original'))!;
    expect(dispatched.dispatchAttemptId).toBe('dispatch-original');
    expect(await records.validateClaim(dispatched)).toBe(true);
    client.query(`UPDATE public.agent_action_records SET next_check_at=now()-interval '1 second'
      WHERE corp_id='attempt-test';`);
    const recovered = (await records.claim(dispatched, 'reconciliation-owner', true))!;
    expect(recovered.owner).toBe('reconciliation-owner');
    expect(recovered.dispatchAttemptId).toBe('dispatch-original');
    expect(await records.validateClaim(dispatched)).toBe(false);

    // The old worker can append its result, but cannot overwrite the new owner's state.
    expect((await records.settle(dispatched, completion)).status).toBe('unknown');
    client.query(`INSERT INTO public.agent_action_evidence
      (corp_id,action_id,attempt_id,evidence_hash,completion)
      SELECT corp_id,action_id,'reconciliation-owner','wrong-attempt',
        '{"status":"failed","retryable":false,"evidence":{"kind":"definitive_no_effect","requestTerminated":true}}'::jsonb
      FROM public.agent_action_records WHERE corp_id='attempt-test';`);
    expect(await records.terminalEvidence(recovered)).toEqual({ completion, conflicting: false });

    const settled = await records.settle(recovered, completion);
    await records.markSynced(settled);
    expect(settled.dispatchAttemptId).toBe(dispatched.dispatchAttemptId);
    expect(settled.requestId).toBe(dispatched.requestId);
    expect(
      client.query(`SELECT row_to_json(a) FROM (
        SELECT status,local_sync,dispatch_attempt_id,owner,
          (SELECT count(*) FROM public.agent_action_evidence
           WHERE corp_id='attempt-test' AND attempt_id='dispatch-original') AS original_evidence
        FROM public.agent_action_records WHERE corp_id='attempt-test'
      ) a;`),
    ).toEqual({
      status: 'succeeded',
      local_sync: 'complete',
      dispatch_attempt_id: 'dispatch-original',
      owner: 'reconciliation-owner',
      original_evidence: 1,
    });
  });
});
