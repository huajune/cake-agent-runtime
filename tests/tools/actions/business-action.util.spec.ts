import { unresolvedActionReceipt } from '@tools/actions/business-action.util';
import type { ToolBuildContext } from '@shared-types/tool.types';
import type { ActionExecution } from '@biz/action-execution/action-execution.types';

describe('unresolved action handoff receipt', () => {
  it.each(['unknown', 'blocked'] as const)('keeps %s separate from completed handoff', (status) => {
    const receipt = unresolvedActionReceipt(
      { session: { botImId: 'bot' }, archive: {} } as ToolBuildContext,
      {
        status,
        actionId: 'a',
        dispatched: status === 'unknown',
        localSync: 'complete',
      } as ActionExecution<unknown>,
      '报名',
    );
    expect(receipt.actionStatus).toBe(status);
    expect(receipt.sideEffect).toMatchObject({ kind: 'general_handoff', recordHandoff: true });
    expect(receipt._replyInstruction).toContain('人工意图尚不代表通知或暂停已经完成');
    expect(receipt._replyInstruction).toContain('会请同事');
    expect(receipt._outcome).not.toMatch(/已转人工|已暂停/);
  });
});
