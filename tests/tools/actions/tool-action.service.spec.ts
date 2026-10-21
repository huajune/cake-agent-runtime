import { ToolActionService } from '@tools/actions/tool-action.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import type {
  ActionCallbacks,
  ActionExecution,
  ActionIntent,
  ActionMode,
} from '@biz/action-execution/action-execution.types';
import { createToolContext } from '../../helpers/tool-context.fixture';
import {
  spongeActionCompletion,
  toolActionIntent,
  unresolvedActionReceipt,
} from '@tools/actions/business-action.util';

const context = createToolContext({
  session: {
    corpId: 'corp',
    userId: 'user',
    sessionId: 'session',
    botUserId: 'bot-user',
    botImId: 'bot-im',
    logicalTurnId: 'logical-1',
    turnId: 'attempt-1',
    inputOccurredAt: '2026-10-21T01:00:00.000Z',
  },
});
const booking = { success: true, code: 0, message: 'ok', workOrderId: 42 };
const recovery = {
  userId: 'user',
  sessionId: 'session',
  botUserId: 'bot-user',
  botImId: 'bot-im',
  phone: '13800000000',
  jobId: 100,
  workOrderId: 42,
  candidateRef: 'person-1',
  formDigest: 'digest',
  identity: { name: '张三', phone: '13800000000', age: '25', gender: '男' },
};
const input = {
  kind: 'sponge.booking',
  target: 'booking:13800000000:100',
  parameters: { jobId: 100 },
  recovery,
};

