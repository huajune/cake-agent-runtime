import {
  ordinaryReplyEffects,
  readOrdinaryReplyEffects,
} from '@channels/wecom/message/application/ordinary-reply-effects';
import { TurnFinalizer } from '@agent/runner/turn-finalizer';

describe('ordinary reply local facts', () => {
  it('keeps work-order outcomes without persisting reply text, arguments or unrelated tools', () => {
    const effects = ordinaryReplyEffects(
      [
        {
          toolName: 'duliday_interview_booking',
          args: { phone: 'private' },
          result: { success: true, workOrderId: 42, name: 'private' },
        },
        { toolName: 'duliday_job_list', args: {}, result: { content: 'unrelated' } },
      ],
      {
        traceId: 'trace',
        logicalTurnId: 'turn',
        inputOccurredAt: '2026-11-06T01:00:00Z',
        corpId: 'corp',
        userId: 'user',
        chatId: 'chat',
      },
    );
    expect(readOrdinaryReplyEffects(effects).toolCalls).toEqual([
      {
        toolName: 'duliday_interview_booking',
        args: {},
        result: { success: true, workOrderId: 42 },
      },
    ]);
    expect(JSON.stringify(effects)).not.toContain('private');
    expect(JSON.stringify(effects)).not.toContain('unrelated');
  });

  it('projects only accepted text and never the full generated remainder', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const finalizer = TurnFinalizer.from(run);
    finalizer.settle({ delivered: true, acceptedText: 'first accepted segment' });
    finalizer.settle({ delivered: true, acceptedText: 'must not replace earlier fact' });
    await finalizer.whenSettled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      includeAssistantText: true,
      assistantTextOverride: 'first accepted segment',
    });
  });
});
