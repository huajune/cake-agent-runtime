import { ReplyFactGuardService } from '@channels/wecom/message/application/reply-fact-guard.service';
import type { AgentToolCall } from '@/types/agent-telemetry.types';

describe('ReplyFactGuardService', () => {
  const replyFactGuardNotifier = {
    notifyContradiction: jest.fn(),
  };

  let service: ReplyFactGuardService;

  beforeEach(() => {
    jest.clearAllMocks();
    replyFactGuardNotifier.notifyContradiction.mockResolvedValue(true);
    service = new ReplyFactGuardService(replyFactGuardNotifier as never);
  });

  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  const makeInviteCall = (overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
    toolName: 'invite_to_group',
    args: {},
    status: 'ok',
    result: { success: true },
    ...overrides,
  });

  it('returns hit=false when reply has no group-full-related keywords', async () => {
    const result = service.check({
      replyText: '好的，我帮你登记下面试时间。',
      toolCalls: [],
      chatId: 'chat-1',
    });

    expect(result).toEqual({ hit: false, contradictions: [] });
    expect(replyFactGuardNotifier.notifyContradiction).not.toHaveBeenCalled();
  });

  it('returns hit=false when reply claims group full AND invite_to_group succeeded this turn (legit)', async () => {
    // 即使有"群人数满"这种描述，只要本轮 invite_to_group 真正成功，可视为合理
    // —— 但 phase 1 规则故意更保守：成功调用即放行
    const result = service.check({
      replyText: '不好意思群已满',
      toolCalls: [makeInviteCall()],
      chatId: 'chat-1',
    });

    expect(result).toEqual({ hit: false, contradictions: [] });
    expect(replyFactGuardNotifier.notifyContradiction).not.toHaveBeenCalled();
  });

  it('flags contradiction when reply says 群已满 but no invite_to_group this turn', async () => {
    const result = service.check({
      replyText: '不好意思哈，刚确认了下目前群里人数满了，邀请暂时发不过去。',
      toolCalls: [],
      chatId: 'chat-1',
      userId: 'user-1',
      botImId: 'bot-1',
      botUserName: 'mgr-bob',
    });

    expect(result.hit).toBe(true);
    expect(result.contradictions).toEqual([
      expect.objectContaining({ ruleId: 'group_full_without_invite' }),
    ]);

    await flushAsync();
    expect(replyFactGuardNotifier.notifyContradiction).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        botImId: 'bot-1',
        botUserName: 'mgr-bob',
        replyPreview: expect.stringContaining('群里人数满了'),
        contradictions: expect.arrayContaining([
          expect.objectContaining({ ruleId: 'group_full_without_invite' }),
        ]),
        toolNames: [],
      }),
    );
  });

  it('flags contradiction when reply promises 拉群/群里通知 but no invite_to_group success this turn (badcase gay6j94c 同类)', async () => {
    const result = service.check({
      replyText: '行，那我拉你进咱们餐饮兼职群，后面有合适的岗位我直接群里通知你。',
      toolCalls: [],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(true);
    expect(result.contradictions[0].ruleId).toBe('group_promise_without_invite');
  });

  it('does NOT flag future-tense follow-up "群里通知" when candidate is presumed already in group', async () => {
    // false-positive 防回归：候选人已经在群里时，Agent 婉拒当前岗位自然带出
    // "后续合适的我在群里通知你"，本轮无需也不该再调 invite_to_group。
    // 强承诺（拉/加/进...群、发群邀请）才要求本轮拉群兜底。
    const result = service.check({
      replyText: '虹口区目前的岗位年龄都在20岁以上，暂时不匹配。后续有合适的我在群里通知你。',
      toolCalls: [],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(false);
  });

  it('does NOT flag "你看群里有人感兴趣吗" when Agent asks candidate to forward jobs to their own group', async () => {
    // false-positive 防回归：候选人想做差价中介，Agent 婉拒并改口让候选人在自己的群里
    // 转发岗位信息（"你有群的话我把岗位发你"），跟 invite_to_group 完全无关。
    const result = service.check({
      replyText:
        '这种赚差价的模式不太行哈，我们这边都是品牌直招。不过你有群的话，我把昌平的岗位发你，大家直接报名也挺方便。你看群里有人感兴趣吗？',
      toolCalls: [
        { toolName: 'duliday_job_list', args: {}, status: 'ok', result: { success: true } },
      ],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(false);
  });

  it('does NOT flag promise when invite_to_group success backs it', async () => {
    const result = service.check({
      replyText: '我拉你进群了，后面有合适的群里通知你。',
      toolCalls: [makeInviteCall()],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(false);
  });

  it('flags contradiction when invite_to_group was called but failed this turn (no success)', async () => {
    // 真实场景：invite_to_group 返回 reason: 'no_group_in_city'，本轮文本不应再说"群已满"
    const result = service.check({
      replyText: '帮你看了下，群已解散了，下次有合适的再通知你。',
      toolCalls: [
        makeInviteCall({
          status: 'unknown',
          result: { success: false, reason: 'no_group_in_city' },
        }),
      ],
      chatId: 'chat-1',
    });

    expect(result.hit).toBe(true);
    expect(result.contradictions[0].ruleId).toBe('group_full_without_invite');
  });

  it('does not throw when reply is empty', async () => {
    const result = service.check({ replyText: '', toolCalls: [] });
    expect(result).toEqual({ hit: false, contradictions: [] });
  });

  it('does not throw if ops notifier alert rejects (fire-and-forget)', async () => {
    replyFactGuardNotifier.notifyContradiction.mockRejectedValue(new Error('feishu down'));

    const result = service.check({
      replyText: '群已满了',
      toolCalls: [],
      chatId: 'chat-1',
    });

    expect(result.hit).toBe(true);
    await flushAsync();
    // 不应抛
  });

  describe('booking_form_field_mismatch (badcase 67o8y2ez)', () => {
    const makePrecheckCall = (
      requiredFields: string[],
      overrides: { starterFields?: string[]; missingFields?: string[] } = {},
    ): AgentToolCall => ({
      toolName: 'duliday_interview_precheck',
      args: {},
      status: 'ok',
      result: {
        bookingChecklist: {
          requiredFieldsToCollectNow: requiredFields,
          missingFields: overrides.missingFields ?? requiredFields,
          collectionStrategy: overrides.starterFields
            ? { mode: 'progressive', starterFields: overrides.starterFields }
            : { mode: 'all_at_once' },
        },
      },
    });

    it('flags missing field when reply form drops a precheck-required field', () => {
      // 67o8y2ez 实景：precheck 要"过往工作经验"，Agent 模板把它换成"应聘门店/面试时间"
      const replyText = [
        '先将以下资料补充下发给我，我来帮你约面试：',
        '',
        '姓名：',
        '联系方式：',
        '性别：',
        '年龄：',
        '学历：',
        '应聘门店：',
        '面试时间：',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [
          makePrecheckCall(['姓名', '联系方式', '性别', '年龄', '学历', '过往工作经验']),
        ],
        chatId: 'chat-1',
      });

      expect(result.hit).toBe(true);
      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeDefined();
      expect(mismatch?.label).toContain('过往工作经验');
    });

    it('passes when reply contains all precheck-required fields (extra fields are tolerated)', () => {
      const replyText = [
        '姓名：',
        '电话：',
        '年龄：',
        '学历：',
        '过往经历：',
        '应聘门店：',
        '面试时间：',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '联系电话', '年龄', '学历', '过往工作经验'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('uses starterFields when precheck has降级 progressive strategy', () => {
      const replyText = ['姓名：', '电话：', '年龄：'].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [
          makePrecheckCall(
            ['姓名', '联系电话', '年龄', '学历', '健康证情况'],
            { starterFields: ['姓名', '联系电话', '年龄'] },
          ),
        ],
        chatId: 'chat-1',
      });

      // reply 收齐了 starterFields 三项就够，不该告警漏"学历/健康证"
      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag short replies without a form-like field block', () => {
      // 单行说明 "时薪：24" 不该被当成收资模板
      const result = service.check({
        replyText: '基础时薪：24 元/时，做满 40 小时升 26。',
        toolCalls: [makePrecheckCall(['姓名', '联系电话', '年龄'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag when precheck was not called this turn', () => {
      // 没调 precheck 时不约束（用户可能复用之前轮次的字段）
      const replyText = ['姓名：', '电话：', '年龄：', '学历：'].join('\n');
      const result = service.check({ replyText, toolCalls: [], chatId: 'chat-1' });

      expect(result.hit).toBe(false);
    });
  });

  describe('salary_fabrication (badcase aalxnd77 / zt98hgy3)', () => {
    const makeJobListCall = (overrides: {
      holidayType?: string;
      overtimeType?: string;
    } = {}): AgentToolCall => ({
      toolName: 'duliday_job_list',
      args: {},
      status: 'ok',
      result: {
        rawData: {
          result: [
            {
              jobSalary: {
                salaryScenarioList: [
                  {
                    basicSalary: { basicSalary: 24, basicSalaryUnit: '元/时' },
                    holidaySalary: { holidaySalaryType: overrides.holidayType ?? '无薪资' },
                    overtimeSalary: { overtimeSalaryType: overrides.overtimeType ?? '无薪资' },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    it('flags fabrication when reply claims 节假日双倍 but tool has no holiday salary', () => {
      const result = service.check({
        replyText: '这家薪资是 24 元/时，节假日双倍。',
        toolCalls: [makeJobListCall()],
        chatId: 'chat-1',
      });

      expect(result.hit).toBe(true);
      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeDefined();
    });

    it('flags fabrication when reply says 周末加薪 but tool has no holiday salary', () => {
      const result = service.check({
        replyText: '基础时薪 24 元，周末加薪。',
        toolCalls: [makeJobListCall()],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeDefined();
    });

    it('flags fabrication when reply says 薪资面议', () => {
      const result = service.check({
        replyText: '这家店薪资面议，到店谈。',
        toolCalls: [makeJobListCall()],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeDefined();
    });

    it('flags fabrication for 工资按表现浮动', () => {
      const result = service.check({
        replyText: '24 元起步，工资按表现浮动。',
        toolCalls: [makeJobListCall()],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeDefined();
    });

    it('passes when reply truthfully describes holiday salary that exists in tool result', () => {
      const result = service.check({
        replyText: '节假日薪资按 2 倍算，平时 24 元/时。',
        toolCalls: [makeJobListCall({ holidayType: '多倍薪资' })],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeUndefined();
    });

    it('does not flag when no duliday_job_list was called this turn (Agent may relay prior turn facts)', () => {
      const result = service.check({
        replyText: '这家薪资节假日不一样，是浮动的。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeUndefined();
    });

    it('does not flag plain salary descriptions without fabrication phrases', () => {
      const result = service.check({
        replyText: '这家时薪 24 元，做满 40 小时涨到 26，月结。',
        toolCalls: [makeJobListCall()],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'salary_fabrication');
      expect(hit).toBeUndefined();
    });
  });
});
