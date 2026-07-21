import { HardRulesService } from '@agent/guardrail/output/hard-rules.service';
import type { AgentMemorySnapshot } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

describe('HardRulesService', () => {
  let service: HardRulesService;
  const alertNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };

  beforeEach(() => {
    alertNotifier.sendAlert.mockClear();
    alertNotifier.sendAlert.mockResolvedValue(true);
    service = new HardRulesService(alertNotifier as never);
  });

  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  const check = (replyText: string) =>
    service.check({ replyText, toolCalls: [], chatId: 'chat-1', userId: 'user-1' });

  describe('store status speculation', () => {
    const noMatchLookup = {
      toolName: 'duliday_job_list',
      args: { cityNameList: ['上海'], brandAliasList: ['M Stand'] },
      result: {
        queryMeta: { brand: { appliedCanonicalNames: ['M Stand'] } },
        noMatchScript: {
          candidateMessage: 'M Stand在上海这边暂时没找到合适的岗位',
          nextToolCall: 'invite_to_group',
        },
      },
      status: 'ok' as const,
    };

    it('revises the production case that guesses the screenshot job is full', () => {
      const result = service.check({
        replyText: 'M Stand 在上海暂时没找到在招的岗位，你截图那家可能已经招满了。',
        toolCalls: [noMatchLookup],
        userMessage: '我想问这个',
        chatId: 'test-brand-image',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'unsupported_store_status_speculation',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('revises vague speculation that the store may have adjusted', () => {
      const result = service.check({
        replyText: '这家目前暂时没查到在招岗位了，可能门店那边有调整。',
        toolCalls: [noMatchLookup],
        userMessage: '我想问这个',
        chatId: 'test-brand-image',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'unsupported_store_status_speculation',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('allows the grounded no-match wording without an operational guess', () => {
      const result = service.check({
        replyText: 'M Stand 在上海这边目前暂时没查到匹配的在招岗位。',
        toolCalls: [noMatchLookup],
        userMessage: '我想问这个',
        chatId: 'test-brand-image',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_store_status_speculation',
      );
    });
  });

  describe('job detail grounding', () => {
    const memorySnapshot: AgentMemorySnapshot = {
      currentStage: 'interview_scheduling',
      presentedJobIds: [524579],
      recommendedJobIds: [524579],
      sessionFacts: null,
      profileKeys: null,
      currentFocusJob: {
        jobId: 524579,
        availableDetailFields: [
          'salary',
          'shift',
          'age_requirement',
          'education_requirement',
          'health_certificate_requirement',
          'address',
          'employment',
        ],
      },
    };

    it('replans the production case when settlement is asked without a focus-job lookup', () => {
      const result = service.check({
        replyText: '这边是按月结算的，具体发薪规则我帮你确认下。',
        toolCalls: [],
        userMessage: '不是暑假工，咱这边是日结吗',
        memorySnapshot,
        chatId: '6a5729fece406a6aee2035f9',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'job_detail_lookup_required',
            action: GUARDRAIL_ACTION.REPLAN,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('replans any missing detail field, not only settlement', () => {
      const result = service.check({
        replyText: '主要就是做前厅服务。',
        toolCalls: [],
        userMessage: '这个岗位具体做什么',
        memorySnapshot,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('refreshes shift details even when compact memory says the field exists', () => {
      const result = service.check({
        replyText: '班次是11点到20点。',
        toolCalls: [],
        userMessage: '这个班次几点到几点',
        memorySnapshot,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('replans when candidate proposes a numeric schedule window without saying 班次', () => {
      const result = service.check({
        replyText: '这个时间可以协调的。',
        toolCalls: [],
        userMessage: '欢乐海岸店暂时需要排4-10，因为需要看地铁时间',
        memorySnapshot,
        chatId: '6a573349ce406a6aee27fd07',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('replans shift questions when jobs were presented but no current focus job was set', () => {
      const { currentFocusJob: _omitted, ...snapshotWithoutFocus } = memorySnapshot;
      const result = service.check({
        replyText: '是排班制的，每周会根据你方便的时间来排。',
        toolCalls: [],
        userMessage: '这些时间是排班还是直落',
        memorySnapshot: snapshotWithoutFocus,
        chatId: '6a573349ce406a6aee27fd07',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('still refreshes salary, settlement and welfare even when compact memory has those fields', () => {
      const snapshotWithVolatileFields: AgentMemorySnapshot = {
        ...memorySnapshot,
        currentFocusJob: {
          ...memorySnapshot.currentFocusJob,
          availableDetailFields: [
            ...memorySnapshot.currentFocusJob.availableDetailFields,
            'settlement',
            'welfare',
          ],
        },
      };
      const result = service.check({
        replyText: '时薪20元，日结，也有工作餐。',
        toolCalls: [],
        userMessage: '工资多少，日结吗，包工作餐吗',
        memorySnapshot: snapshotWithVolatileFields,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('accepts a completed lookup for the current focus job but not another job', () => {
      const makeCall = (jobId: number) => ({
        toolName: 'duliday_job_list',
        args: { jobIdList: [jobId] },
        result: { markdown: '# 在招岗位' },
        status: 'ok' as const,
      });
      const accepted = service.check({
        replyText: '我查到了，这个岗位的具体工作内容是前厅服务。',
        toolCalls: [makeCall(524579)],
        userMessage: '具体做什么',
        memorySnapshot,
        chatId: 'chat-1',
      });
      const rejected = service.check({
        replyText: '主要做前厅服务。',
        toolCalls: [makeCall(999999)],
        userMessage: '具体做什么',
        memorySnapshot,
        chatId: 'chat-1',
      });

      expect(accepted.contradictions.map((item) => item.ruleId)).not.toContain(
        'job_detail_lookup_required',
      );
      expect(rejected.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('面试地址追问必须补查，只有成功发送面试定位才能满足', () => {
      const missing = service.check({
        replyText: '面试就去东方渔人码头店。',
        toolCalls: [],
        userMessage: '面试地址在哪里',
        memorySnapshot,
        chatId: 'interview-location-missing',
      });
      const grounded = service.check({
        replyText: '面试请去控江旭辉店，定位已发。',
        toolCalls: [
          {
            toolName: 'send_store_location',
            args: { jobId: 524579, destination: 'interview' },
            status: 'ok',
            result: { success: true, jobId: 524579, destination: 'interview' },
          },
        ],
        userMessage: '面试地址在哪里',
        memorySnapshot,
        chatId: 'interview-location-grounded',
      });

      expect(missing.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
      expect(grounded.contradictions.map((item) => item.ruleId)).not.toContain(
        'job_detail_lookup_required',
      );
    });

    it('报名表单回填不算详情追问（生产误伤 2026-07-21 record 2076）', () => {
      const snapshotMissingFields: AgentMemorySnapshot = {
        ...memorySnapshot,
        currentFocusJob: { jobId: 524579, availableDetailFields: ['salary'] },
      };
      const result = service.check({
        replyText: '资料收到了，今天 13:30-16:30 还能约面试，帮你约今天下午这个时段可以吗？',
        toolCalls: [],
        userMessage:
          '姓名：刘苹\n联系方式：18321207842\n性别：女\n学历：中专\n健康证：有\n身份：社会人士48岁',
        memorySnapshot: snapshotMissingFields,
        chatId: 'form-fill-not-inquiry',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'job_detail_lookup_required',
      );
    });

    it('引用块里的岗位卡片时段/关键词不算详情追问（生产误伤 2026-07-21 record 2048）', () => {
      const result = service.check({
        replyText: '你先把资料填好发我，我帮你约。',
        toolCalls: [],
        userMessage: '[引用 高雅琪：M Stand（白云五号店）早班 07:30-10:30，26元/小时，18-35岁]\n这',
        memorySnapshot,
        chatId: 'quote-block-not-inquiry',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'job_detail_lookup_required',
      );
    });

    it('引用块之外的班次追问仍必须补查（生产真阳 2026-07-21 record 2053）', () => {
      const result = service.check({
        replyText: '这家的班次是固定的，选了早班就是每天只上早班。',
        toolCalls: [],
        userMessage:
          '[引用 祝东升：这两家目前都只有早班：高德置地店 07:30-11:30]\n你好 这些是固定班次吗？\n就每天只上早班吗',
        memorySnapshot,
        chatId: 'question-outside-quote-still-fires',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });

    it('表单式行内带疑问语气仍算追问（学历：初中可以吗）', () => {
      const snapshotMissingFields: AgentMemorySnapshot = {
        ...memorySnapshot,
        currentFocusJob: { jobId: 524579, availableDetailFields: ['salary'] },
      };
      const result = service.check({
        replyText: '初中学历没问题的。',
        toolCalls: [],
        userMessage: '学历：初中可以吗',
        memorySnapshot: snapshotMissingFields,
        chatId: 'form-line-with-question-still-fires',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });
  });

  describe('schedule window claims', () => {
    const memorySnapshot: AgentMemorySnapshot = {
      currentStage: 'job_consultation',
      presentedJobIds: [528551],
      recommendedJobIds: [528551],
      sessionFacts: null,
      profileKeys: null,
      currentFocusJob: { jobId: 528551, availableDetailFields: ['shift'] },
    };
    const shiftLookup = {
      toolName: 'duliday_job_list',
      args: { jobIdList: [528551], includeWorkTime: true },
      status: 'ok' as const,
      result: { markdown: '班次：16:00-次日 00:00' },
    };

    it('rejects the fabricated shortened window from badcase 6a573349', () => {
      const result = service.check({
        replyText: '你跟店里说下地铁时间，协调排 16:00-22:00 这段一般没问题，不会强制上到半夜。',
        toolCalls: [shiftLookup],
        userMessage: '欢乐海岸店暂时需要排4-10，因为需要看地铁时间',
        memorySnapshot,
        chatId: '6a573349ce406a6aee27fd07',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'unsupported_schedule_window_claim',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('allows faithfully repeating the complete tool-provided window', () => {
      const result = service.check({
        replyText: '这家目前可以排 16:00-次日 00:00。',
        toolCalls: [shiftLookup],
        userMessage: '这家几点上班',
        memorySnapshot,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );
    });

    it('does not compare a lookup for another job against the current focus job', () => {
      const result = service.check({
        replyText: '协调排 16:00-22:00 一般没问题。',
        toolCalls: [{ ...shiftLookup, args: { jobIdList: [999999], includeWorkTime: true } }],
        userMessage: '需要排4-10',
        memorySnapshot,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );
      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });
  });

  // 2026-07-21 守卫审计：本分支要求的补救是"先反问哪家门店"这一对话行为，而规则拿不到
  // replyText；且入参在 repair 轮内不变，命中即注定二审复燃（生产 57/57）。降级 observe。
  describe('job_detail_lookup_required with an ambiguous focus job', () => {
    const ambiguousSnapshot = {
      currentStage: 'job_matching',
      presentedJobIds: [111, 222],
      recommendedJobIds: [111, 222],
      sessionFacts: null,
      profileKeys: null,
      currentFocusJob: undefined,
    };

    it('only observes（不再 replan）when several jobs were shown but none is in focus', () => {
      const result = service.check({
        replyText: '这几家店的班次都可以协调的。',
        toolCalls: [],
        userMessage: '这几个店的班次是怎么排的',
        memorySnapshot: ambiguousSnapshot,
        chatId: 'chat-1',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'job_detail_lookup_required',
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
          }),
        ]),
      );
    });

    it('still replans when the focus job is known but was not looked up', () => {
      const result = service.check({
        replyText: '这家的班次是 09:00-18:00。',
        toolCalls: [],
        userMessage: '这家班次怎么排',
        memorySnapshot: {
          ...ambiguousSnapshot,
          currentFocusJob: { jobId: 111, availableDetailFields: [] },
        },
        chatId: 'chat-1',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'job_detail_lookup_required',
            action: GUARDRAIL_ACTION.REPLAN,
            currentReplySendable: false,
          }),
        ]),
      );
    });
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

    // 2026-07-21 守卫审计：窗口内 16 条命中 rewrite 二审通过率 0%，抽样 6/6 假阳。
    // 两类根因各补一组回归。
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
      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'job_detail_lookup_required',
      );
    });
  });

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
      // 婚育类禁止对外询问、展示或作为拒绝理由
      '这个岗位的婚育要求是已婚已育',
      '方便说下你的婚姻状况吗？',
      '你现在是未婚还是已婚呢？',
      '你结婚了吗，现在有孩子吗？',
      '这家仅限已育人员',
      '你的婚育状况不符合门店要求',
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
      '这个岗位只写了要食品健康证，没提地域限制。具体外地证能不能用我帮你跟门店确认下',
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
      // 明确没有婚育门槛的安抚句不是筛选条件外露
      '这个岗位没有婚育要求',
      '这家不看婚育要求，放心报名',
    ];
    it.each(passCases)('does not flag compliant phrasing: %s', (reply) => {
      const result = check(reply);
      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'discriminatory_screening_leak',
      );
    });

    it('routes P0 interceptions to monitoring alerts without creating BadCase', async () => {
      const result = check('这个岗位不要新疆西藏籍的');
      expect(result.hit).toBe(true);
      expect(result.contradictions[0].currentReplySendable).toBe(false);
      await flushAsync();
      expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'output_guardrail_p0_intercepted',
          source: expect.objectContaining({ action: 'intercept_p0_reply' }),
        }),
      );
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
      expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
    });
  });

  describe('existing rules regression', () => {
    it.each([
      ['badcase 原始畸形 thinking 文本', '<think>\n<think>7144679778889'],
      ['成对 thinking 标签也不得进入正文', '<think>内部推理</think>正常回复'],
      ['12 位以上纯数字异常回复', '7144679778889'],
    ])('blocks invalid model output: %s', (_name, reply) => {
      const result = check(reply);

      expect(result.hit).toBe(true);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'invalid_model_output',
            action: GUARDRAIL_ACTION.BLOCK,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it.each(['13800138000', '30元/小时', '面试编号 7144679778889'])(
      'does not treat a normal candidate-facing value as invalid model output: %s',
      (reply) => {
        const result = check(reply);
        expect(result.contradictions.map((c) => c.ruleId)).not.toContain('invalid_model_output');
      },
    );

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

    it('replans when applied brand is replaced by another brand recommendation（§11 读 queryMeta.brand）', () => {
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
              queryMeta: {
                brand: {
                  filterMode: 'enforce',
                  brandSource: 'model_input',
                  appliedBrandIds: [],
                  appliedCanonicalNames: ['肯德基'],
                  rejected: [],
                },
              },
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
              queryMeta: {
                brand: {
                  filterMode: 'enforce',
                  brandSource: 'model_input',
                  appliedBrandIds: [],
                  appliedCanonicalNames: ['必胜客'],
                  rejected: [],
                },
              },
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
            result: {
              result: [],
              queryMeta: {
                brand: {
                  filterMode: 'enforce',
                  brandSource: 'model_input',
                  appliedBrandIds: [],
                  appliedCanonicalNames: ['肯德基'],
                  rejected: [],
                },
              },
            },
            resultCount: 0,
            status: 'empty',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('requested_brand_mismatch');
    });

    it('守卫只读标准化查询元数据：模型原始 brandAliasList 不再是对账依据（§14.4）', () => {
      const result = service.check({
        replyText: '麦当劳（静安寺店）- 服务员，距离2公里，时薪24元。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            // 模型原始参数写着肯德基，但工具入口标准化后没有形成品牌过滤
            //（queryMeta.brand 缺失/无 applied）——不得据原始参数触发对账
            args: { brandAliasList: ['肯德基'] },
            result: { result: [{ jobId: 1, brandName: '麦当劳' }] },
            resultCount: 1,
            status: 'ok',
          },
        ] as never,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('requested_brand_mismatch');
    });

    it('被拒绝的昵称/模型别名不触发错误品牌守卫（rejected 不在 applied 里，§14.4）', () => {
      const result = service.check({
        replyText: '麦当劳（静安寺店）- 服务员，距离2公里，时薪24元。',
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { brandAliasList: ['Gattouzo'] },
            result: {
              result: [{ jobId: 1, brandName: '麦当劳' }],
              queryMeta: {
                brand: {
                  filterMode: 'enforce',
                  brandSource: 'model_input',
                  appliedBrandIds: [],
                  appliedCanonicalNames: [],
                  rejected: [{ input: 'Gattouzo', reason: 'unmatched' }],
                },
              },
            },
            resultCount: 1,
            status: 'ok',
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
              queryMeta: {
                brand: {
                  filterMode: 'enforce',
                  brandSource: 'model_input',
                  appliedBrandIds: [],
                  appliedCanonicalNames: [],
                  rejected: [{ input: '刘姐妹', reason: 'unmatched' }],
                  fuzzySuggestions: [{ inputAlias: '刘姐妹', brandName: '成都你六姐', score: 8 }],
                },
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
              queryMeta: {
                brand: {
                  filterMode: 'enforce',
                  brandSource: 'model_input',
                  appliedBrandIds: [],
                  appliedCanonicalNames: [],
                  rejected: [{ input: '刘姐妹', reason: 'unmatched' }],
                  fuzzySuggestions: [{ inputAlias: '刘姐妹', brandName: '成都你六姐', score: 8 }],
                },
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

    it('allows explaining that a previous recommendation used the regular part-time path', () => {
      const result = service.check({
        replyText:
          '刚核了一下，你找的是暑假工，之前的推荐是按常规兼职走的。抱歉，附近暂时没有合适的暑假工岗位。',
        toolCalls: [summerWorkerEmptyToolCall],
        userMessage: '我只找暑假工',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'summer_worker_alternative_upsell',
      );
    });

    it('still flags a real upsell in another sentence after the historical explanation', () => {
      const result = service.check({
        replyText: '之前的推荐是按常规兼职走的。不过附近还有长期兼职，要不要继续看看？',
        toolCalls: [summerWorkerEmptyToolCall],
        userMessage: '我只找暑假工',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
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

    it('revises cross-turn upsell while the recent candidate intent is still summer work', () => {
      const result = service.check({
        replyText: '上面推的奥乐齐属于普通兼职，如果你愿意按普通兼职身份报名，那些是可以做的。',
        toolCalls: [],
        userMessage: '不能做这种兼职的吗',
        recentUserTexts: ['暑假工短期的兼职', '等上学了也是有空的话出来做做', '不能做这种兼职的吗'],
        silent: true,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'summer_worker_alternative_upsell',
            action: GUARDRAIL_ACTION.REVISE,
          }),
        ]),
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

    const identityMissingPrecheck = [
      {
        toolName: 'duliday_interview_precheck',
        args: {},
        result: {
          nextAction: 'collect_fields',
          bookingChecklist: { missingFields: ['性别', '健康证情况', '身份'] },
          identityFieldGuard: { mustAskCandidate: true },
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

    it('flags autofilling social identity while precheck still marks 身份 missing (batch_6a54b296)', () => {
      const result = service.check({
        replyText: '另外身份帮你填了社会人士，出勤也先按“是”登记了哈。',
        toolCalls: identityMissingPrecheck,
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

    it('flags reclassifying a known student as social identity without a clear self-report (chat 6a572512)', () => {
      const result = service.check({
        replyText: '那这段时间就不算在校生了，完全可以按社会身份来做兼职。',
        toolCalls: [],
        userMessage: '高中毕业了，在等大学通知书',
        memorySnapshot: {
          currentStage: 'job_consultation',
          presentedJobIds: [520361],
          recommendedJobIds: [520361],
          profileKeys: null,
          sessionFacts: {
            'interview.is_student': { value: true, confidence: 'medium', source: 'llm' },
          },
        },
        silent: true,
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

    it('allows social identity wording after an explicit candidate self-report', () => {
      const result = service.check({
        replyText: '好的，你现在是社会人士，可以按社会身份登记。',
        toolCalls: [],
        userMessage: '我现在不是学生，是社会人士',
        memorySnapshot: {
          currentStage: 'job_consultation',
          presentedJobIds: null,
          recommendedJobIds: null,
          profileKeys: null,
          sessionFacts: {
            'interview.is_student': { value: true, confidence: 'medium', source: 'llm' },
          },
        },
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'identity_misregistration_coaching',
      );
    });

    it('allows accurately relaying that a job is not open to students', () => {
      const result = service.check({
        replyText: '这家不是学生能做的岗位，我继续帮你找接受学生的岗位。',
        toolCalls: [],
        userMessage: '我是学生',
        memorySnapshot: {
          currentStage: 'job_consultation',
          presentedJobIds: null,
          recommendedJobIds: null,
          profileKeys: null,
          sessionFacts: { 'interview.is_student': true },
        },
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
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
  });

  describe('机器判例统一由 runner 写 guardrail_review_records', () => {
    it('observe-only 命中：返回完整裁决，不创建外部反馈', () => {
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
    });

    it('enforce + observe 混合：返回全部命中供统一守卫日志归档', () => {
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
    });
  });

  describe('meta_narration_reply (badcase chat 6a5740ff 真人接管期间静默旁白被投递)', () => {
    it.each([
      [
        'badcase 原文：真人接管静默旁白',
        '（本轮为真人招募经理与候选人直接沟通，AI 保持静默，不插入回复）',
      ],
      ['半角括号 + 不回复元词', '(本轮不回复，等待候选人补充信息)'],
      ['沉默变体', '（AI 保持沉默，等待真人经理继续跟进）'],
      ['人工操作记录变体', '（此消息为人工操作记录，无需回复）'],
    ])('blocks bracket-wrapped meta narration: %s', (_name, reply) => {
      const result = check(reply);

      expect(result.hit).toBe(true);
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'meta_narration_reply',
            action: GUARDRAIL_ACTION.BLOCK,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it.each([
      ['正文内合法括号补充', '到店跟前台说"独立客招聘介绍来的"就行（记得带好健康证）'],
      ['整条括号但无元词', '（明天下午 1 点见哈）'],
      ['含元词但未被括号包裹', '你要是一直不回复，这个名额我就先帮别人排上了哈'],
      ['方头括号提醒（另有 internal_output_leak 白名单用例）', '【面试提醒】明天上午10点面试'],
    ])('does not flag legitimate bracket usage: %s', (_name, reply) => {
      const result = check(reply);

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('meta_narration_reply');
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

    it('does not flag persona leakage but still requires real handoff for 同事 follow-up', () => {
      const result = service.check({
        replyText: '这个我帮你问下负责的同事，稍后回复你哈。',
        toolCalls: [],
        chatId: 'chat-1',
      });

      expect(
        result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak'),
      ).toBeUndefined();
      expect(
        result.contradictions.find((c) => c.ruleId === 'handoff_promise_without_handoff'),
      ).toBeDefined();
    });
  });

  describe('handoff_promise_without_handoff (production trace batch_6a54b296…)', () => {
    const productionReply =
      '这边暂时没约上，这家目前报名人数比较多，我让同事帮你确认下名额和后续安排，稍后给你答复哈';

    it('replans when the reply promises colleague follow-up without request_handoff', () => {
      const result = service.check({
        replyText: productionReply,
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: { jobId: 528499 },
            result: { success: false, errorType: 'booking.rejected' },
          },
        ],
        chatId: '6a54b296ce406a6aeede64e5',
      });

      const hit = result.contradictions.find(
        (item) => item.ruleId === 'handoff_promise_without_handoff',
      );
      expect(hit).toMatchObject({
        action: 'replan',
        severity: 'P0',
        currentReplySendable: false,
        repairMode: 'replan',
        repairToolNames: ['request_handoff'],
      });
    });

    it('allows the promise when request_handoff was actually dispatched', () => {
      const result = service.check({
        replyText: productionReply,
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'system_blocked', reason: '报名失败需人工确认' },
            result: { dispatched: true, shortCircuited: true },
          },
        ],
        chatId: 'chat-handoff-ok',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'handoff_promise_without_handoff',
      );
    });

    it('does not accept a failed request_handoff as grounding', () => {
      const result = service.check({
        replyText: '我已经让负责的同事跟进处理，稍后联系你。',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'system_blocked' },
            result: { dispatched: false, shortCircuited: false },
          },
        ],
        chatId: 'chat-handoff-failed',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'handoff_promise_without_handoff',
      );
    });

    it('also replans collective promises phrased with 我们', () => {
      const result = service.check({
        replyText: '我们这边会让门店负责人核实一下，晚点回复你。',
        toolCalls: [],
        chatId: 'chat-collective-handoff-promise',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'handoff_promise_without_handoff',
      );
    });

    it.each([
      '这个岗位的具体安排以门店同事确认结果为准。',
      '我先核对一下现有资料，确认好再回复你。',
      '你可以联系门店负责人咨询具体排班。',
    ])('does not flag a boundary statement without an agent follow-up promise: %s', (replyText) => {
      const result = service.check({ replyText, toolCalls: [], chatId: 'chat-boundary' });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'handoff_promise_without_handoff',
      );
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