describe('ToolActionService actual external boundary', () => {
  let mode: ActionMode;
  let savedIntent: ActionIntent;
  const sponge = { fetchSignupWorkOrders: jest.fn(), invalidateWorkOrderCache: jest.fn() };
  const longTerm = {
    setActiveBooking: jest.fn(),
    clearActiveBooking: jest.fn(),
    writeFromBooking: jest.fn(),
  };
  const session = { saveCompletedCollectionFacts: jest.fn(), getSessionState: jest.fn() };
  const phoneIndex = { record: jest.fn() };
  const forms = { markSubmittedIfUnchanged: jest.fn(), readPrimaryCandidateRef: jest.fn() };
  const snapshots = { invalidate: jest.fn() };
  const permits = { evaluate: jest.fn() };
  let registry: ActionRecoveryRegistry;
  const settled = jest.fn();
  const execute = jest.fn(
    async <T>(intent: ActionIntent, callbacks: ActionCallbacks<T>): Promise<ActionExecution<T>> => {
      savedIntent = intent;
      if (callbacks.authorize && !(await callbacks.authorize()))
        return {
          actionId: 'action',
          requestId: 'stable-request',
          status: 'blocked',
          localSync: 'complete',
          dispatched: false,
        };
      let completion;
      try {
        completion = await callbacks.dispatch('stable-request', mode);
      } catch {
        completion = {
          status: 'unknown' as const,
          evidence: { kind: 'indeterminate' as const, requestTerminated: false },
        };
      }
      // This double models the executor's commit-before-sync contract; the executor has its own DB tests.
      settled(completion);
      let localSync: 'complete' | 'pending' = 'complete';
      if (completion.status === 'succeeded' && callbacks.sync) {
        try {
          await callbacks.sync(completion.result);
        } catch {
          localSync = 'pending';
        }
      }
      return {
        actionId: 'action',
        requestId: 'stable-request',
        status: completion.status,
        result: 'result' in completion ? completion.result : undefined,
        evidence: completion.evidence,
        localSync,
        dispatched: true,
      };
    },
  );
  let service: ToolActionService;
  beforeEach(() => {
    jest.clearAllMocks();
    mode = 'execute';
    permits.evaluate.mockResolvedValue({ allowed: true });
    registry = new ActionRecoveryRegistry();
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      workOrders: [
        {
          workOrderId: 42,
          jobId: 100,
          currentStatus: '约面成功',
          interviewTime: '2026-10-23 14:00',
        },
      ],
    });
    sponge.invalidateWorkOrderCache.mockResolvedValue(undefined);
    longTerm.setActiveBooking.mockResolvedValue(undefined);
    longTerm.clearActiveBooking.mockResolvedValue(undefined);
    longTerm.writeFromBooking.mockResolvedValue(undefined);
    session.saveCompletedCollectionFacts.mockResolvedValue(undefined);
    session.getSessionState.mockResolvedValue({});
    forms.markSubmittedIfUnchanged.mockResolvedValue(true);
    forms.readPrimaryCandidateRef.mockResolvedValue('person-1');
    phoneIndex.record.mockResolvedValue(undefined);
    snapshots.invalidate.mockResolvedValue(undefined);
    service = new ToolActionService(
      { execute } as never,
      registry,
      sponge as never,
      longTerm as never,
      session as never,
      phoneIndex as never,
      forms as never,
      snapshots as never,
      permits as never,
    );
    service.onModuleInit();
  });

  it('preserves external success when local state read fails and never invokes provider again', async () => {
    const dispatch = jest.fn().mockResolvedValue(booking);
    sponge.fetchSignupWorkOrders.mockRejectedValue(new Error('read timeout'));
    const result = await service.executeSponge(context, input, dispatch);
    expect(result).toMatchObject({ status: 'succeeded', result: booking, localSync: 'pending' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
    expect(longTerm.setActiveBooking).not.toHaveBeenCalled();
  });
  it('rechecks the actual tool permission before a provider request', async () => {
    permits.evaluate.mockResolvedValue({ allowed: false, reason: 'hosting_paused' });
    const dispatch = jest.fn();
    expect(await service.executeSponge(context, input, dispatch)).toMatchObject({
      status: 'blocked',
      dispatched: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(permits.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tool', chatId: 'session', botImId: 'bot-im' }),
    );
  });

  it('preserves external success when a strict local write fails', async () => {
    longTerm.setActiveBooking.mockRejectedValue(new Error('write unavailable'));
    expect(await service.executeSponge(context, input, async () => booking)).toMatchObject({
      status: 'succeeded',
      localSync: 'pending',
    });
    expect(longTerm.setActiveBooking).toHaveBeenCalledWith('corp', 'user', 42, expect.anything(), {
      strict: true,
      occurredAt: context.session.inputOccurredAt,
    });
  });

  it('old booking repair sees cancellation and never resurrects active booking or submitted identity', async () => {
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      workOrders: [{ workOrderId: 42, jobId: 100, currentStatus: '已取消' }],
    });
    expect(await service.executeSponge(context, input, async () => booking)).toMatchObject({
      status: 'succeeded',
      localSync: 'complete',
    });
    expect(longTerm.clearActiveBooking).toHaveBeenCalledWith('corp', 'user', 42, { strict: true });
    expect(longTerm.setActiveBooking).not.toHaveBeenCalled();
    expect(forms.markSubmittedIfUnchanged).not.toHaveBeenCalled();
    expect(session.saveCompletedCollectionFacts).not.toHaveBeenCalled();
  });

  it('uses the current provider appointment when an old modification is repaired', async () => {
    await service.executeSponge(
      context,
      {
        ...input,
        kind: 'sponge.modify',
        target: 'work-order:42',
        parameters: { interviewTime: '2026-10-22 10:00' },
      },
      async () => booking,
    );
    expect(longTerm.setActiveBooking).toHaveBeenCalledWith(
      'corp',
      'user',
      42,
      { job_id: 100, interview_time: '2026-10-23 14:00' },
      { strict: true, occurredAt: context.session.inputOccurredAt },
    );
    expect(forms.markSubmittedIfUnchanged).not.toHaveBeenCalled();
  });
  it('does not declare cancellation repair complete while the provider projection is still active', async () => {
    const result = await service.executeSponge(
      context,
      { ...input, kind: 'sponge.cancel' },
      async () => booking,
    );
    expect(result).toMatchObject({ status: 'succeeded', localSync: 'pending' });
    expect(longTerm.setActiveBooking).not.toHaveBeenCalled();
    expect(longTerm.clearActiveBooking).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'])('does not recreate or overwrite %s form data', async () => {
    forms.markSubmittedIfUnchanged.mockResolvedValue(false);
    await service.executeSponge(context, input, async () => booking);
    expect(session.saveCompletedCollectionFacts).not.toHaveBeenCalled();
    expect(longTerm.writeFromBooking).not.toHaveBeenCalled();
  });

  it('does not restore an older person after the primary locator changed', async () => {
    forms.readPrimaryCandidateRef.mockResolvedValue('person-2');
    await service.executeSponge(context, input, async () => booking);
    expect(session.saveCompletedCollectionFacts).not.toHaveBeenCalled();
    expect(longTerm.writeFromBooking).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer identity fact', async () => {
    session.getSessionState.mockResolvedValue({
      facts: { interview_info: { name: { extractedAt: '2026-10-22T00:00:00Z' } } },
    });
    await service.executeSponge(context, input, async () => booking);
    expect(session.saveCompletedCollectionFacts).not.toHaveBeenCalled();
    expect(longTerm.writeFromBooking).not.toHaveBeenCalled();
  });

  it('completes primary identity with the original event time and account', async () => {
    await service.executeSponge(context, input, async () => booking);
    expect(session.saveCompletedCollectionFacts).toHaveBeenCalledWith(
      'corp',
      'user',
      'session',
      expect.objectContaining({
        name: expect.objectContaining({ extractedAt: context.session.inputOccurredAt }),
      }),
    );
    expect(savedIntent).toMatchObject({
      accountId: 'bot-im',
      logicalTurnId: 'logical-1',
      identityReliable: true,
    });
    expect(JSON.stringify(savedIntent)).not.toContain('token');
  });

  it('additional candidates never overwrite the contacting candidate identity or active pointer', async () => {
    await service.executeSponge(
      context,
      { ...input, recovery: { ...recovery, additional: true } },
      async () => booking,
    );
    expect(longTerm.setActiveBooking).not.toHaveBeenCalled();
    expect(session.saveCompletedCollectionFacts).not.toHaveBeenCalled();
    expect(forms.markSubmittedIfUnchanged).toHaveBeenCalled();
  });

  it('network timeout produces unknown evidence with no local writes', async () => {
    expect(
      await service.executeSponge(context, input, async () => {
        throw new Error('timeout');
      }),
    ).toMatchObject({ status: 'unknown', evidence: { requestTerminated: false } });
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
  });

  it('does not interpret current provider state as completion evidence for an unknown original request', async () => {
    const handler = registry.get('sponge.booking')!;
    expect(await handler.reconcile({ intent: input } as never)).toMatchObject({
      status: 'unknown',
      evidence: { requestTerminated: false },
    });
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
  });

  it.each(['off', 'observe', 'execute'] as const)(
    'message %s mode only supplies stable request ID in execute mode',
    async (selectedMode) => {
      mode = selectedMode;
      const dispatch = jest.fn().mockResolvedValue({ errcode: 0 });
      const result = await service.executeMessage(
        context,
        'message.location',
        'store:1',
        {},
        dispatch,
      );
      expect(dispatch).toHaveBeenCalledWith(
        selectedMode === 'execute' ? 'stable-request' : undefined,
      );
      expect(result).toMatchObject({
        status: 'succeeded',
        evidence: { kind: 'accepted', detail: 'send_request_accepted_not_read_receipt' },
      });
    },
  );

  it('message ambiguous response stays unknown', async () => {
    expect(
      await service.executeMessage(context, 'message.location', 'store:1', {}, async () => ({
        message: 'timeout',
      })),
    ).toMatchObject({ status: 'unknown' });
  });
});

