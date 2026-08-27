import { HardRulesService } from '@agent/guardrail/output/hard-rules.service';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

/**
 * 2026-08-26 数据复核恢复的规则回归：settlement_cycle_mismatch /
 * proactive_insurance_policy_mention / human_service_phrase_leak。
 * 用例整体取自恢复前的 hard-rules.service.spec.ts 原判例，保持口径连续。
 */
describe('HardRulesService restored sentinels', () => {
  let service: HardRulesService;
  const alertNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };

  beforeEach(() => {
    alertNotifier.sendAlert.mockClear();
    alertNotifier.sendAlert.mockResolvedValue(true);
    service = new HardRulesService(alertNotifier as never);
  });

  describe('settlement cycle scope', () => {
    const hybridSettlementCall = {
      toolName: 'duliday_job_list',
      args: { jobIdList: [524579] },
      status: 'ok' as const,
      result: {
        markdown:
          '#### 薪资方案 1（正式）\n- **结算周期**: 日结算, 当日结发薪\n' +
          '#### 薪资方案 2（培训期）\n- **结算周期**: 月结算, 10号发薪',
      },
    };

    it('rejects treating monthly training pay as the whole salary cycle', () => {
      const result = service.check({
        replyText: '这边是按月结算的，具体发薪规则我帮你确认下。',
        toolCalls: [hybridSettlementCall],
        userMessage: '咱这边是日结吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'settlement_cycle_mismatch',
      );
    });

    it('accepts a scoped explanation of daily base pay and monthly supplemental pay', () => {
      const result = service.check({
        replyText: '基础工资是日结，培训费用和阶梯差价按月结算，每月10号补发。',
        toolCalls: [hybridSettlementCall],
        userMessage: '咱这边是日结吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_cycle_mismatch',
      );
    });

    it('accepts a plain monthly claim for a formal monthly salary scenario', () => {
      const result = service.check({
        replyText: '这家是月结，15号发薪。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { jobIdList: [1] },
            status: 'ok',
            result: {
              markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 月结算, 15号发薪',
            },
          },
        ],
        userMessage: '是月结吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_cycle_mismatch',
      );
    });

    // 锁定否定句与补充结算语境的假阳回归。
    describe('production false positives (2026-07-21 audit)', () => {
      const monthlyOnlyCall = {
        toolName: 'duliday_job_list',
        args: { jobIdList: [1] },
        status: 'ok' as const,
        result: { markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 月结算, 15号发薪' },
      };
      const dailyOnlyCall = {
        toolName: 'duliday_job_list',
        args: { jobIdList: [1] },
        status: 'ok' as const,
        result: { markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 日结算, 当日结发薪' },
      };

      // trace batch_6a5db6d9…/batch_6a5ede31…：回复说的恰恰是判决书的反面。
      it.each([
        ['没 + 无空格', '东靖路附近暂时没日结岗，目前有几家月结（15号发薪）的兼职。'],
        ['没有 + 的', '这边暂时没有日结的岗位，工资都是月结的，次月15号左右发。'],
        ['无', '该门店无日结安排，按月结发放。'],
      ])('does not treat a negated cycle mention as an assertion (%s)', (_label, replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [monthlyOnlyCall],
          userMessage: '有日结的岗位吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      it('keeps asserting the cycle when a negation targets a different cycle', () => {
        const result = service.check({
          replyText: '这家不是月结，是日结的。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '是日结吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).toContain(
          'settlement_cycle_mismatch',
        );
      });

      // trace batch_6a5db6b6…：岗位数据没编码培训/阶梯方案，但回复已把"月结"限定在
      // 阶梯差价上——这正是规则 feedback 要求的写法，不能再判违规。
      it('accepts supplemental-scoped cycles even when the job data has no supplemental scenario', () => {
        const result = service.check({
          replyText:
            '两家都是日结为主。基础工资每天按实际出勤结，但超过 100 小时的阶梯差价是月结的，每月10号发。',
          toolCalls: [dailyOnlyCall],
          userMessage: '他们这结算是怎么结算的，日结还是月结',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      it('still blocks an unscoped cycle claim that contradicts the formal salary period', () => {
        const result = service.check({
          replyText: '这家工资是月结的，每月15号统一发放。',
          toolCalls: [dailyOnlyCall],
          userMessage: '怎么结算的',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).toContain(
          'settlement_cycle_mismatch',
        );
      });
    });

    // 锁定补充结算、他岗前瞻和心愿复述的假阳回归。
    describe('production false positives (2026-07-24 audit)', () => {
      const monthlyOnlyCall = {
        toolName: 'duliday_job_list',
        args: { jobIdList: [1] },
        status: 'ok' as const,
        result: { markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 月结算, 15号发薪' },
      };

      // trace batch_6a61a550…：「不支持」不在否定词表，整句失防；rewrite 为修它
      // 追加了无依据的月结断言。
      it('does not treat "不支持日结或周结" as an assertion', () => {
        const result = service.check({
          replyText:
            '目前沈河区这边在招的岗位都要求至少做 6 个月以上，暂时没有短期的，也不支持日结或周结。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '那短期要吗？',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      // trace batch_6a5ee3e8…：「或」并列后段（日结）距否定词 7 字，超出旧 5 字窗口。
      it('exempts both cycles in a negated "X或Y" alternation', () => {
        const result = service.check({
          replyText: '抱歉哈，除了肯德基之外，你附近暂时没找到其他周结或日结的岗位。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '有周结的吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      // trace batch_6a5db79e…：描述另一家的灵工单属性；trace batch_6a5ee3e8…：
      // 未来供给承诺——都不是焦点岗位的结算断言。
      it.each([
        [
          '灵工单属性',
          '之前截图里那个海底捞捞面师是 7 月 24 号一天的灵工单（短期/日结），不是长期能一直排的兼职。',
        ],
        [
          '未来供给',
          '你看是接受可可牛月结的，还是我先帮你进兼职群，后面有周结/日结的新岗位第一时间通知你。',
        ],
      ])('exempts prospective/other-job cycle mentions (%s)', (_label, replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [
            {
              toolName: 'duliday_job_list',
              args: { jobIdList: [1] },
              status: 'ok' as const,
              result: { markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 月结算, 15号发薪' },
            },
          ],
          userMessage: '有日结的吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      // 收紧并列残余间隔的反例：「没有月结、只有日结」是转折不是并列豁免。
      it('still blocks "没有X、只有Y" style contrastive assertions', () => {
        const result = service.check({
          replyText: '这家没有月结、只有日结。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '怎么结算',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).toContain(
          'settlement_cycle_mismatch',
        );
      });
    });

    // 锁定后缀否定与转折并列语序的假阳回归。
    describe('production false positives (2026-07-27 audit)', () => {
      const monthlyOnlyCall = {
        toolName: 'duliday_job_list',
        args: { jobIdList: [1] },
        status: 'ok' as const,
        result: { markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 月结算, 15号发薪' },
      };

      // trace batch_6a62db88…：否定词在结算词之后，前缀否定正则不认这种语序；
      // rewrite 空转还丢了"时薪 20 多"。
      it('does not treat postfix negation "日结的暂时没排到" as an assertion', () => {
        const result = service.check({
          replyText:
            '日结的暂时没排到哈，不过有普通兼职，像哈根达斯、肯德基这些，时薪20多，长期稳定。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '呀日结兼职吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      // trace batch_6a63278c…：复述候选人诉求的确认句。"是吧"的问号被分句剥掉、
      // "吧"不在疑问词表，落进断言判定。
      it('does not treat a desire echo "你想找日结…是吧" as an assertion', () => {
        const result = service.check({
          replyText:
            '必胜客这家不是日结的哈，是月结算，每月 10 号发工资。你想找日结、只做一周左右的岗位是吧？我帮你看看附近有没有这种短期的日结岗。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '是日结工资吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_cycle_mismatch',
        );
      });

      // 愿望复述豁免禁跨句：确认句豁免不得连带豁免后续真断言。
      it('still blocks an assertion following a desire echo in a separate sentence', () => {
        const result = service.check({
          replyText: '你想找日结是吧？这家就是日结的，当天干完当天结。',
          toolCalls: [monthlyOnlyCall],
          userMessage: '有日结吗',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).toContain(
          'settlement_cycle_mismatch',
        );
      });
    });

    it('does not use another job lookup to validate the current focus job settlement', () => {
      const result = service.check({
        replyText: '这个岗位是月结。',
        toolCalls: [hybridSettlementCall],
        userMessage: '是月结吗',
        memorySnapshot: {
          currentStage: 'interview_scheduling',
          presentedJobIds: [999999],
          recommendedJobIds: [999999],
          sessionFacts: null,
          profileKeys: null,
          currentFocusJob: { jobId: 999999, availableDetailFields: [] },
        },
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_cycle_mismatch',
      );
      // 原判例还断言 job_detail_lookup_required 补查——该规则已随简化改造下线且未恢复，
      // 补查督促交主 Agent final-check，这里只保留"他岗数据不为焦点岗作证"的对账口径。
    });
  });

  describe('proactive insurance policy mention', () => {
    it('observes proactive insurance policy promise when candidate did not ask', () => {
      const result = service.check({
        replyText: '这家早班 7:00-10:00，时薪 24 元，兼职岗位公司购买保险。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '24',
      });

      expect(result.hit).toBe(true);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'proactive_insurance_policy_mention',
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
          }),
        ]),
      );
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

    it('still observes proactive insurance promise when recent turns never asked', () => {
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

    it('allows noun-phrase requirement line 需第一职业劳动合同及社保（守卫档案 id=80 假阳回归：第二职业岗位否则永远推不出去）', () => {
      const result = service.check({
        replyText:
          '哈根达斯（亦庄龙湖店）- 店员，5.7km\n班次：09:00-23:00\n薪资：25 元/小时\n要求：23-30 岁，需第一职业劳动合同及社保，入职前办食品健康证\n\n这个岗位有点特殊，只要已经有正式工作想利用业余时间赚外快的（需提供第一职业的劳动合同和社保证明）。你目前有在职交社保的工作吗？',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '大兴区亦庄',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('allows 要求有本地社保和劳动合同 phrasing（守卫档案 id=97 假阳回归）', () => {
      const result = service.check({
        replyText:
          '这两个都要求有本地社保和劳动合同，你目前方便提供吗？如果暂时不符合，我再帮你看看其他普通兼职或全职岗。',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        userMessage: '目前在市南区',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'proactive_insurance_policy_mention',
      );
    });

    it('still observes when reply mixes requirement context with a benefit promise', () => {
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
      expect(
        result.contradictions.find((c) => c.ruleId === 'proactive_insurance_policy_mention')
          ?.action,
      ).toBe(GUARDRAIL_ACTION.OBSERVE);
    });

    it('observes 签合同+五险一金 benefit promise (bare 合同 must not trigger requirement exemption)', () => {
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
      expect(
        result.contradictions.find((c) => c.ruleId === 'proactive_insurance_policy_mention')
          ?.action,
      ).toBe(GUARDRAIL_ACTION.OBSERVE);
    });

    it('observes 给你交社保 benefit promise (qualification exemption requires 你有…交…社保 question form)', () => {
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
      expect(
        result.contradictions.find((c) => c.ruleId === 'proactive_insurance_policy_mention')
          ?.action,
      ).toBe(GUARDRAIL_ACTION.OBSERVE);
    });

  });

  describe('human_service_phrase_leak (badcase recvjXBkmV6idz / recvnV3iYGZnBJ)', () => {
    it('revises when reply mentions 转人工', () => {
      const result = service.check({
        replyText: '这个问题我给你转人工处理下哈。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('revise');
      expect(hit?.currentReplySendable).toBe(false);
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

    it('does not treat teammate follow-up phrasing as persona leakage', () => {
      const result = service.check({
        replyText: '这个我帮你问下负责的同事，稍后回复你哈。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
      ).toBeUndefined();
    });

    // 2026-07-22 扩词（badcase chat 6a5dedb2ce406a6aeee1ea62：Agent 自称"李娜"，
    // 把账号主人"东升"说成"真人招募经理"，原词表未覆盖直发未拦）
    it('revises 真人招募经理 self-splitting statement (badcase 6a5dedb2)', () => {
      const result = service.check({
        replyText: '东升是真人招募经理哈，我是李娜，负责前期咨询和报名的',
        toolCalls: [],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('revise');
    });

    it('revises 人工登记 / 门店人工确认 action variants', () => {
      for (const replyText of ['资料我帮你人工登记一下哈', '这个班次需要门店人工确认下']) {
        const result = service.check({ replyText, toolCalls: [], chatId: 'chat-1' });
        expect(
          result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
        ).toBeDefined();
      }
    });

    it('revises 专人联系 third-party phrasing', () => {
      const result = service.check({
        replyText: '后续会有专人联系你安排面试哈。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
      ).toBeDefined();
    });

    it('feedback only corrects persona wording without inferring escalation state', () => {
      const result = service.check({
        replyText: '看到啦，我这边帮你人工确认下承揽协议的状态，弄好了跟你说哈。',
        toolCalls: [{ toolName: 'save_image_description', args: {}, result: { success: true } }],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak');
      expect(hit?.feedbackToGenerator).toContain('只把露馅措辞改成人设内口径');
      expect(hit?.feedbackToGenerator).toContain('我帮你问下同事');
    });

    it('does not flag incidental 人工 substring across word boundaries', () => {
      const result = service.check({
        replyText: '这家门店招人工作日白班为主，周末可以轮休。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
      ).toBeUndefined();
    });
  });
});
