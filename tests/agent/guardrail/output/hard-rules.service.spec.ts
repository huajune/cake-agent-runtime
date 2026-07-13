import { HardRulesService } from '@agent/guardrail/output/hard-rules.service';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';

describe('HardRulesService', () => {
  let service: HardRulesService;
  let notifier: { notifyContradiction: jest.Mock };

  beforeEach(() => {
    notifier = { notifyContradiction: jest.fn().mockResolvedValue(undefined) };
    service = new HardRulesService(notifier as unknown as ReplyFactGuardNotifierService);
  });

  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

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
      // 倒序拒斥式：专业后紧跟拒绝后果（2026-07-06 review：收窄倒序支后保留的真阳）
      '不是相关专业的做不了',
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
      // 安抚候选人"不卡专业"的合规话术（2026-07-06 review：误杀修复）
      '这个岗位不看专业要求的',
      '专业要求：不限',
      '这个岗位专业要求不高，放心报',
      '不考虑专业背景，大家都能做',
      '不要求专业对口，放心报名',
      '这家对专业要求不高',
      // 倒序安抚式："不是相关专业"后接宽慰而非拒绝后果（2026-07-06 review 误杀修复）
      '不是相关专业也没关系，这个岗位不卡专业',
      '不是相关专业也能做的，放心报',
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

    it('does not treat salary range prose as a requested brand mismatch', () => {
      const result = service.check({
        replyText:
          '班次各家店不太一样，一般是早中晚班可选，比如 08:00-15:00、15:00-23:00 这种，每班大概 7-8 小时。\n\n' +
          '薪资是 19-20 元/时起，按月累计工时涨档：满 100 小时涨到 21-22 元/时，满 190 小时涨到 23-24 元/时，节假日 38 元/时。日结。\n\n' +
          '你发个具体位置或地标给我，我帮你看哪家店离你最近，把那家的详细班次发你。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { brandAliasList: ['必胜客'] },
            result: {
              result: [
                {
                  jobId: 1,
                  brandName: '必胜客',
                  storeName: '青核',
                  distanceKm: 2,
                },
              ],
            },
            resultCount: 1,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('requested_brand_mismatch');
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

    it('asks for a scoped replan when reply uses image facts without saving image description', () => {
      const result = service.check({
        replyText: '图片里是健康证，我看到了，可以继续帮你报名。',
        userMessage: '[图片 messageId=img-1]',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'image_description_not_saved',
            action: GUARDRAIL_ACTION.REPLAN,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('does not mistake a health-certificate collection template for an image claim', () => {
      const result = service.check({
        replyText: '姓名：\n电话：\n健康证：有/无\n身份：学生/社会人士',
        userMessage: '[表情消息]',
        toolCalls: [],
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'image_description_not_saved',
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
  });

  describe('summer_worker_alternative_upsell', () => {
    const summerWorkerEmptyToolCall = {
      toolName: 'duliday_job_list',
      args: {},
      status: 'error' as const,
      result: {
        success: false,
        errorType: 'job_list.labor_form_filter_empty',
        queryMeta: {
          laborFormFilter: {
            applied: true,
            candidateLaborForm: '暑假工',
            excludedCount: 3,
          },
        },
      },
    };

    it.each([
      '抱歉，附近暂时没有暑假工，要不要考虑普通兼职？',
      '目前没有合适的暑假工，小时工你愿意看看吗？',
      '这边暂时没有暑假工，不过还有长期兼职可以推荐。',
      '附近没有暑假工岗位，或者看看全职呢？',
    ])(
      'revises proactive alternative labor-form upsell after summer-worker empty result: %s',
      (reply) => {
        const result = service.check({
          replyText: reply,
          toolCalls: [summerWorkerEmptyToolCall],
          chatId: 'chat-1',
          userId: 'user-1',
          userMessage: '我只找暑假工',
          silent: true,
        });

        expect(result.contradictions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              ruleId: 'summer_worker_alternative_upsell',
              action: GUARDRAIL_ACTION.REVISE,
              currentReplySendable: false,
            }),
          ]),
        );
      },
    );

    it('allows the direct summer-worker rejection', () => {
      const result = service.check({
        replyText: '抱歉，你附近暂时没有合适的暑假工岗位。',
        toolCalls: [summerWorkerEmptyToolCall],
        userMessage: '我只找暑假工',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'summer_worker_alternative_upsell',
      );
    });

    it('does not infer an empty summer-worker result without tool ground truth', () => {
      const result = service.check({
        replyText: '要不要考虑普通兼职？',
        toolCalls: [],
        userMessage: '我找暑假工',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'summer_worker_alternative_upsell',
      );
    });

    it('allows alternatives when the candidate explicitly changes intent this turn', () => {
      const result = service.check({
        replyText: '普通兼职也有，我继续帮你查下。',
        toolCalls: [summerWorkerEmptyToolCall],
        userMessage: '没有暑假工的话，普通兼职也可以',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'summer_worker_alternative_upsell',
      );
    });
  });

  describe('identity_misregistration_coaching (badcase chat 6a50827c 教唆按非暑假工登记)', () => {
    const summerGuardPrecheck = (status: 'blocked_non_summer_job' | 'needs_confirmation') =>
      [
        {
          toolName: 'duliday_interview_precheck',
          args: {},
          result: {
            nextAction: 'collect_fields',
            temporarySummerWorkerGuard: { status },
          },
          status: 'ok',
        },
      ] as never;

    it('flags the audit-evasion coaching verbatim from the badcase (无需工具佐证)', () => {
      const result = service.check({
        replyText:
          '行，那为了顺利过系统审核，我帮你按“非暑假工（长期兼职）”登记上去可以吗？面试时你跟店长如实说下暑期能做两个月就行。',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'identity_misregistration_coaching',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
      );
    });

    it('flags concealment advice "先别说你是暑假工"', () => {
      const result = service.check({
        replyText: '面试的时候先别说你是暑假工，店长问了再说能做到八月底。',
        toolCalls: [],
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'identity_misregistration_coaching',
      );
    });

    it('flags coercing the candidate to repeat “不是暑假工” before registration (chat 6a549f04)', () => {
      const result = service.check({
        replyText:
          '不过系统这边还需要你明确回复一下“不是暑假工”，才能完成登记。你回一句“不是暑假工”，我马上帮你提交预约。',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'identity_misregistration_coaching',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('flags identity-rewrite registration while the summer guard is active', () => {
      const result = service.check({
        replyText: '那我帮你登记为社会人士，这样就能约上了。',
        toolCalls: summerGuardPrecheck('needs_confirmation'),
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'identity_misregistration_coaching',
      );
    });

    it('does not flag identity-rewrite phrasing without an active summer guard（候选人真实非暑假工的如实登记）', () => {
      const result = service.check({
        replyText: '好的，你是长期做的话，我就按长期兼职帮你登记。',
        toolCalls: [],
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'identity_misregistration_coaching',
      );
    });

    it('does not flag the honest no-summer-jobs relay', () => {
      const result = service.check({
        replyText:
          '这家目前标注的是常规兼职，暑期暂时不招暑假工哈。我先帮你留意，后续有暑假工岗位上线第一时间通知你。',
        toolCalls: summerGuardPrecheck('blocked_non_summer_job'),
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'identity_misregistration_coaching',
      );
    });

    it.each([
      '为了顺利通过审核，请如实填写你的真实身份信息并登记。',
      '为了能顺利过系统审核，麻烦先汇报一下实际情况。',
    ])('does not flag honest audit-compliance wording: %s', (replyText) => {
      const result = service.check({ replyText, toolCalls: [] });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'identity_misregistration_coaching',
      );
    });
  });

  describe('service basics', () => {
    it('does not throw when reply is empty', () => {
      const result = service.check({ replyText: '', toolCalls: [] });
      expect(result).toEqual({ hit: false, contradictions: [] });
    });

    it('does not throw if ops notifier alert rejects (fire-and-forget)', async () => {
      notifier.notifyContradiction.mockRejectedValue(new Error('feishu down'));

      const result = service.check({
        replyText: '这个岗位不要新疆西藏籍的',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(result.hit).toBe(true);
      await flushAsync();
      // 不应抛
    });
  });

  describe('observe 档不写飞书 badcase（判例仅落库 guardrail_review_records）', () => {
    it('observe-only 命中：返回裁决且落库全量，但不 fire 飞书 badcase', async () => {
      const result = service.check({
        replyText: '这个我帮你转人工客服处理下哈',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        traceId: 'trace-1',
      });

      expect(result.hit).toBe(true);
      // 裁决/落库仍保留 observe 命中
      expect(result.contradictions.map((c) => c.ruleId)).toContain('human_service_phrase_leak');
      expect(result.contradictions.every((c) => c.action === GUARDRAIL_ACTION.OBSERVE)).toBe(true);

      await flushAsync();
      // observe 判例不再写飞书多维表
      expect(notifier.notifyContradiction).not.toHaveBeenCalled();
    });

    it('enforce + observe 混合：飞书只收 enforce 判例，observe 判例被过滤掉', async () => {
      const result = service.check({
        replyText: '这个岗位不要新疆西藏籍的。要不我帮你转人工客服问问',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        traceId: 'trace-1',
      });

      expect(result.hit).toBe(true);
      // 返回裁决保留全部命中（含 observe），供落库与决策合并
      const ruleIds = result.contradictions.map((c) => c.ruleId);
      expect(ruleIds).toContain('discriminatory_screening_leak');
      expect(ruleIds).toContain('human_service_phrase_leak');

      await flushAsync();
      expect(notifier.notifyContradiction).toHaveBeenCalledTimes(1);
      const payload = notifier.notifyContradiction.mock.calls[0][0] as {
        contradictions: Array<{ ruleId: string }>;
      };
      const feishuRuleIds = payload.contradictions.map((c) => c.ruleId);
      expect(feishuRuleIds).toContain('discriminatory_screening_leak');
      expect(feishuRuleIds).not.toContain('human_service_phrase_leak');
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

  describe('repeated_reply (badcase recvlmGXDwMZrz / recvlsYa5SSOn9)', () => {
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
      expect(hit?.action).toBe('observe');
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

    it('skips repeat detection when history is unavailable', () => {
      const result = service.check({
        replyText: '你好呀，请问你在找什么工作？',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(result.contradictions.find((c) => c.ruleId === 'repeated_reply')).toBeUndefined();
    });
  });
});
