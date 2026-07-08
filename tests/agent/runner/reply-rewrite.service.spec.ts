import { ReplyRewriteService } from '@agent/runner/reply-rewrite.service';
import { GuardrailReviewPacketBuilder } from '@agent/guardrail/output/llm/review-packet.builder';
import { ModelRole } from '@/llm/llm.types';

describe('ReplyRewriteService', () => {
  let llm: { generateSimple: jest.Mock };
  let service: ReplyRewriteService;

  beforeEach(() => {
    llm = {
      generateSimple: jest
        .fn()
        .mockResolvedValue('已帮你约好明天 14:00 面试，到店说独立客介绍就行。'),
    };
    service = new ReplyRewriteService(llm as never, new GuardrailReviewPacketBuilder());
  });

  it('uses the repair role with a focused text-rewrite prompt and grounded evidence', async () => {
    const result = await service.rewrite({
      userMessage: '那帮我约明天下午',
      originalReply: '约好了，到时候过去就行',
      violations: [
        {
          type: 'confirmed_booking_time_missing',
          evidence: 'booking 工具返回了确认时间，但回复漏掉',
          suggestion: '补充确认时间',
        },
      ],
      feedbackToGenerator: '把面试确认时间补进回复',
      ruleIds: ['confirmed_booking_time_missing'],
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: {},
          result: {
            success: true,
            workOrderId: 'wo-1',
            _confirmedInterviewTimeHuman: '明天 14:00',
            _onSiteScript: '到店说独立客介绍',
          },
        },
      ],
    });

    expect(result).toBe('已帮你约好明天 14:00 面试，到店说独立客介绍就行。');
    expect(llm.generateSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        role: ModelRole.Repair,
        systemPrompt: expect.stringContaining('你没有任何工具'),
        userMessage: expect.stringContaining('明天 14:00'),
      }),
    );
    const call = llm.generateSimple.mock.calls[0][0];
    expect(call.userMessage).toContain('confirmedInterviewTimeHuman');
    expect(call.userMessage).not.toContain('duliday_interview_booking(');
  });

  it('strips markdown fences from model output', async () => {
    llm.generateSimple.mockResolvedValueOnce('```text\n好的，我这边帮你改成更自然的说法。\n```');

    await expect(
      service.rewrite({
        originalReply: '生硬回复',
        violations: [{ type: 'bad_tone', evidence: '生硬', suggestion: '自然一点' }],
        ruleIds: ['bad_tone'],
        toolCalls: [],
      }),
    ).resolves.toBe('好的，我这边帮你改成更自然的说法。');
  });
});