describe('business action evidence and receipt', () => {
  it('requires provider business success evidence, not outer success alone', () => {
    expect(spongeActionCompletion({ ...booking, code: 500 })).toMatchObject({ status: 'unknown' });
    expect(
      spongeActionCompletion({ success: false, code: 500, message: 'parse failed' }),
    ).toMatchObject({ status: 'unknown' });
    expect(
      spongeActionCompletion({
        ...booking,
        success: false,
        duplicateSignupReason: 'already_registered',
      }),
    ).toMatchObject({
      status: 'failed',
      retryable: false,
      evidence: { kind: 'definitive_no_effect', requestTerminated: true },
    });
  });
  it('observation-only turn fallback is explicitly unreliable', () => {
    expect(
      toolActionIntent(createToolContext({ session: { turnId: 'attempt' } }), input),
    ).toMatchObject({ logicalTurnId: 'attempt', identityReliable: false });
  });
  it.each(['unknown', 'executing', 'blocked'] as const)(
    'does not report %s as failure or ask the model to retry',
    (status) => {
      const receipt = unresolvedActionReceipt(
        context,
        {
          actionId: 'action',
          requestId: 'request',
          status,
          localSync: 'complete',
          dispatched: false,
        },
        '取消',
        100,
        42,
      );
      expect(receipt).not.toHaveProperty('success');
      expect(receipt).toMatchObject({
        actionStatus: status,
        sideEffect: { kind: 'general_handoff', workOrderId: 42 },
      });
      expect(receipt._replyInstruction).toContain('禁止重试');
    },
  );
});
