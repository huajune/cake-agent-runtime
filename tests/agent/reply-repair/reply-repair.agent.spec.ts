import { ReplyRepairAgent } from '@agent/reply-repair/reply-repair.agent';
import { GuardrailReviewPacketBuilder } from '@agent/guardrail/output/llm/review-packet.builder';
import { ModelRole } from '@/llm/llm.types';

describe('ReplyRepairAgent', () => {
  let llm: { generate: jest.Mock };
  let service: ReplyRepairAgent;

  beforeEach(() => {
    llm = {
      generate: jest.fn().mockResolvedValue({
        text: '已帮你约好明天 14:00 面试，到店说独立客介绍就行。',
      }),
    };
    service = new ReplyRepairAgent(llm as never, new GuardrailReviewPacketBuilder());
  });

  it('uses the repair role with a focused text repair prompt and grounded evidence', async () => {
    const result = await service.repair({
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
      repairContext: {
        recentMessages: [
          { role: 'user', content: '上海有餐饮兼职吗' },
          { role: 'assistant', content: '可以，我帮你看看' },
        ],
        factLines: ['城市：上海', '意向行业：餐饮'],
        profileLines: [],
        longTermPreferenceLines: [],
        currentStage: 'job_consultation',
        jobLines: [],
        invitedGroupLines: ['- 上海餐饮兼职群（上海/餐饮，邀请于 2026-07-09）'],
        groupInventory: {
          city: '上海',
          hasAnyGroup: true,
          lines: ['- 餐饮：1 个群（均有空位）'],
        },
      },
    });

    expect(result).toBe('已帮你约好明天 14:00 面试，到店说独立客介绍就行。');
    expect(llm.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: ModelRole.Repair,
        system: expect.stringContaining('你没有任何工具'),
      }),
    );
    const call = llm.generate.mock.calls[0][0];
    // 待修草稿 + 接地材料 + 策略全部进 system（渲染后，无裸 JSON 内部键名）
    expect(call.system).toContain('# 待修复的草稿回复');
    expect(call.system).toContain('约好了，到时候过去就行');
    expect(call.system).toContain('确认面试时间：明天 14:00');
    expect(call.system).toContain('修复上下文');
    expect(call.system).toContain('上海餐饮兼职群');
    expect(call.system).toContain('餐饮：1 个群');
    expect(call.system).toContain('出站策略');
    expect(call.system).not.toContain('confirmedInterviewTimeHuman');
    expect(call.system).not.toContain('duliday_interview_booking(');
    // 真实对话历史走 messages 槽，不再塞进 system
    expect(call.messages).toEqual([
      { role: 'user', content: '上海有餐饮兼职吗' },
      { role: 'assistant', content: '可以，我帮你看看' },
    ]);
    expect(call.system).not.toContain('## 近期对话');
  });

  it('strips markdown fences from model output', async () => {
    llm.generate.mockResolvedValueOnce({
      text: '```text\n好的，我这边帮你改成更自然的说法。\n```',
    });

    await expect(
      service.repair({
        originalReply: '生硬回复',
        violations: [{ type: 'bad_tone', evidence: '生硬', suggestion: '自然一点' }],
        ruleIds: ['bad_tone'],
        toolCalls: [],
      }),
    ).resolves.toBe('好的，我这边帮你改成更自然的说法。');
  });
});
