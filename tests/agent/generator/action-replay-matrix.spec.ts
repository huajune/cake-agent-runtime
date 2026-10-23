import {
  blocksReplay,
  buildSideEffectBlockNotice,
  computeToolCallStatus,
  findReplayBlockedSideEffectTools,
  isSideEffectCommitted,
  replayBlockingStatus,
} from '@agent/generator/tool-call-analysis';
import { resolveReplaySkipDecision } from '@agent/runner/turn-outcome';
import { STALE_INPUT_REASON_CODE } from '@tools/shared/tool-error-types';
import {
  boundedModelAttempts,
  RUNTIME_RETRY_LIMITS,
} from '@infra/config/constants/runtime-retry.constants';
import { MESSAGE_MERGE_JOB_OPTIONS } from '@infra/queue/queue-policy';
import { BUILT_IN_TOOL_CONTRACTS } from '@tools/tool-contracts';

const externalTools = [
  'duliday_interview_booking',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
  'send_store_location',
  'invite_to_group',
];
const states = [
  {
    result: { actionStatus: 'unknown', success: false, errorType: 'timeout' },
    committed: false,
    observed: 'unknown',
  },
  { result: { actionStatus: 'executing', success: true }, committed: false, observed: 'unknown' },
  {
    result: { actionStatus: 'blocked', actionDispatched: false, success: true },
    committed: false,
    observed: 'unknown',
  },
  {
    result: {
      actionStatus: 'succeeded',
      success: false,
      errorType: 'local_write_failed',
      localSync: 'pending',
    },
    committed: true,
    observed: 'ok',
  },
  {
    result: { success: false, groupInvite: { actionStatus: 'unknown' } },
    committed: false,
    observed: 'unknown',
  },
];

describe('external action replay fault matrix', () => {
  it.each(externalTools.flatMap((toolName) => states.map((state) => ({ toolName, ...state }))))(
    '$toolName / $result blocks retries without fabricating success',
    ({ toolName, result, committed, observed }) => {
      const steps = [{ toolResults: [{ toolName, output: result }] }];
      expect(blocksReplay({ toolName, result })).toBe(true);
      expect(findReplayBlockedSideEffectTools(steps)).toEqual([toolName]);
      expect(isSideEffectCommitted(result)).toBe(committed);
      expect(computeToolCallStatus(result, undefined)).toBe(observed);
      const notice = buildSideEffectBlockNotice([toolName], steps);
      if (!committed) expect(notice).not.toContain('已成功执行');
    },
  );

  it('booking success does not make an unknown post-booking invitation successful', () => {
    const result = { actionStatus: 'succeeded', groupInvite: { actionStatus: 'unknown' } };
    expect(isSideEffectCommitted(result)).toBe(true); // booking really happened
    expect(replayBlockingStatus(result)).toBe('unknown');
    expect(
      buildSideEffectBlockNotice(
        ['duliday_interview_booking'],
        [{ toolResults: [{ toolName: 'duliday_interview_booking', output: result }] }],
      ),
    ).not.toContain('本轮已成功执行');
  });

  it.each(['succeeded', 'unknown', 'executing', 'blocked'])(
    'stale-input abort cannot erase prior %s evidence',
    (actionStatus) => {
      const calls = [
        { toolName: 'send_store_location', result: { actionStatus } },
        {
          toolName: 'duliday_interview_booking',
          result: {
            staleInput: true,
            reasonCode: STALE_INPUT_REASON_CODE,
            errorType: 'stale_input',
            success: false,
          },
        },
      ];
      const decision = resolveReplaySkipDecision(undefined, calls as never);
      expect(decision.skip).toBe(true);
      expect(decision.blockingTools).toEqual(['send_store_location']);
      expect(resolveReplaySkipDecision(undefined, [calls[1]] as never).skip).toBe(false);
    },
  );

  it('definite no-effect failure retains correction; its outer success flag cannot commit it', () => {
    const result = { actionStatus: 'failed', success: true };
    expect(blocksReplay({ toolName: 'duliday_interview_booking', result })).toBe(false);
    expect(isSideEffectCommitted(result)).toBe(false);
    expect(
      findReplayBlockedSideEffectTools([
        { toolResults: [{ toolName: 'duliday_interview_booking', output: result }] },
      ]),
    ).toEqual([]);
  });

  it('all eight layers keep their existing ceilings and contracts read the shared limits', () => {
    expect(RUNTIME_RETRY_LIMITS).toEqual({
      crashJobAttempts: 3,
      crashStalledRecoveries: 2,
      pendingInputReplays: 3,
      imageCompatibilityRetries: 1,
      outputRepairRetries: 1,
      textualToolRetries: 1,
      emptyZeroToolRetries: 1,
      modelAttempts: 3,
      sameToolCalls: 3,
      precheckCalls: 2,
      deliverySegmentRetries: 1,
    });
    expect(MESSAGE_MERGE_JOB_OPTIONS.attempts).toBe(3);
    expect(BUILT_IN_TOOL_CONTRACTS.duliday_interview_precheck.maxCallsPerTurn).toBe(2);
    expect(BUILT_IN_TOOL_CONTRACTS.send_store_location.replay).toBe('block_on_success');
    expect([1, 2, 3, 5, Infinity, NaN, -1].map(boundedModelAttempts)).toEqual([
      1, 2, 3, 3, 3, 3, 1,
    ]);
  });
});
