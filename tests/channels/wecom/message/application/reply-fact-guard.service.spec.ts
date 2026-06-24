import { ReplyFactGuardService } from '@channels/wecom/message/application/reply-fact-guard.service';
import type { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';

describe('ReplyFactGuardService', () => {
  let service: ReplyFactGuardService;
  let notifier: { notifyContradiction: jest.Mock };

  beforeEach(() => {
    notifier = { notifyContradiction: jest.fn().mockResolvedValue(undefined) };
    service = new ReplyFactGuardService(notifier as unknown as ReplyFactGuardNotifierService);
  });

  const check = (replyText: string) =>
    service.check({ replyText, toolCalls: [], chatId: 'chat-1', userId: 'user-1' });

  describe('discriminatory_screening_leak', () => {
    const hitCases = [
      '这个岗位不要新疆西藏籍的，你报不了',
      '门店那边不收东北户籍，抱歉哈',
      '这家店仅限本地户口',
      '这个岗位只招上海籍',
      '岗位要求限汉族',
      '不好意思，门店不接受少数民族',
      '这个岗位有户籍要求，你可能不行',
      '你的户籍不符合门店要求，看看别的吧',
    ];
    it.each(hitCases)('flags and blocks discriminatory disclosure: %s', (reply) => {
      const result = check(reply);
      expect(result.hit).toBe(true);
      // 歧视类是阻断规则：调用方必须据 blocked=true 丢弃本轮回复
      expect(result.blocked).toBe(true);
      expect(result.contradictions.map((c) => c.ruleId)).toContain('discriminatory_screening_leak');
    });

    const passCases = [
      // 合规承接式收资话术（precheck 工具描述钦定口径）
      '哥方便问下是哪边人吗（公司这边登记需要核对下户籍信息）',
      // 收资模板里的中性字段行
      '姓名：\n联系方式：\n籍贯/户籍：\n年龄：',
      // 宣布"无限制"是合规的
      '这个岗位性别年龄不限，户籍也不限的',
      '这家对户籍没有要求，放心报名',
      // 催收资料场景误用"不要"
      '麻烦把籍贯发我一下哈，不要发错啦',
    ];
    it.each(passCases)('does not flag compliant phrasing: %s', (reply) => {
      const result = check(reply);
      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'discriminatory_screening_leak',
      );
    });

    it('fires feishu notification on hit with blocked label prefix', () => {
      const result = check('这个岗位不要新疆西藏籍的');
      expect(result.hit).toBe(true);
      expect(notifier.notifyContradiction).toHaveBeenCalledTimes(1);
      const payload = notifier.notifyContradiction.mock.calls[0][0] as {
        contradictions: Array<{ label: string }>;
      };
      expect(payload.contradictions[0].label).toContain('【已拦截，未发送给候选人】');
    });
  });

  describe('existing rules regression', () => {
    it('blocks proactive insurance policy mention when candidate did not ask', () => {
      const result = service.check({
        replyText: '这家早班 7:00-10:00，时薪 24 元，兼职岗位公司购买保险。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '24',
      });

      expect(result.hit).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('allows insurance policy answer when candidate explicitly asked this turn', () => {
      const result = service.check({
        replyText: '兼职岗位这里是意外险，不是五险一金，具体以门店入职通知为准。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '兼职也有保险吗？',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('flags group-full claim without invite_to_group call but does not block', () => {
      const result = check('不好意思，群里人数满了，拉不进去');
      expect(result.contradictions.map((c) => c.ruleId)).toContain('group_full_without_invite');
      // 常规规则仍是 Phase 1 告警语义，不触发出站短路
      expect(result.blocked).toBe(false);
    });

    it('does not flag plain reply', () => {
      const result = check('好的，时薪24元，明天面试记得带身份证');
      expect(result.hit).toBe(false);
    });
  });

  describe('candidate_name_echo (51 条新规则)', () => {
    it('flags addressing the candidate by a nickname found in contactName', () => {
      const result = service.check({
        replyText: '小晴你好，咱们这边有几个岗位很合适',
        toolCalls: [],
        contactName: '上海奥乐齐 小晴',
      });
      expect(result.contradictions.map((c) => c.ruleId)).toContain('candidate_name_echo');
      expect(result.blocked).toBe(false);
    });

    it('does not flag a plain greeting when the token is not in contactName', () => {
      const result = service.check({
        replyText: '你好，咱们这边有几个岗位很合适',
        toolCalls: [],
        contactName: '上海奥乐齐',
      });
      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('candidate_name_echo');
    });

    it('does not flag when contactName is absent', () => {
      const result = service.check({ replyText: '小晴你好', toolCalls: [] });
      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('candidate_name_echo');
    });
  });

  describe('distance_missing (51 条新规则)', () => {
    const jobListWithDistance = [
      {
        toolName: 'duliday_job_list',
        result: { result: [{ jobId: 1, storeName: '长白店', distanceKm: 2.3 }] },
      },
    ];

    it('flags a store recommendation that omits distance when recall had distanceKm', () => {
      const result = service.check({
        replyText: '给你推荐奥乐齐长白门店，待遇不错，要不要约面试',
        toolCalls: jobListWithDistance as never,
      });
      expect(result.contradictions.map((c) => c.ruleId)).toContain('distance_missing');
      expect(result.blocked).toBe(false);
    });

    it('does not flag when the reply already gives a distance', () => {
      const result = service.check({
        replyText: '给你推荐奥乐齐长白门店，离你2.3公里，要不要约面试',
        toolCalls: jobListWithDistance as never,
      });
      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('distance_missing');
    });

    it('does not flag when recall had no distanceKm', () => {
      const result = service.check({
        replyText: '给你推荐奥乐齐长白门店，要不要约面试',
        toolCalls: [
          { toolName: 'duliday_job_list', result: { result: [{ jobId: 1, storeName: '长白店' }] } },
        ] as never,
      });
      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('distance_missing');
    });
  });
});
