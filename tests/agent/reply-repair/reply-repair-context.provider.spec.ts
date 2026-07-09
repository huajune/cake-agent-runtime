import { ReplyRepairContextProvider } from '@agent/reply-repair/reply-repair-context.provider';

describe('ReplyRepairContextProvider', () => {
  it('builds repair context from memory and group inventory without using generator preparation', async () => {
    const memory = {
      onTurnStart: jest.fn().mockResolvedValue({
        shortTerm: {
          messageWindow: [
            { role: 'user', content: '上海有餐饮兼职吗【消息发送时间：昨天】' },
            { role: 'assistant', content: '可以，我帮你看看' },
          ],
        },
        sessionMemory: {
          facts: {
            interview_info: {},
            preferences: {
              city: { value: '上海', confidence: 'high' },
            },
          },
          currentFocusJob: {
            jobId: 1,
            brandName: 'M Stand',
            jobName: '店员',
            storeName: '静安店',
            cityName: '上海',
            regionName: '静安',
            laborForm: '兼职',
            salaryDesc: '24元/小时',
            jobCategoryName: '餐饮',
          },
          presentedJobs: [],
          lastCandidatePool: [],
          invitedGroups: [
            {
              groupName: '上海餐饮兼职群',
              city: '上海',
              industry: '餐饮',
              invitedAt: '2026-07-09T10:00:00.000Z',
            },
          ],
        },
        highConfidenceFacts: null,
        procedural: { currentStage: 'job_consultation' },
        longTerm: {
          profile: { name: '候选人A' },
          preferences: null,
        },
      }),
    };
    const groupResolver = {
      resolveGroups: jest.fn().mockResolvedValue([
        {
          city: '上海',
          industry: '餐饮',
          groupName: '上海餐饮兼职群',
          imRoomId: 'r1',
          tag: '兼职群',
          imBotId: 'bot',
          token: 'token',
          memberCount: 12,
        },
      ]),
    };
    const config = { get: jest.fn().mockReturnValue('200') };
    const provider = new ReplyRepairContextProvider(
      memory as never,
      groupResolver as never,
      config as never,
    );

    const result = await provider.build({
      corpId: 'corp-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      currentUserMessage: '上海有餐饮兼职吗',
      shortTermEndTimeInclusive: 123,
    });

    expect(memory.onTurnStart).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1', '上海有餐饮兼职吗', {
      includeShortTerm: true,
      shortTermEndTimeInclusive: 123,
    });
    expect(result.recentMessages[0]).toEqual({ role: 'user', content: '上海有餐饮兼职吗' });
    expect(result.factLines).toContain('- 意向城市: 上海（置信度: high）');
    expect(result.jobLines[0]).toContain('静安店');
    expect(result.invitedGroupLines[0]).toContain('上海餐饮兼职群');
    expect(result.groupInventory).toEqual(
      expect.objectContaining({
        city: '上海',
        hasAnyGroup: true,
        lines: ['- 餐饮：1 个群（均有空位）'],
      }),
    );
  });
});
