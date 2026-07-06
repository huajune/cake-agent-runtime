import { HardRulesService } from '@agent/guardrail/output/hard-rules.service';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { AgentToolCall } from '@/types/agent-telemetry.types';
import type { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';

describe('HardRulesService', () => {
  let service: HardRulesService;
  let notifier: { notifyContradiction: jest.Mock };

  beforeEach(() => {
    notifier = { notifyContradiction: jest.fn().mockResolvedValue(undefined) };
    service = new HardRulesService(notifier as unknown as ReplyFactGuardNotifierService);
  });

  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  const makeInviteCall = (overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
    toolName: 'invite_to_group',
    args: {},
    status: 'ok',
    result: { success: true },
    ...overrides,
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
      // 专业类筛选条件外露（badcase 2026-07-06：与籍贯/民族同样处理）
      '专业不是新媒体或食品相关的吧？',
      '你不会是食品相关专业吧',
      '这家不招新媒体或食品相关专业',
      '岗位有专业限制，你这个专业不符',
      '筛选项：专业（非新媒、食品）',
    ];
    it.each(hitCases)('flags and blocks discriminatory disclosure: %s', (reply) => {
      const result = check(reply);
      expect(result.hit).toBe(true);
      // 歧视类是阻断规则：调用方必须据 blocked=true 丢弃本轮回复
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(true);
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
      // 专业的合规开放式核对与形容词用法
      '方便说下你学的什么专业吗？',
      '不要紧张，我们有专业的带教团队',
      '我们很专业，不是中介哈',
      '这个岗位专业不限，放心报',
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

    it('silent（advisory）：命中仍返回裁决，但不 fire 飞书告警', () => {
      const result = service.check({
        replyText: '这个岗位不要新疆西藏籍的',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        silent: true,
      });
      expect(result.hit).toBe(true);
      expect(result.contradictions.map((c) => c.ruleId)).toContain('discriminatory_screening_leak');
      expect(notifier.notifyContradiction).not.toHaveBeenCalled();
    });
  });

  describe('existing rules regression', () => {
    it('replans concrete job recommendations that are not grounded by duliday_job_list', () => {
      const result = service.check({
        replyText:
          '📣 推荐对话用模板\n\nM Stand-北京海淀大悦城店-店员-兼职\n距离：0.2km\n班次：早班07:00-15:00 / 晚班15:00-23:00\n薪资：25元/小时\n要求：18-35岁，有餐饮经验优先\n\n这两家都在海淀大悦城，离你很近，你看哪个更合适？',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
      });

      expect(result.hit).toBe(true);
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.REPLAN)).toBe(true);
      expect(result.contradictions.map((c) => c.ruleId)).toContain('ungrounded_job_recommendation');
    });

    it('allows concrete job recommendations when duliday_job_list grounded them this turn', () => {
      const result = service.check({
        replyText:
          'M Stand-北京海淀大悦城店-店员-兼职\n距离：0.2km\n班次：早班07:00-15:00 / 晚班15:00-23:00\n薪资：25元/小时\n要求：18-35岁，有餐饮经验优先',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: { result: [{ jobId: 1, distanceKm: 0.2 }] },
            resultCount: 1,
            status: 'ok',
          },
        ] as never,
        chatId: 'chat-1',
        userId: 'user-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'ungrounded_job_recommendation',
      );
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
    });

    it('uses the latest job-list result when checking whether job facts are grounded', () => {
      const result = service.check({
        replyText:
          'M Stand-北京海淀大悦城店-店员-兼职\n距离：0.2km\n班次：早班07:00-15:00\n薪资：25元/小时\n要求：18-35岁',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: { result: [{ jobId: 1, distanceKm: 0.2 }] },
            resultCount: 1,
            status: 'ok',
          },
          {
            toolName: 'duliday_job_list',
            args: {},
            result: { result: [], errorType: 'job_list.empty' },
            resultCount: 0,
            status: 'empty',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'ungrounded_job_recommendation',
            action: GUARDRAIL_ACTION.REPLAN,
          }),
        ]),
      );
    });

    it('does not block short historical salary follow-up without a fresh job-list call', () => {
      const result = check('好的，时薪24元，明天面试记得带身份证');

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'ungrounded_job_recommendation',
      );
    });

    it('blocks internal output leak before delivery (badcase vllg7hlu)', () => {
      const result = check('阶段已切换到 job_consultation，等待候选人回复年龄信息。');

      expect(result.hit).toBe(true);
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(true);
      expect(result.contradictions.map((c) => c.ruleId)).toContain('internal_output_leak');
    });

    // 上线首日（2026-07-03）：repair 以 toolMode:'none' 重写时模型把工具调用写成文本，
    // 以下三种形态穿透旧词库真实发给了候选人，必须全部拦住。
    it.each([
      [
        'JSON 数组工具调用',
        '[{"name":"geocode","arguments":{"address":"深圳市龙华区","city":"深圳"}},{"name":"duliday_job_list","arguments":{"cityNameList":["深圳"]}}]',
      ],
      ['元组式工具调用', '["geocode", {"city": "上海", "address": "静安区"}]'],
      [
        'tool_call 标签',
        '<tool_call>\n{"name": "duliday_job_list", "arguments": {"cityNameList":["上海"]}}\n</tool_call>',
      ],
      ['方括号工具名回显', '[duliday_job_list]\njson\n{"cityNameList": ["上海"]}'],
      ['自然语言夹带工具名', '稍等哈，我用 geocode 帮你定位一下。'],
    ])('blocks tool-call artifact leaked as reply text: %s', (_shape, reply) => {
      const result = check(reply);

      expect(result.hit).toBe(true);
      expect(result.contradictions.map((c) => c.ruleId)).toContain('internal_output_leak');
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(true);
    });

    it('does not flag a normal reply that starts with a bracketed Chinese note', () => {
      const result = check('【面试提醒】明天上午10点百联奥特莱斯店面试，别迟到哈。');

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('internal_output_leak');
    });

    it('blocks proactive insurance policy mention when candidate did not ask', () => {
      const result = service.check({
        replyText: '这家早班 7:00-10:00，时薪 24 元，兼职岗位公司购买保险。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '24',
      });

      expect(result.hit).toBe(true);
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(true);
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

    it('allows insurance answer when candidate asked in a recent turn (跨轮豁免)', () => {
      const result = service.check({
        replyText: '这个岗位公司不购买社保哈，是雇主责任险。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '第一个',
        recentUserTexts: ['这个岗位交社保吗？', '第一个'],
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('still blocks proactive insurance mention when recent turns never asked', () => {
      const result = service.check({
        replyText: '兼职岗位公司购买保险，放心。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '多少钱一小时',
        recentUserTexts: ['有夜班吗', '多少钱一小时'],
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('allows insurance terms in requirement context (第二职业资格预筛，上线首日青岛哈根达斯误伤)', () => {
      const result = service.check({
        replyText:
          '青岛这边目前有两个哈根达斯的兼职岗位在招。不过这两个岗位都要求是"第二职业"，需要提供第一份工作的劳动合同和社保证明。你有交本地社保的工作吗？',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '山东青岛',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('still blocks when reply mixes requirement context with a benefit promise', () => {
      const result = service.check({
        replyText: '这个岗位需要提供社保证明。另外公司还给你买五险一金，福利很好。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '好的',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('blocks 签合同+五险一金 benefit promise (bare 合同 must not trigger requirement exemption)', () => {
      const result = service.check({
        replyText: '转正后签合同，公司给你交五险一金，福利很好。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '好的',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('blocks 给你交社保 benefit promise (qualification exemption requires 你有…交…社保 question form)', () => {
      const result = service.check({
        replyText: '放心，公司给你交社保的。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '多少钱一小时',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('blocks legacy platform brand name in outbound reply', () => {
      const result = check('到店说是独立日介绍来的就行。');

      expect(result.hit).toBe(true);
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(true);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'brand_name_violation',
            action: GUARDRAIL_ACTION.BLOCK,
          }),
        ]),
      );
    });

    it('blocks job brand name mismatch against this-turn job_list result', () => {
      const result = service.check({
        replyText: '麦当劳（静安寺店）- 服务员，距离2公里，时薪24元。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: {
              result: [
                {
                  jobId: 1,
                  brandName: '肯德基',
                  storeName: '静安寺店',
                  distanceKm: 2,
                },
              ],
            },
            resultCount: 1,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.hit).toBe(true);
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(true);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'brand_name_violation',
            action: GUARDRAIL_ACTION.BLOCK,
          }),
        ]),
      );
    });

    it('allows grounded job brand name from this-turn job_list result', () => {
      const result = service.check({
        replyText: '肯德基（静安寺店）- 服务员，距离2公里，时薪24元。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: {
              result: [
                {
                  jobId: 1,
                  brandName: '肯德基',
                  storeName: '静安寺店',
                  distanceKm: 2,
                },
              ],
            },
            resultCount: 1,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('brand_name_violation');
    });

    it('replans when requested brand is replaced by another brand recommendation', () => {
      const result = service.check({
        replyText: '麦当劳（静安寺店）- 服务员，距离2公里，时薪24元。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { brandAliasList: ['肯德基'] },
            result: {
              result: [
                {
                  jobId: 1,
                  brandName: '麦当劳',
                  storeName: '静安寺店',
                  distanceKm: 2,
                },
              ],
            },
            resultCount: 1,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'requested_brand_mismatch',
            action: GUARDRAIL_ACTION.REPLAN,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not flag requested brand mismatch when asking before alternative brands', () => {
      const result = service.check({
        replyText: '暂时没有这个品牌的岗位，你看其它品牌可以接受吗？',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { brandAliasList: ['肯德基'] },
            result: { result: [] },
            resultCount: 0,
            status: 'empty',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('requested_brand_mismatch');
    });

    it('asks for revision when high-confidence brand alias fuzzy match is ignored', () => {
      const result = service.check({
        replyText: '刘姐妹这个品牌暂时没找到在招岗位，我先帮你看看别的。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { brandAliasList: ['刘姐妹'] },
            result: {
              result: [],
              aliasFuzzyMatch: {
                confidence: 'high',
                suggestions: [{ inputAlias: '刘姐妹', brandName: '成都你六姐', score: 8 }],
              },
            },
            resultCount: 0,
            status: 'empty',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'brand_alias_fuzzy_match_ignored',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('still flags high-confidence brand alias when the suggested brand is named in a no-match claim', () => {
      const result = service.check({
        replyText: '成都你六姐这个品牌暂时没找到在招岗位，我先帮你看看别的。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { brandAliasList: ['刘姐妹'] },
            result: {
              result: [],
              aliasFuzzyMatch: {
                confidence: 'high',
                suggestions: [{ inputAlias: '刘姐妹', brandName: '成都你六姐', score: 8 }],
              },
            },
            resultCount: 0,
            status: 'empty',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'brand_alias_fuzzy_match_ignored',
      );
    });

    it('asks for revision when a farther store is recommended while a much closer store exists', () => {
      const result = service.check({
        replyText: '推荐你去肯德基南京西路店，距离3.8公里，薪资24元。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: {
              result: [
                {
                  _distanceKm: 0.5,
                  basicInfo: {
                    brandName: '肯德基',
                    jobName: '服务员',
                    storeInfo: { storeName: '静安寺店' },
                  },
                },
                {
                  _distanceKm: 3.8,
                  basicInfo: {
                    brandName: '肯德基',
                    jobName: '服务员',
                    storeInfo: { storeName: '南京西路店' },
                  },
                },
              ],
            },
            resultCount: 2,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'farther_job_recommended',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not flag farther store recommendation when reply explains the distance tradeoff', () => {
      const result = service.check({
        replyText: '静安寺店更近但班次不匹配，推荐你去肯德基南京西路店，距离3.8公里。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: {},
            result: {
              result: [
                {
                  _distanceKm: 0.5,
                  basicInfo: {
                    brandName: '肯德基',
                    jobName: '服务员',
                    storeInfo: { storeName: '静安寺店' },
                  },
                },
                {
                  _distanceKm: 3.8,
                  basicInfo: {
                    brandName: '肯德基',
                    jobName: '服务员',
                    storeInfo: { storeName: '南京西路店' },
                  },
                },
              ],
            },
            resultCount: 2,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('farther_job_recommended');
    });

    it('asks for revision when schedule-filtered job list is followed by a recommendation', () => {
      const result = service.check({
        replyText: '这家门店可以做晚班，我帮你预约面试。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { candidateScheduleConstraint: { onlyEvenings: true } },
            result: {
              success: false,
              errorType: 'job_list.schedule_filter_empty',
              details: {
                queryMeta: {
                  scheduleFilter: {
                    applied: true,
                    excludedCount: 3,
                  },
                },
              },
            },
            status: 'error',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'schedule_filtered_job_recommended',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('allows compliant no-match wording after schedule filter emptied the list', () => {
      const result = service.check({
        replyText: '目前没有符合晚班时段的岗位，你看是否可以放宽一下时间？',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { candidateScheduleConstraint: { onlyEvenings: true } },
            result: {
              success: false,
              errorType: 'job_list.schedule_filter_empty',
            },
            status: 'error',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'schedule_filtered_job_recommended',
      );
    });

    it('asks for revision when group-full claim is not grounded by invite_to_group', () => {
      const result = check('不好意思，群里人数满了，拉不进去');
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'group_full_without_invite',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not flag plain reply', () => {
      const result = check('好的，时薪24元，明天面试记得带身份证');
      expect(result.hit).toBe(false);
    });

    it('blocks quota promise wording', () => {
      const hitCases = ['名额还有很多，不用急', '名额放心，我帮你留着', '你的名额还在，跑不掉'];
      for (const reply of hitCases) {
        const result = check(reply);
        expect(result.contradictions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ ruleId: 'quota_promise', action: GUARDRAIL_ACTION.BLOCK }),
          ]),
        );
      }
    });

    it('does not flag compliant quota-uncertainty wording (裸"名额还"不构成承诺)', () => {
      const passCases = [
        '名额还在不在我这边没法保证哈，建议证一到手马上找我约',
        '你的名额还在不在我说不准，尽快哈',
        '名额还没确定，我帮你问下门店',
      ];
      for (const reply of passCases) {
        const result = check(reply);
        expect(result.contradictions.map((c) => c.ruleId)).not.toContain('quota_promise');
      }
    });

    it('asks for revision when reply fabricates system/network status', () => {
      const result = check('系统同步有点问题，我这边稍后再帮你预约。');

      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'system_status_fabrication',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('asks for revision when wait-notice job still asks candidate to choose interview time', () => {
      const result = service.check({
        replyText: '这家可以约，你看哪天下午方便面试？我帮你登记。',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            status: 'ok',
            result: {
              nextAction: 'collect_fields',
              interview: {
                interviewTimeMode: 'wait_notice',
                interviewTimeModeNote: '该岗位不需要收集面试时间，面试官会电话联系候选人。',
              },
            },
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'wait_notice_time_collection',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('allows compliant wait-notice wording that says interviewer will call', () => {
      const result = service.check({
        replyText: '这个岗位不用约具体面试时间，资料提交后面试官会电话联系你，保持电话畅通就行。',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            status: 'ok',
            result: {
              nextAction: 'collect_fields',
              interview: {
                interviewTimeMode: 'wait_notice',
              },
            },
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'wait_notice_time_collection',
      );
    });

    it('asks for revision when reply generalizes job duties from industry common sense', () => {
      const result = check('餐饮岗位一般都要洗碗和打扫，能接受的话我帮你约面试。');

      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'work_content_generalization',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('asks for revision when collection form misses precheck-required fields', () => {
      const result = service.check({
        replyText: [
          '先将以下资料补充下发给我，我来帮你约面试：',
          '',
          '姓名：',
          '联系方式：',
          '性别：',
          '年龄：',
          '学历：',
          '应聘门店：',
          '面试时间：',
        ].join('\n'),
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            status: 'ok',
            result: {
              bookingChecklist: {
                requiredFieldsToCollectNow: [
                  '姓名',
                  '联系方式',
                  '性别',
                  '年龄',
                  '学历',
                  '过往工作经验',
                ],
                missingFields: ['姓名', '联系方式', '性别', '年龄', '学历', '过往工作经验'],
                collectionStrategy: { mode: 'all_at_once' },
              },
            },
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'booking_form_field_mismatch',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('asks for revision when salary policy is not grounded by job salary facts', () => {
      const result = service.check({
        replyText: '这家薪资是 24 元/时，节假日双倍。',
        toolCalls: [
          {
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
                          holidaySalary: { holidaySalaryType: '无薪资' },
                          overtimeSalary: { overtimeSalaryType: '无薪资' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'salary_fabrication',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('uses the latest job-list result when validating salary policy claims', () => {
      const result = service.check({
        replyText: '这家薪资是 24 元/时，节假日双倍。',
        toolCalls: [
          {
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
                          holidaySalary: { holidaySalaryType: '固定薪资', salary: 48 },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
          {
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
                          holidaySalary: { holidaySalaryType: '无薪资' },
                          overtimeSalary: { overtimeSalaryType: '无薪资' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('salary_fabrication');
    });

    it('asks for revision when reply uses image facts without saving image description', () => {
      const result = service.check({
        replyText: '图片里是健康证，我看到了，可以继续帮你报名。',
        userMessage: '[图片 messageId=img-1]',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'image_description_not_saved',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('allows image-grounded reply when image description was saved', () => {
      const result = service.check({
        replyText: '图片里是健康证，我看到了，可以继续帮你报名。',
        userMessage: '[图片 messageId=img-1]',
        toolCalls: [
          {
            toolName: 'save_image_description',
            args: { messageId: 'img-1', description: '健康证，持有人张三' },
            result: { success: true },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'image_description_not_saved',
      );
    });

    it('asks for revision when current user message already provided booking fields but reply repeats them', () => {
      const result = service.check({
        userMessage: '张三，男，28岁，电话13800138000，本科，有健康证，明天下午可以面试',
        replyText: ['请补充以下报名资料：', '姓名：', '电话：', '年龄：', '性别：'].join('\n'),
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'provided_booking_fields_ignored',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not flag when reply only asks for fields not provided in current user message', () => {
      const result = service.check({
        userMessage: '张三，男，28岁，电话13800138000，本科，明天下午可以面试',
        replyText: '收到，还差健康证情况和过往工作经验，方便补充一下吗？',
        toolCalls: [],
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'provided_booking_fields_ignored',
      );
    });
  });

  describe('side-effect output grounding', () => {
    it('asks for revision when booking failed but reply claims appointment success', () => {
      const result = service.check({
        replyText: '已帮你预约成功，明天10点到店面试，记得带身份证。',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { success: false, errorType: 'booking.rejected' },
            status: 'error',
          },
        ] as never,
        chatId: 'chat-1',
        userId: 'user-1',
      });

      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'tool_failure_success_claim',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('does not flag tool failure success claim when the latest side-effect call succeeded', () => {
      const result = service.check({
        replyText: '已帮你预约成功，明天10点到店面试，记得带身份证。',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { success: false, errorType: 'booking.rejected' },
            status: 'error',
          },
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: {
              success: true,
              _confirmedInterviewTimeHuman: '明天10点',
              _onSiteScript: '到店后说是来面试服务员岗位的。',
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'tool_failure_success_claim',
      );
    });

    it('asks for revision when invite failed but reply claims group invite was sent', () => {
      const result = service.check({
        replyText: '入群邀请已经发你了，后续群里会同步通知。',
        toolCalls: [
          {
            toolName: 'invite_to_group',
            args: {},
            result: { success: false, errorType: 'invite.group_full' },
            status: 'error',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'tool_failure_success_claim',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('asks for revision when confirmed booking time is missing from success reply', () => {
      const result = service.check({
        replyText: '已帮你预约成功，到店记得带身份证。',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: {
              success: true,
              _confirmedInterviewTimeHuman: '2026年7月2日 14:00',
              _onSiteScript: '到店后说是来面试服务员岗位的。',
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'confirmed_booking_time_missing',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not require a concrete time for wait-notice booking success', () => {
      const result = service.check({
        replyText: '报名资料已提交成功，面试官会电话联系你确认，请保持电话畅通。',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: {
              success: true,
              _confirmedInterviewTimeHuman: '未指定面试时间：面试官会直接电话联系候选人确认',
              _waitNoticeReplyGuide:
                '该岗位不选面试时间。告知候选人报名资料已提交成功，面试官会直接打电话联系。',
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'confirmed_booking_time_missing',
      );
    });

    it('asks for revision when on-site script is missing from successful offline booking reply', () => {
      const result = service.check({
        replyText: '已帮你预约成功，7月2日14:00到店面试，记得带身份证。',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: {
              success: true,
              _confirmedInterviewTimeHuman: '2026年7月2日 14:00',
              _onSiteScript: '到店跟前台/店长说"独立客招聘介绍来的，姓名 张三，应聘 服务员"',
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'confirmed_booking_onsite_script_missing',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not flag successful booking reply that repeats the on-site script', () => {
      const result = service.check({
        replyText:
          '已帮你预约成功，7月2日14:00到店面试。到店跟前台/店长说是独立客招聘介绍来的，报姓名张三，应聘服务员。',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: {
              success: true,
              _confirmedInterviewTimeHuman: '2026年7月2日 14:00',
              _onSiteScript: '到店跟前台/店长说"独立客招聘介绍来的，姓名 张三，应聘 服务员"',
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'confirmed_booking_onsite_script_missing',
      );
    });

    it('asks for revision when precheck blocked booking but reply still says it can be booked', () => {
      const result = service.check({
        replyText: '这个岗位可以约，我先帮你安排面试。',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            result: {
              nextAction: 'age_rejected',
              ageBoundary: { severity: 'hard_reject' },
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'precheck_blocked_booking_claim',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('asks for revision when requested date is unavailable but reply still claims bookable', () => {
      const result = service.check({
        replyText: '可以约的，我帮你报名。',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            result: { nextAction: 'date_unavailable' },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'precheck_blocked_booking_claim',
      );
    });

    it('does not flag the normal collect_fields pitch "填一下资料我帮你约面" (上线首日 batch_6a475a42…935 误伤)', () => {
      const result = service.check({
        replyText:
          '没有健康证没关系哈，先面试就行，录用后上岗前再去办也不迟。你把下面信息填一下发我，我帮你预约面试。',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            result: {
              nextAction: 'collect_fields',
              healthCertGate: 'before_onboard',
              ageBoundary: { severity: 'unknown' },
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'precheck_blocked_booking_claim',
      );
    });

    it('does not flag bookable claim while precheck asks to confirm date (confirm_date 是推进态)', () => {
      const result = service.check({
        replyText: '可以约的，这几天都有场次，你想约哪天？',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            result: { nextAction: 'confirm_date' },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'precheck_blocked_booking_claim',
      );
    });

    it('asks for revision when wait_notice precheck is followed by a concrete interview time', () => {
      const result = service.check({
        replyText: '明天10点到店面试，面试官会联系你。',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: {},
            result: {
              nextAction: 'ready_to_book',
              interview: { interviewTimeMode: 'wait_notice' },
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'wait_notice_time_fabrication',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('asks for revision when geocode is ambiguous but reply makes a nearby-job decision', () => {
      const result = service.check({
        replyText: '我看了下你这边附近暂无合适岗位，后续有了再通知你。',
        toolCalls: [
          {
            toolName: 'geocode',
            args: { address: '万达广场' },
            result: {
              success: false,
              errorType: 'geocode.ambiguous_suffix',
              _replyInstruction: '先中性反问候选人所在城市。',
            },
            status: 'error',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'geocode_uncertain_location_claim',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('does not flag a clarification question after ambiguous geocode', () => {
      const result = service.check({
        replyText: '这个万达广场在多个城市都有，你这边主要在哪个城市呀？',
        toolCalls: [
          {
            toolName: 'geocode',
            args: { address: '万达广场' },
            result: {
              resolution: 'ambiguous',
              candidates: [{ city: '上海市' }, { city: '南京市' }],
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'geocode_uncertain_location_claim',
      );
    });

    it('asks for revision when ambiguous geocode candidates are not listed in clarification', () => {
      const result = service.check({
        replyText: '这个万达广场在多个城市都有，你这边主要在哪个城市呀？',
        toolCalls: [
          {
            toolName: 'geocode',
            args: { address: '万达广场' },
            result: {
              resolution: 'ambiguous',
              candidates: [{ city: '上海市' }, { city: '南京市' }, { city: '苏州市' }],
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'geocode_ambiguous_candidates_omitted',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('allows ambiguous geocode clarification that lists candidate cities', () => {
      const result = service.check({
        replyText: '这个万达广场有多个城市，是上海的，还是南京的？',
        toolCalls: [
          {
            toolName: 'geocode',
            args: { address: '万达广场' },
            result: {
              resolution: 'ambiguous',
              candidates: [{ city: '上海市' }, { city: '南京市' }],
            },
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'geocode_ambiguous_candidates_omitted',
      );
    });

    it('asks for revision when request_handoff found no booking but reply claims handoff or cancellation', () => {
      const result = service.check({
        replyText: '已帮你取消并转人工处理，后续会有人联系你。',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'modify_appointment' },
            result: {
              dispatched: false,
              errorType: 'handoff.no_booking',
              details: { shortCircuited: false },
            },
            status: 'error',
          },
        ] as never,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'handoff_no_booking_claim',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('asks for revision on strong group invite promise without successful invite_to_group', () => {
      const result = service.check({
        replyText: '我先拉你进群，后续群里会同步通知。',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'group_promise_without_invite',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('does not treat "already invited" as historical context without an explicit past-time anchor', () => {
      const result = service.check({
        replyText: '已经拉你进群了，后续群里会同步通知。',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'group_promise_without_invite',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
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
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
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
      expect(result.contradictions.some((c) => c.action === GUARDRAIL_ACTION.BLOCK)).toBe(false);
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

  describe('group invite edge cases', () => {
    it('returns hit=false when reply has no group-full-related keywords', async () => {
      const result = service.check({
        replyText: '好的，我帮你登记下面试时间。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(result).toEqual({ hit: false, contradictions: [] });
      expect(notifier.notifyContradiction).not.toHaveBeenCalled();
    });

    it('returns hit=false when reply claims group full AND invite_to_group succeeded this turn (legit)', async () => {
      const result = service.check({
        replyText: '不好意思群已满',
        toolCalls: [makeInviteCall()],
        chatId: 'chat-1',
      });

      expect(result).toEqual({ hit: false, contradictions: [] });
      expect(notifier.notifyContradiction).not.toHaveBeenCalled();
    });

    it('flags contradiction when reply says 群已满 but no invite_to_group this turn', async () => {
      const result = service.check({
        replyText: '不好意思哈，刚确认了下目前群里人数满了，邀请暂时发不过去。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        traceId: 'trace-1',
        contactName: '候选人A',
        botImId: 'bot-1',
        botUserName: 'mgr-bob',
      });

      expect(result.hit).toBe(true);
      expect(result.contradictions).toEqual([
        expect.objectContaining({ ruleId: 'group_full_without_invite' }),
      ]);

      await flushAsync();
      expect(notifier.notifyContradiction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          traceId: 'trace-1',
          contactName: '候选人A',
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

    it('flags contradiction when reply promises 拉群/群里通知 but no invite_to_group success this turn', async () => {
      const result = service.check({
        replyText: '行，那我拉你进咱们餐饮兼职群，后面有合适的岗位我直接群里通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(true);
      expect(result.contradictions[0].ruleId).toBe('group_promise_without_invite');
    });

    it('does NOT flag conditional invite questions before the candidate agrees', async () => {
      const result = service.check({
        replyText:
          '附近这几家餐饮目前对学生身份卡得都比较紧。你看是让我继续帮你留意其他能接学生的门店，还是先拉你进群，后面有合适的我直接通知你?',
        toolCalls: [
          { toolName: 'duliday_job_list', args: {}, status: 'ok', result: { success: true } },
        ],
        chatId: 'chat-1',
      });

      expect(result.hit).toBe(false);
      expect(notifier.notifyContradiction).not.toHaveBeenCalled();
    });

    it('does NOT flag future-tense follow-up "群里通知" when candidate is presumed already in group', async () => {
      // 强承诺（拉/加/进...群、发群邀请）才要求本轮拉群兜底，普通后续通知不算
      const result = service.check({
        replyText: '虹口区目前的岗位年龄都在20岁以上，暂时不匹配。后续有合适的我在群里通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag "你看群里有人感兴趣吗" when Agent asks candidate to forward jobs to their own group', async () => {
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

    it('does NOT flag "发个入群邀请，你看行行？" as conditional offer before candidate confirms', async () => {
      // pre-action 询问，不是已完成承诺（同类 gay6j94c 误报防回归）
      const result = service.check({
        replyText:
          '北京通州和朝阳这边暂时没有特别匹配的兼职岗位，我先给你发个入群邀请，你看行行？群里有更新我第一时间通知你。',
        toolCalls: [
          { toolName: 'geocode', args: {}, status: 'ok', result: {} },
          { toolName: 'duliday_job_list', args: {}, status: 'ok', result: {} },
        ],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag "我也可以拉你进群" as capability statement', async () => {
      const result = service.check({
        replyText:
          '通州这边有两个合适的岗位，你看感兴趣哪家。另外我也可以拉你进咱们餐饮兼职群，有新岗位我会第一时间通知你。',
        toolCalls: [{ toolName: 'duliday_job_list', args: {}, status: 'ok', result: {} }],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag past-tense "之前已经拉你进群了" (referencing prior action, not this turn)', async () => {
      const result = service.check({
        replyText: '之前已经拉你进上海餐饮群了，后续有合适的我会直接在群里通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag past-tense "之前拉你进的餐饮群" (relative clause referencing prior group)', async () => {
      const result = service.check({
        replyText: '之前拉你进的餐饮群里会持续更新各区的新岗，你留意就行。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag past-tense "已经拉你进过天津餐饮兼职群了"', async () => {
      const result = service.check({
        replyText:
          '之前已经拉你进过天津餐饮兼职群了，后续要是出来周末能做的岗位，我会第一时间在群里通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag "或者我拉你进兼职群" as alternative offer', async () => {
      const result = service.check({
        replyText:
          '这边暂时没有免证的岗位了。或者我拉你进兼职群，后面有新出的免证岗位直接在群里通知你。',
        toolCalls: [{ toolName: 'duliday_job_list', args: {}, status: 'ok', result: {} }],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag "不考虑的话我拉你进兼职群" as conditional offer', async () => {
      const result = service.check({
        replyText: '不考虑的话我拉你进兼职群，后续有新岗位群里通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag "不行的话…我先拉你进群留意下？" as conditional question', async () => {
      const result = service.check({
        replyText: '不行的话，附近暂时没其他19:30-23:00的短班岗位了，我先拉你进群留意下？',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('does NOT flag "或者我先拉你进餐饮兼职群" as alternative offer', async () => {
      const result = service.check({
        replyText: '时段能不能放宽一点？或者我先拉你进餐饮兼职群，后面有新岗我第一时间通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(false);
    });

    it('STILL flags "我拉你进群了" assertion without invite_to_group (not a question)', async () => {
      const result = service.check({
        replyText: '我拉你进咱们餐饮兼职群了，后面有合适的直接通知你。',
        toolCalls: [],
        chatId: 'chat-1',
      });
      expect(result.hit).toBe(true);
      expect(result.contradictions[0].ruleId).toBe('group_promise_without_invite');
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
      notifier.notifyContradiction.mockRejectedValue(new Error('feishu down'));

      const result = service.check({
        replyText: '群已满了',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(result.hit).toBe(true);
      await flushAsync();
      // 不应抛
    });
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
        toolCalls: [makePrecheckCall(['姓名', '联系方式', '性别', '年龄', '学历', '过往工作经验'])],
        chatId: 'chat-1',
      });

      expect(result.hit).toBe(true);
      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeDefined();
      expect(mismatch?.label).toContain('过往工作经验');
    });

    it('uses the latest precheck checklist when validating booking template fields', () => {
      const result = service.check({
        replyText: ['姓名：', '联系方式：', '学历：'].join('\n'),
        toolCalls: [
          makePrecheckCall(['姓名', '联系方式', '年龄'], {
            starterFields: ['姓名', '联系方式', '年龄'],
          }),
          makePrecheckCall(['姓名', '联系方式', '学历'], {
            starterFields: ['姓名', '联系方式', '学历'],
          }),
        ],
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'booking_form_field_mismatch',
      );
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

    it('uses starterFields when precheck has progressive strategy', () => {
      const replyText = ['姓名：', '电话：', '年龄：'].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [
          makePrecheckCall(['姓名', '联系电话', '年龄', '学历', '健康证情况'], {
            starterFields: ['姓名', '联系电话', '年龄'],
          }),
        ],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag short replies without a form-like field block', () => {
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
      const replyText = ['姓名：', '电话：', '年龄：', '学历：'].join('\n');
      const result = service.check({ replyText, toolCalls: [], chatId: 'chat-1' });

      expect(result.hit).toBe(false);
    });

    it('does not flag when field has bracket annotation before colon (false-positive 面试时间（选一个）：)', () => {
      const replyText = [
        '姓名：',
        '电话：',
        '性别：',
        '年龄：',
        '学历：',
        '健康证（有/无）：',
        '面试时间（选一个）：明天周五 13:00 / 后天周六 09:00',
        '应聘门店：泛海店',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '电话', '性别', '年龄', '学历', '面试时间'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag when slash-merged field covers multiple required fields (false-positive 性别/年龄：)', () => {
      const replyText = [
        '姓名：',
        '电话：',
        '性别/年龄：',
        '学历：',
        '面试时间（选一个）：',
        '身份（学生/社会人士）：',
        '健康证：',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '电话', '性别', '年龄', '学历', '面试时间'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag pre-filled numeric value "年龄：32" as missing (rescue pass)', () => {
      const replyText = [
        '资料确认一下：',
        '',
        '姓名：董宇强',
        '电话：13949906531',
        '年龄：32',
        '学历：大专',
        '面试时间：',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '联系电话', '年龄', '学历', '面试时间'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag parenthetical note "（性别女/50岁我记下了）" as missing', () => {
      const replyText = [
        '麻烦把剩下的资料补一下：',
        '',
        '姓名：',
        '电话：',
        '学历：',
        '面试时间：',
        '',
        '（性别女/50岁我记下了）',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '电话', '性别', '年龄', '学历', '面试时间'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('does not flag "（性别这边我先按男生备注了）" parenthetical as missing', () => {
      const replyText = [
        '姓名：',
        '电话：',
        '年龄：',
        '学历：',
        '面试时间：',
        '（性别这边我先按男生备注了）',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '电话', '性别', '年龄', '学历', '面试时间'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });

    it('still flags truly missing field even when other fields are pre-filled', () => {
      const replyText = [
        '资料确认一下：',
        '',
        '姓名：张三',
        '电话：13800138000',
        '学历：本科',
        '健康证：有',
        '年龄：25',
      ].join('\n');

      const result = service.check({
        replyText,
        toolCalls: [
          makePrecheckCall(['姓名', '联系电话', '年龄', '学历', '健康证', '性别', '面试时间']),
        ],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeDefined();
      expect(mismatch?.label).toContain('性别');
      expect(mismatch?.label).toContain('面试时间');
    });

    it('does not flag pre-filled "面试时间：5月25日10:00" as missing', () => {
      const replyText = ['姓名：李明', '电话：', '性别：', '年龄：', '面试时间：5月25日10:00'].join(
        '\n',
      );

      const result = service.check({
        replyText,
        toolCalls: [makePrecheckCall(['姓名', '电话', '性别', '年龄', '面试时间'])],
        chatId: 'chat-1',
      });

      const mismatch = result.contradictions.find(
        (c) => c.ruleId === 'booking_form_field_mismatch',
      );
      expect(mismatch).toBeUndefined();
    });
  });

  describe('salary_fabrication (badcase aalxnd77 / zt98hgy3)', () => {
    const makeJobListCall = (
      overrides: {
        holidayType?: string;
        overtimeType?: string;
      } = {},
    ): AgentToolCall => ({
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

    it('does not flag when no duliday_job_list was called this turn', () => {
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

  describe('job fact value mismatch (值级对账，badcase recvkYh95uVU43 / recvi9UoI6jAiE)', () => {
    const makeMarkdownJobListCall = (markdown: string): AgentToolCall => ({
      toolName: 'duliday_job_list',
      args: {},
      status: 'ok',
      result: { markdown, resultCount: 1 },
    });

    describe('job_shift_polarity_mismatch', () => {
      it('flags when reply claims 早班 but tool shift facts only have 晚班', () => {
        const result = service.check({
          replyText: '这个岗位是早班，早上过去就能上手。',
          toolCalls: [makeMarkdownJobListCall('- **工作班次**: 晚班 18:00-23:00\n- 薪资: 24元/时')],
          chatId: 'chat-1',
        });

        const hit = result.contradictions.find((c) => c.ruleId === 'job_shift_polarity_mismatch');
        expect(hit).toBeDefined();
        expect(hit?.action).toBe('revise');
      });

      it('flags the reverse direction (claims 晚班 but tool only has 早班)', () => {
        const result = service.check({
          replyText: '这家是晚班岗位。',
          toolCalls: [makeMarkdownJobListCall('- **工作班次**: 早班 7:00-12:00')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'job_shift_polarity_mismatch'),
        ).toBeDefined();
      });

      it('passes when tool facts contain both polarities (union semantics)', () => {
        const result = service.check({
          replyText: '这家主要是早班。',
          toolCalls: [
            makeMarkdownJobListCall('- **工作班次**: 早班 7:00-12:00 / 晚班 18:00-23:00'),
          ],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'job_shift_polarity_mismatch'),
        ).toBeUndefined();
      });

      it('skips enumeration and question contexts', () => {
        const both = service.check({
          replyText: '早班晚班都有，你想上哪个？',
          toolCalls: [makeMarkdownJobListCall('- **工作班次**: 晚班 18:00-23:00')],
          chatId: 'chat-1',
        });
        expect(
          both.contradictions.find((c) => c.ruleId === 'job_shift_polarity_mismatch'),
        ).toBeUndefined();

        const question = service.check({
          replyText: '你能接受早班吗？',
          toolCalls: [makeMarkdownJobListCall('- **工作班次**: 晚班 18:00-23:00')],
          chatId: 'chat-1',
        });
        expect(
          question.contradictions.find((c) => c.ruleId === 'job_shift_polarity_mismatch'),
        ).toBeUndefined();
      });

      it('skips negated sentences', () => {
        const result = service.check({
          replyText: '这家不用上早班的。',
          toolCalls: [makeMarkdownJobListCall('- **工作班次**: 晚班 18:00-23:00')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'job_shift_polarity_mismatch'),
        ).toBeUndefined();
      });
    });

    describe('hourly_salary_value_mismatch', () => {
      it('flags when claimed hourly salary does not exist in tool facts', () => {
        const result = service.check({
          replyText: '节假日时薪17元哦。',
          toolCalls: [makeMarkdownJobListCall('- **薪资**: 22元/时，节假日 54元/时')],
          chatId: 'chat-1',
        });

        const hit = result.contradictions.find((c) => c.ruleId === 'hourly_salary_value_mismatch');
        expect(hit).toBeDefined();
        expect(hit?.label).toContain('17');
      });

      it('passes when claimed value matches tool facts exactly', () => {
        const result = service.check({
          replyText: '这家时薪54元。',
          toolCalls: [makeMarkdownJobListCall('- **薪资**: 22元/时，节假日 54元/时')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'hourly_salary_value_mismatch'),
        ).toBeUndefined();
      });

      it('passes when claimed value falls inside a salary range', () => {
        const result = service.check({
          replyText: '时薪22元左右。',
          toolCalls: [makeMarkdownJobListCall('- **薪资**: 20-25元/时')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'hourly_salary_value_mismatch'),
        ).toBeUndefined();
      });

      it('supports the suffix claim form (30元/小时)', () => {
        const result = service.check({
          replyText: '这家给到30元/小时。',
          toolCalls: [makeMarkdownJobListCall('- **薪资**: 22元/时')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'hourly_salary_value_mismatch'),
        ).toBeDefined();
      });

      it('skips when tool facts contain no salary content at all', () => {
        const result = service.check({
          replyText: '时薪30元。',
          toolCalls: [makeMarkdownJobListCall('- **距离**: 1.2km')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'hourly_salary_value_mismatch'),
        ).toBeUndefined();
      });
    });

    describe('settlement_cycle_mismatch', () => {
      it('flags when reply claims 日结 but tool facts say 月结 (badcase #15)', () => {
        const result = service.check({
          replyText: '这家是日结的哦。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 月结（次月15日发放）')],
          chatId: 'chat-1',
        });

        const hit = result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch');
        expect(hit).toBeDefined();
        expect(hit?.label).toContain('月结');
      });

      it('passes when claimed settlement matches tool facts', () => {
        const result = service.check({
          replyText: '工资日结。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 日结')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeUndefined();
      });

      it('treats 次月 as 月结 support', () => {
        const result = service.check({
          replyText: '这家是月结。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 次月10日发放')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeUndefined();
      });

      it('skips when tool facts carry no settlement info', () => {
        const result = service.check({
          replyText: '这家是日结的。',
          toolCalls: [makeMarkdownJobListCall('- **薪资**: 22元/时')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeUndefined();
      });

      it('skips question and negation sentences', () => {
        const result = service.check({
          replyText: '你要找日结的吗？这家不是日结。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 月结')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeUndefined();
      });

      it('skips requirement echo + future promise (上线首日 repair_exhausted 告别话术误伤)', () => {
        const result = service.check({
          replyText:
            '行，那我这边先不硬推了哈。后续有离你近点、或者符合晚班日结要求的岗位上线，我再同步给你。你先忙，有需要随时找我。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 周结（每周三发）')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeUndefined();
      });

      it('still flags a real settlement claim even alongside a requirement echo', () => {
        const result = service.check({
          replyText: '你想找日结的对吧？这家就是日结的哦。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 月结')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeDefined();
      });

      it('flags 岗位要求日结 as a job-fact claim (bare 要求 must not trigger the echo exemption)', () => {
        const result = service.check({
          replyText: '这个岗位要求日结上岗。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 月结')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeDefined();
      });

      it('flags 当前岗位满足日结要求 as a real settlement claim', () => {
        const result = service.check({
          replyText: '这个岗位满足你的日结要求。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 月结')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeDefined();
      });

      it('keeps exempting first-person requirement echo (你的日结要求)', () => {
        const result = service.check({
          replyText: '你的日结要求我记下了，有合适的再喊你。',
          toolCalls: [makeMarkdownJobListCall('- **结算周期**: 月结')],
          chatId: 'chat-1',
        });

        expect(
          result.contradictions.find((c) => c.ruleId === 'settlement_cycle_mismatch'),
        ).toBeUndefined();
      });
    });
  });

  describe('human_service_phrase_leak (badcase recvjXBkmV6idz / recvnV3iYGZnBJ)', () => {
    it('observes when reply mentions 转人工', () => {
      const result = service.check({
        replyText: '这个问题我给你转人工处理下哈。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('observe');
      expect(hit?.currentReplySendable).toBe(true);
    });

    it('observes when reply mentions 人工客服', () => {
      const result = service.check({
        replyText: '你可以联系人工客服问问。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
      ).toBeDefined();
    });

    it('does not flag the compliant 同事 phrasing', () => {
      const result = service.check({
        replyText: '这个我帮你问下负责的同事，稍后回复你哈。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
      ).toBeUndefined();
    });
  });

  describe('repeated_reply / repeated_greeting (badcase recvnVdWUh8E84 / recvlmGXDwMZrz)', () => {
    it('flags near-duplicate long reply against recent assistant messages', () => {
      const jobDetail =
        '为你推荐肯德基静安寺店，时薪24元，班次晚班18:00-23:00，距离你1.2公里，感兴趣可以帮你报名。';
      const result = service.check({
        replyText: jobDetail,
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['好的', jobDetail],
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'repeated_reply');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('revise');
    });

    it('flags punctuation-only variations as duplicates', () => {
      const result = service.check({
        replyText: '你平时主要在哪个区域活动呀？方便告诉我下～',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['你平时主要在哪个区域活动呀，方便告诉我下'],
      });

      expect(result.contradictions.find((c) => c.ruleId === 'repeated_reply')).toBeDefined();
    });

    it('does not flag short acknowledgements', () => {
      const result = service.check({
        replyText: '好的，收到！',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['好的，收到！'],
      });

      expect(result.contradictions.find((c) => c.ruleId === 'repeated_reply')).toBeUndefined();
    });

    it('does not flag genuinely new content', () => {
      const result = service.check({
        replyText: '帮你查了下，静安寺附近还有一家必胜客在招，班次比较灵活。',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['为你推荐肯德基静安寺店，时薪24元，晚班18:00-23:00。'],
      });

      expect(result.contradictions.find((c) => c.ruleId === 'repeated_reply')).toBeUndefined();
    });

    it('observes repeated greeting after the conversation already opened with one', () => {
      const result = service.check({
        replyText: '你好呀，请问你在找什么工作？',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['你好，我是招聘顾问小张', '我们这边有不少门店在招人'],
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'repeated_greeting');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('observe');
    });

    it('does not flag greeting when prior assistant messages never greeted', () => {
      const result = service.check({
        replyText: '你好，看到你想找兼职？',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['这家门店时薪24元'],
      });

      expect(result.contradictions.find((c) => c.ruleId === 'repeated_greeting')).toBeUndefined();
    });

    it('skips both repeat rules when history is unavailable', () => {
      const result = service.check({
        replyText: '你好呀，请问你在找什么工作？',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(result.contradictions.find((c) => c.ruleId === 'repeated_reply')).toBeUndefined();
      expect(result.contradictions.find((c) => c.ruleId === 'repeated_greeting')).toBeUndefined();
    });
  });

  describe('group_promise "帮你进群" 形态 (回归复测 recvnBYuVLIQsV 逃逸发现)', () => {
    it('flags 帮你进餐饮兼职群 promise without invite call', () => {
      const result = service.check({
        replyText: '我先帮你进餐饮兼职群，后续有合适的我会第一时间@你。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'group_promise_without_invite'),
      ).toBeDefined();
    });

    it('passes the same phrasing when invite_to_group succeeded this turn', () => {
      const result = service.check({
        replyText: '我先帮你进餐饮兼职群，后续有合适的我会第一时间@你。',
        toolCalls: [
          { toolName: 'invite_to_group', args: {}, result: { success: true } } as AgentToolCall,
        ],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'group_promise_without_invite'),
      ).toBeUndefined();
    });
  });

  describe('district_level_distance_claim (badcase recvjyv0SKiqe3 回归发现)', () => {
    const makeAreaGeocodeCall = (areaLevelQuery: boolean): AgentToolCall => ({
      toolName: 'geocode',
      args: { address: '松江' },
      result: {
        resolution: 'unique',
        result: { city: '上海市', district: '松江区', areaLevelQuery },
      },
    });

    it('flags precise distance claim when geocode was an area-level query', () => {
      const result = service.check({
        replyText: '成都你六姐（松江大橘邻里中心店）- 晚班，离你2.2公里，要不要看看？',
        toolCalls: [makeAreaGeocodeCall(true)],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'district_level_distance_claim');
      expect(hit).toBeDefined();
      // replan（给只读工具）：rewrite 档禁工具曾诱导模型把工具调用写成文本外发（上线首日 badcase）
      expect(hit?.action).toBe('replan');
    });

    it('passes when reply asks for a more specific location instead', () => {
      const result = service.check({
        replyText:
          '松江这边有几家在招，你平时在哪条路或者哪个商圈附近？方便的话发个定位，我帮你算下距离。',
        toolCalls: [makeAreaGeocodeCall(true)],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'district_level_distance_claim'),
      ).toBeUndefined();
    });

    it('passes when geocode query was POI-level (areaLevelQuery=false)', () => {
      const result = service.check({
        replyText: '九亭地铁站附近这家离你0.8公里。',
        toolCalls: [makeAreaGeocodeCall(false)],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'district_level_distance_claim'),
      ).toBeUndefined();
    });

    it('passes when reply has no precise distance claim', () => {
      const result = service.check({
        replyText: '松江这边有成都你六姐在招，班次是晚班收档，你有兴趣吗？',
        toolCalls: [makeAreaGeocodeCall(true)],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'district_level_distance_claim'),
      ).toBeUndefined();
    });
  });

  describe('group_invite_without_reason (badcase recvnBYuVLIQsV / recvnlMW3l3OXp)', () => {
    const makeInviteCall = (result: Record<string, unknown>): AgentToolCall => ({
      toolName: 'invite_to_group',
      args: { city: '上海' },
      result,
    });

    it('observes when invite succeeded but reply gives no reason', () => {
      const result = service.check({
        replyText: '入群邀请已经发你了，点一下卡片就能进群。',
        toolCalls: [makeInviteCall({ success: true, groupName: '上海兼职群1号' })],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'group_invite_without_reason');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('observe');
    });

    it('passes when reply explains the no-match fallback reason', () => {
      const result = service.check({
        replyText: '现在暂时没有完全匹配的岗位，先帮你进兼职群，有新岗位群里会第一时间通知你。',
        toolCalls: [makeInviteCall({ success: true, groupName: '上海兼职群1号' })],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'group_invite_without_reason'),
      ).toBeUndefined();
    });

    it('skips when invite failed or candidate already in group', () => {
      const failed = service.check({
        replyText: '好的，我再帮你看看其他岗位。',
        toolCalls: [makeInviteCall({ success: false, errorType: 'invite.group_full' })],
        chatId: 'chat-1',
      });
      expect(
        failed.contradictions.find((c) => c.ruleId === 'group_invite_without_reason'),
      ).toBeUndefined();

      const already = service.check({
        replyText: '好的，有消息我跟你说。',
        toolCalls: [makeInviteCall({ success: true, alreadyInGroup: true })],
        chatId: 'chat-1',
      });
      expect(
        already.contradictions.find((c) => c.ruleId === 'group_invite_without_reason'),
      ).toBeUndefined();
    });
  });
});
