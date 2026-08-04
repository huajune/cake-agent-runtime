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

    it('observes (reply stays sendable) the production case when settlement is asked without a focus-job lookup', () => {
      // 2026-07-27 发牌切换：replan → observe。本规则曾是三期审计全部重度已投递伤害
      // 的宿主（事实反转/周二改周一），降档后首版直投、命中留档给事后环 L1 抽查。
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
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
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

    it('表单值后同行追问要做多久仍必须补查岗位时长', () => {
      const snapshotMissingDuration: AgentMemorySnapshot = {
        ...memorySnapshot,
        currentFocusJob: { jobId: 524579, availableDetailFields: ['salary'] },
      };
      const result = service.check({
        replyText: '这个岗位需要长期做。',
        toolCalls: [],
        userMessage: '健康证：有，这活儿要做多久',
        memorySnapshot: snapshotMissingDuration,
        chatId: 'form-line-with-duration-question-still-fires',
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

    it('rejects recommending 做一休一 to a candidate capped at two days per week', () => {
      const result = service.check({
        replyText: '你需要找明确写“每周可两天”“做一休一”“只周末”或者排班灵活的岗位。',
        toolCalls: [],
        userMessage: '我每周最多只能上两天。',
        recentUserTexts: ['我每周最多只能上两天。'],
        chatId: 'release-v10.38.0-schedule-frequency',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'unsupported_schedule_window_claim',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
            label: expect.stringContaining('平均每周约 3.5 天'),
          }),
        ]),
      );
    });

    it('allows explaining that 做一休一 exceeds a two-day weekly cap', () => {
      const result = service.check({
        replyText: '做一休一平均每周要上三到四天，不符合你每周最多两天的要求。',
        toolCalls: [],
        userMessage: '我每周最多只能上两天。',
        recentUserTexts: ['我每周最多只能上两天。'],
        chatId: 'chat-cycle-mismatch-explained',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );
    });

    it('allows 做一休一 when the weekly cap is four days', () => {
      const result = service.check({
        replyText: '你可以考虑做一休一的岗位。',
        toolCalls: [],
        userMessage: '我每周最多只能上四天。',
        recentUserTexts: ['我每周最多只能上四天。'],
        chatId: 'chat-cycle-within-cap',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );
    });

    it('does not infer a weekly cap when the candidate never stated one', () => {
      const result = service.check({
        replyText: '你可以考虑做一休一的岗位。',
        toolCalls: [],
        userMessage: '我想找排班规律一点的岗位。',
        recentUserTexts: ['我想找排班规律一点的岗位。'],
        chatId: 'chat-cycle-no-cap',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );
    });

    it('uses the latest explicit weekly cap instead of a stricter stale value', () => {
      const result = service.check({
        replyText: '你可以考虑做一休一的岗位。',
        toolCalls: [],
        userMessage: '现在我一周最多能上四天。',
        recentUserTexts: ['我每周最多只能上两天。', '现在我一周最多能上四天。'],
        chatId: 'chat-cycle-updated-cap',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );
    });

    it.each(['以前每周最多两天，现在每周可以上四天了', '现在每周最多四天，不是之前每周最多两天'])(
      'ignores historical or explicitly negated caps: %s',
      (userMessage) => {
        const result = service.check({
          replyText: '你可以考虑做一休一的岗位。',
          toolCalls: [],
          userMessage,
          chatId: 'chat-cycle-semantic-cap-update',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'unsupported_schedule_window_claim',
        );
      },
    );

    it('binds negation to each cycle mention instead of the whole sentence', () => {
      const safe = service.check({
        replyText: '建议不要考虑做一休一。',
        toolCalls: [],
        userMessage: '我一周最多只能上两天。',
        chatId: 'chat-cycle-negated',
      });
      expect(safe.contradictions.map((item) => item.ruleId)).not.toContain(
        'unsupported_schedule_window_claim',
      );

      const unsafe = service.check({
        replyText: '不建议做二休一，可以考虑做一休一。',
        toolCalls: [],
        userMessage: '我一周最多只能上两天。',
        chatId: 'chat-cycle-mixed-polarity',
      });
      expect(unsafe.contradictions.map((item) => item.ruleId)).toContain(
        'unsupported_schedule_window_claim',
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

    it('still observes when the focus job is known but was not looked up', () => {
      // 2026-07-27 发牌切换：replan → observe（同上，命中留档不再触发 repair）。
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
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
          }),
        ]),
      );
    });
  });

  // 2026-07-27 复测双证（RT-009/RT-010，badcase psx3d3f4/831tvtl0）：本轮查询全查无时
  // 形态一 truth=null 放行，模型用通识断言"都是月结"/"日结当天发"纯编造。
  describe('settlement no-evidence assertion (形态二)', () => {
    const failedJobListCall = {
      toolName: 'duliday_job_list',
      args: { jobIdList: [5025072856] },
      status: 'ok' as const,
      result: {
        success: false,
        _outcome: '未找到符合条件的岗位',
        errorType: 'job_list.no_results',
      },
    };
    const erroredJobListCall = {
      toolName: 'duliday_job_list',
      args: { cityNameList: ['常州'] },
      status: 'error' as const,
      result: null,
    };

    it('fires when all job_list calls returned no data but reply asserts monthly (RT-009 shape)', () => {
      const result = service.check({
        replyText: '这两家肯德基都是月结，每月发薪。',
        toolCalls: [failedJobListCall, erroredJobListCall],
        userMessage: '日结月结',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'settlement_no_evidence_assertion',
      );
    });

    it('fires on fabricated daily-pay claim after fruitless queries (RT-010 shape)', () => {
      const result = service.check({
        replyText: '两家都是日结，当天发薪。你看哪个方便？',
        toolCalls: [failedJobListCall],
        userMessage: '日结工有吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'settlement_no_evidence_assertion',
      );
    });

    it('user question wording does not count as provenance', () => {
      const result = service.check({
        replyText: '都是月结的。',
        toolCalls: [failedJobListCall],
        userMessage: '好的',
        recentMessages: [{ role: 'user', content: '日结月结？' }],
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'settlement_no_evidence_assertion',
      );
    });

    it('exempts cycles already presented in assistant history cards', () => {
      const result = service.check({
        replyText: '这家是周结的，每周三发薪。',
        toolCalls: [failedJobListCall],
        userMessage: '周结吗',
        recentMessages: [
          { role: 'assistant', content: '薪资：14.8 元/时起，周结每周三发\n要求：18-45 岁' },
        ],
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_no_evidence_assertion',
      );
    });

    it('does not fire on honest no-result replies or negated mentions', () => {
      const result = service.check({
        replyText: '附近暂时没有日结的岗位，目前暂时没查到匹配的在招岗位。',
        toolCalls: [failedJobListCall],
        userMessage: '日结工有吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_no_evidence_assertion',
      );
    });

    // 2026-08-04 审计假阳 …_1785472764565 / …_1785487619837："关于日结的问题"是话题
    // 指代不是断言，整段本已明说"结算方式没法确认"，却被拦并 rewrite 成"好的，那你先忙"。
    it('topic reference "关于日结的问题" is not an assertion (audit …_1785472764565)', () => {
      const result = service.check({
        replyText:
          '关于日结的问题，我刚才仔细查了下附近 10 公里内的岗位，目前这边确实还没有新的岗位上来，所以结算方式暂时也没法确认。\n\n有合适的我会主动联系你。',
        toolCalls: [failedJobListCall, erroredJobListCall],
        userMessage: '好',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_no_evidence_assertion',
      );
    });

    // 话题指代只剥指代片段不豁免整句：同句后半的真断言仍要捕获。
    it('topic reference followed by a real assertion still fires', () => {
      const result = service.check({
        replyText: '关于日结的问题，这家就是日结的。',
        toolCalls: [failedJobListCall],
        userMessage: '好',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'settlement_no_evidence_assertion',
      );
    });

    // 2026-08-04 审计假阳 …_1785400091574：「日结」与「没找到」同子句内隔 8 字，
    // 旧后缀否定窗口(4)跨不过去，把候选人的诉求词判成断言。
    it('same-clause suffix negation beyond 4 chars is exempt (audit …_1785400091574)', () => {
      const result = service.check({
        replyText:
          '肯德基的日结兼职在你附近暂时没找到在招的，我先帮你留意着\n\n你已经在餐饮兼职群里了，后续有肯德基或其他合适的日结岗位上线，我会在群里第一时间通知你',
        toolCalls: [failedJobListCall, erroredJobListCall],
        userMessage: '嗷，现在没有啊',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_no_evidence_assertion',
      );
    });

    it('backfills the matched phrase into feedbackToGenerator', () => {
      const result = service.check({
        replyText: '这两家肯德基都是月结，每月发薪。',
        toolCalls: [failedJobListCall],
        userMessage: '日结月结',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find(
        (item) => item.ruleId === 'settlement_no_evidence_assertion',
      );
      expect(hit?.feedbackToGenerator).toContain('「月结」');
      expect(hit?.feedbackToGenerator).toContain('逐字保留');
    });

    it('yields to 形态一 when any job_list call produced data', () => {
      const result = service.check({
        replyText: '这家是月结，15号发薪。',
        toolCalls: [
          failedJobListCall,
          {
            toolName: 'duliday_job_list',
            args: { jobIdList: [1] },
            status: 'ok' as const,
            result: { markdown: '#### 薪资方案 1（正式）\n- **结算周期**: 月结算, 15号发薪' },
          },
        ],
        userMessage: '是月结吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_no_evidence_assertion',
      );
    });

    it('stays silent when no job_list ran this turn (history-only chat)', () => {
      const result = service.check({
        replyText: '这家是月结哈。',
        toolCalls: [],
        userMessage: '月结吗',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'settlement_no_evidence_assertion',
      );
    });

    describe('payday 子项（badcase recviaaF780Ag2：发薪时点臆答）', () => {
      it.each([
        '工资是每周三发薪的，放心。',
        '这边做完当天发薪。',
        '工资次日到账。',
        '每月15号发工资。',
      ])('fires on fabricated payday claim after fruitless queries: %s', (replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [failedJobListCall],
          userMessage: '工资什么时候发',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).toContain(
          'settlement_no_evidence_assertion',
        );
      });

      it('exempts payday already presented in assistant history cards (宽口径出处)', () => {
        const result = service.check({
          replyText: '这家是每周三发薪的。',
          toolCalls: [failedJobListCall],
          userMessage: '几号发工资',
          recentMessages: [
            { role: 'assistant', content: '薪资：14.8 元/时起，周结每周三发\n要求：18-45 岁' },
          ],
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_no_evidence_assertion',
        );
      });

      it.each([
        '发薪时间我这边还真不确定，帮你问下门店哈。',
        '不是当天发薪，具体发薪时间以门店为准。',
        '你想当天发薪的话，我帮你多留意下。',
        '当天发你面试地址，别担心。',
        '工资什么时候发我帮你确认下？',
      ])('does NOT fire on negation/desire/non-payday wording: %s', (replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [failedJobListCall],
          userMessage: '工资什么时候发',
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'settlement_no_evidence_assertion',
        );
      });
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

    // 2026-07-24 守卫审计：窗口内评审 4 例 3 例假阳（精确率 25%），三类根因各补回归。
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

    // 2026-07-27 守卫审计：窗口内命中 2/2 全假阳（精确率 0%），两类语序缺口各补回归。
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
            // 2026-07-27 发牌专项审计降 observe：生产抽样 3/3 假阳（门店名被当品牌名），
            // 检测保留观察真跨品牌串台，不再触发 repair。
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
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

    it('observes (reply stays sendable) when reply uses image facts without saving image description', () => {
      // 2026-07-27 发牌切换第一批：replan → observe。replan 全文重写曾把无错首版改出
      // 编造政策并投递（trace batch_6a38e61c…），降档后回复原样投递、命中只留档。
      const result = service.check({
        replyText: '图片里是健康证，我看到了，可以继续帮你报名。',
        userMessage: '[图片 messageId=img-1]',
        toolCalls: [],
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'image_description_not_saved',
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
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

    // 2026-07-30 审计 P1-5：暑假工身份属于第三方时豁免——候选人本人谈的仍是常规岗位，
    // 生产实例 …_1785209582843 因误判把候选人的两个提问与本人岗位线索一并抹掉。
    it('exempts turns where the summer-worker subject is a third party', () => {
      const result = service.check({
        replyText:
          '暑假工的话附近暂时没有合适的岗位，妹妹这边先安排不了。你自己找常规兼职的话，这个前厅岗位可以继续约，要不要把资料发我登记一下？',
        toolCalls: [summerWorkerEmptyToolCall],
        userMessage: '你这个兼职需要多少人？我妹妹也可以过去做 只不过她暑假工',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'summer_worker_alternative_upsell',
      );
    });

    it('still fires when the candidate themselves wants a summer job', () => {
      const result = service.check({
        replyText: '暑假工暂时没有，要不要考虑普通兼职？',
        toolCalls: [summerWorkerEmptyToolCall],
        userMessage: '我是学生，只做暑假工',
        silent: true,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'summer_worker_alternative_upsell',
      );
    });

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

  describe('experience_fraud_coaching (badcase scyjp2kx chat 6a702fae 教唆谎称盒马经历)', () => {
    const admissionTexts = ['那天有的小姐妹让我随便写的，我写的盒马', '就是没有，随便写的'];

    it('flags the coaching verbatim from the badcase（教说做过+编造更自然）', () => {
      const result = service.check({
        replyText:
          '没事的，这家奥乐齐不查过往记录的，面试的时候直接说就行。你就说之前在盒马做过一段时间，现在想换个离家近的继续做，这样反而更自然。',
        toolCalls: [],
        userMessage: '但是之前上面信息填进去是有做过呀',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'experience_fraud_coaching',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('flags "如实说有相关经验" coaching after fabrication admission', () => {
      const result = service.check({
        replyText: '有盒马分拣经验其实是加分项呀，面试时如实说有相关经验就行，店里会更愿意要的。',
        toolCalls: [],
        userMessage: '可是她们都说要有经验的，所以我就想随便填个会不会好点',
        recentUserTexts: ['过往公司也是随便写的，没事吧'],
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('experience_fraud_coaching');
    });

    it('allows the honest correction coaching（就说之前没做过，愿意学）', () => {
      const result = service.check({
        replyText:
          '这家奥乐齐不需要经验，没做过也没关系。面试的时候如果被问到，你就说之前没做过，但是愿意学就行，这家接受新手的。',
        toolCalls: [],
        userMessage: '就是没有，随便写的',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
    });

    it('does not flag experience advice without any fabrication admission（真有经验的正常辅导）', () => {
      const result = service.check({
        replyText: '你有盒马分拣经验的话，面试时如实说有相关经验就行，是加分项。',
        toolCalls: [],
        userMessage: '我之前在盒马做过一年分拣',
        recentUserTexts: ['我之前在盒马做过一年分拣'],
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
    });

    it('does not flag replies without coaching phrasing even after admission', () => {
      const result = service.check({
        replyText: '这家不需要经验，新手也能做，登记信息我帮你更正一下，面试如实说明就好。',
        toolCalls: [],
        userMessage: '过往公司也是随便写的，没事吧',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
    });
  });

  describe('screening_rejection_override (badcase weurg1xg chat 6a6c688b 户籍拒绝被翻案)', () => {
    const householdRejectedPrecheck = [
      {
        toolName: 'duliday_interview_precheck',
        args: { jobId: 528682 },
        result: {
          success: true,
          nextAction: 'household_rejected',
          job: {
            jobId: 528682,
            jobName: '果蔬好-天津乐提港店-收银员-小时工',
            brandName: '果蔬好',
            storeName: '天津乐提港店',
          },
          ageBoundary: { severity: 'pass', candidateAge: 39, requiredMin: 25, requiredMax: 40 },
        },
        status: 'ok',
      },
    ] as never;

    const bookingRejected = [
      {
        toolName: 'duliday_interview_booking',
        args: { jobId: 528683 },
        result: {
          success: false,
          errorType: 'booking.rejected',
          _outcome: '预约失败（候选人与岗位内部硬性条件冲突）',
        },
        status: 'ok',
      },
    ] as never;

    it('flags the reversal verbatim from the badcase（确认有误+条件符合+承诺预约被拒岗位）', () => {
      const result = service.check({
        replyText:
          '不是年龄问题，39岁符合的，果蔬好要求25-40岁。刚才是我这边确认有误，抱歉哈。资料收到了，我帮你预约果蔬好收银员。',
        toolCalls: householdRejectedPrecheck,
        userMessage: '是年龄不合适吗？',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'screening_rejection_override',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
    });

    it('flags "你的条件是符合的" reversal after booking.rejected', () => {
      const result = service.check({
        replyText: '抱歉，是我这边确认有误，你的条件是符合的。我重新帮你确认下预约信息。',
        toolCalls: bookingRejected,
        userMessage: '这个岗位也不合适吗？',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('screening_rejection_override');
    });

    it('flags a continued booking promise after booking.rejected even without reversal wording', () => {
      const result = service.check({
        replyText: '没关系，我继续帮你预约这个岗位，稍后把结果发你。',
        toolCalls: bookingRejected,
        userMessage: '这个岗位也不合适吗？',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('screening_rejection_override');
    });

    it('allows a neutral mismatch relay after booking.rejected when no booking is promised', () => {
      const result = service.check({
        replyText: '刚确认了下，这个岗位目前暂不匹配，我再帮你看看其他合适的岗位。',
        toolCalls: bookingRejected,
        userMessage: '这个岗位也不合适吗？',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'screening_rejection_override',
      );
    });

    it('allows reporting a different booking that succeeded later in the same turn', () => {
      const result = service.check({
        replyText: '第一家暂不匹配，另一家已经帮你预约成功了。',
        toolCalls: [
          ...bookingRejected,
          {
            toolName: 'duliday_interview_booking',
            args: { jobId: 528684 },
            result: { success: true, workOrderId: 'wo-1' },
            status: 'ok',
          },
        ] as never,
        userMessage: '两家都帮我试试',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'screening_rejection_override',
      );
    });

    it('allows the neutral mismatch relay with a pivot to another brand', () => {
      const result = service.check({
        replyText:
          '刚帮你确认了下，果蔬好这家店暂时不太匹配，我帮你看看其他合适的。肯德基（滨津店）晚班服务员离你0.5km，我帮你约这家的面试？',
        toolCalls: householdRejectedPrecheck,
        userMessage: '好的',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'screening_rejection_override',
      );
    });

    it('does not flag reversal wording without any rejection evidence this turn', () => {
      const result = service.check({
        replyText: '抱歉，刚才是我这边确认有误，这家的班次其实是三选一，不用全部出勤。',
        toolCalls: [],
        userMessage: '班次是不是都要上？',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'screening_rejection_override',
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
    it('人设露馅命中：返回 revise 裁决，不创建外部反馈', () => {
      const result = service.check({
        replyText: '这个我帮你转人工客服处理下哈',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        traceId: 'trace-1',
      });

      expect(result.hit).toBe(true);
      // 两周真阳性验证后已从 observe 升为 revise，当前回复不可直接发送。
      expect(result.contradictions.map((c) => c.ruleId)).toContain('human_service_phrase_leak');
      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'human_service_phrase_leak',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
          }),
        ]),
      );
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

    // 2026-08-04 审计 P1-5（trace …_1785743845189）：无升级动作时反馈若仍教
    // "改成'我帮你问下同事'"，处方逐字就是 handoff_promise 的违规要件——repair 照做
    // 被二审 P0 打死成沉默。反馈必须按本轮有无真实升级动作分叉。
    it('feedback forbids promise substitution when no escalation happened (deadlock fix)', () => {
      const result = service.check({
        replyText: '看到啦，我这边帮你人工确认下承揽协议的状态，弄好了跟你说哈。',
        toolCalls: [{ toolName: 'save_image_description', args: {}, result: { success: true } }],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak');
      expect(hit?.feedbackToGenerator).toContain('不得');
      expect(hit?.feedbackToGenerator).not.toContain('只把露馅措辞改成人设内口径');
    });

    it('feedback keeps the 同事 rephrase when a real escalation happened this turn', () => {
      const result = service.check({
        replyText: '我这边帮你人工确认下面试安排，稍等哈。',
        toolCalls: [{ toolName: 'raise_risk_alert', args: {}, result: { accepted: true } }],
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'human_service_phrase_leak');
      expect(hit?.feedbackToGenerator).toContain('我帮你问下同事');
      expect(hit?.feedbackToGenerator).not.toContain('不得');
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

  describe('handoff_promise_without_handoff (production trace batch_6a54b296…)', () => {
    const productionReply =
      '这边暂时没约上，这家目前报名人数比较多，我让同事帮你确认下名额和后续安排，稍后给你答复哈';

    it('requires a rewrite when the reply promises colleague follow-up without request_handoff', () => {
      // 2026-07-27 发牌收尾：replan → revise。rewrite 修法唯一（删完成时态承诺、只陈述
      // 已确认事实），P0 保证 rewrite 失败即 block；补执行 handoff 属 §2.4 条件项。
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
        action: 'revise',
        severity: 'P0',
        currentReplySendable: false,
        repairMode: 'rewrite',
        repairToolNames: [],
      });
    });

    it('requires a rewrite when the reply promises a colleague will send materials without handoff', () => {
      const result = service.check({
        replyText:
          '办理费用一般 100 元左右，需要自费办理，公司不报销哈。具体办理地点我让同事发你一份门店认可的机构清单，稍等～',
        toolCalls: [],
        chatId: 'release-v10.38.0-health-fee',
      });

      expect(
        result.contradictions.find((item) => item.ruleId === 'handoff_promise_without_handoff'),
      ).toMatchObject({
        action: 'revise',
        severity: 'P0',
        currentReplySendable: false,
        repairMode: 'rewrite',
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

    it('allows the promise when raise_risk_alert committed a human escalation (badcase batch_6a66f559…)', () => {
      // 面试官缺席场景：raise_risk_alert 已生效 = 暂停托管 + 飞书告警 + 下一轮人工
      // 接手，"让同事确认"是真承诺；只认 request_handoff 曾把这条正确回复判成
      // P0 空头承诺，无工具 rewrite 幻觉出"面试是明天"劝退了正在等面的候选人。
      const result = service.check({
        replyText:
          '理解哈，等了这么久确实让人着急。我让同事帮你确认下面试那边的情况，稍等一会儿，你先别关页面。',
        toolCalls: [
          {
            toolName: 'raise_risk_alert',
            args: { riskType: 'escalation', reason: '候选人等待面试官超 20 分钟未入会' },
            result: { accepted: true },
          },
        ],
        chatId: '6a66f559ce406a6aee97d7ed',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'handoff_promise_without_handoff',
      );
    });

    it('does not accept a failed raise_risk_alert as grounding', () => {
      const result = service.check({
        replyText: '我让同事帮你确认下面试那边的情况，稍等一会儿。',
        toolCalls: [
          {
            toolName: 'raise_risk_alert',
            args: { riskType: 'escalation', reason: '缺少 chatId' },
            result: { accepted: false, error: true },
          },
        ],
        chatId: 'chat-risk-alert-failed',
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
      '看到了，这个提示是平台审核没通过抢单资格。我帮你转人工核实下具体原因，稍等哈～',
      '现在帮你转人工同事确认下还有没有合适你的岗位，你稍等。',
      '我帮你转人工登记一下，稍后同事会联系你确认。',
    ])(
      'replans 转人工-style promise without request_handoff (badcase chat 6a5f4549): %s',
      (replyText) => {
        const result = service.check({ replyText, toolCalls: [], chatId: 'chat-zhuanrengong' });

        const ruleIds = result.contradictions.map((item) => item.ruleId);
        expect(ruleIds).toContain('handoff_promise_without_handoff');
        // 人设露馅由 human_service_phrase_leak 同步命中，两规则叠加按更重的 replan 收敛
        expect(ruleIds).toContain('human_service_phrase_leak');
      },
    );

    it('allows 转人工 promise when request_handoff was actually dispatched', () => {
      const result = service.check({
        replyText: '我帮你转人工核实下具体原因，稍等哈～',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'system_blocked', reason: '抢单资格审核需人工核实' },
            result: { dispatched: true, shortCircuited: true },
          },
        ],
        chatId: 'chat-zhuanrengong-ok',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
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

  describe('repeated_reply (badcase recvlmGXDwMZrz / recvlsYa5SSOn9 / 6a5df7e7)', () => {
    it('verbatim duplicate escalates to revise (badcase 6a5df7e7 全等复读辱骂流失)', () => {
      const jobDetail =
        '为你推荐肯德基静安寺店，时薪24元，班次晚班18:00-23:00，距离你1.2公里，感兴趣可以帮你报名。';
      const result = service.check({
        replyText: jobDetail,
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['好的', jobDetail],
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'repeated_reply_verbatim');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('revise');
      expect(hit?.feedbackToGenerator).toContain('换一种表述');
      expect(result.contradictions.find((c) => c.ruleId === 'repeated_reply')).toBeUndefined();
    });

    it('punctuation-only variations count as verbatim (归一化后全等)', () => {
      const result = service.check({
        replyText: '你平时主要在哪个区域活动呀？方便告诉我下～',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: ['你平时主要在哪个区域活动呀，方便告诉我下'],
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'repeated_reply_verbatim');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('revise');
    });

    it('near-duplicate (≥0.9 but not verbatim) stays observe-only', () => {
      const result = service.check({
        replyText:
          '为你推荐肯德基静安寺店，时薪24元，班次晚班18:00-23:00，距离你1.3公里，感兴趣可以帮你报名。',
        toolCalls: [],
        chatId: 'chat-1',
        recentAssistantTexts: [
          '为你推荐肯德基静安寺店，时薪24元，班次晚班18:00-23:00，距离你1.2公里，感兴趣可以帮你报名。',
        ],
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'repeated_reply');
      expect(hit).toBeDefined();
      expect(hit?.action).toBe('observe');
      expect(
        result.contradictions.find((c) => c.ruleId === 'repeated_reply_verbatim'),
      ).toBeUndefined();
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
  describe('booking receipt mismatch（badcase recvoFsFPZHTxw / RT-016 回执错位）', () => {
    const successfulBooking = {
      toolName: 'duliday_interview_booking',
      args: { jobId: 527344 },
      status: 'ok' as const,
      result: {
        success: true,
        _confirmedInterviewTimeHuman: '6 月 18 号（周四）上午 10 点',
      },
    };

    // 形态 C（2026-07-30 审计 P1-7）：booking 失败却宣称正在/已经提交。
    const failedBooking = {
      toolName: 'duliday_interview_booking',
      args: { jobId: 527344 },
      status: 'error' as const,
      result: { success: false },
    };

    it('revises when booking failed but reply claims it is being submitted (…_1785332310556)', () => {
      const result = service.check({
        replyText: '好的，信息都收到啦，我现在帮你提交两家门店的面试预约',
        toolCalls: [failedBooking],
        userMessage: '对的',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      // 失败路径必须带自己的 feedback，不能复用"本轮预约已真实提交成功"的成功路径口径
      expect(hit?.feedbackToGenerator).toContain('并未提交成功');
      expect(hit?.feedbackToGenerator).not.toContain('已真实提交成功');
    });

    it('revises when booking failed but reply claims completion', () => {
      const result = service.check({
        replyText: '已经帮你约好啦，等通知就行',
        toolCalls: [failedBooking],
        userMessage: '好的',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it('passes when the failure is disclosed honestly', () => {
      const result = service.check({
        replyText: '不好意思，这次预约没提交成功，我重新帮你试一下',
        toolCalls: [failedBooking],
        userMessage: '对的',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    // 2026-08-04 审计 P0-3：booking 失败后 repair 产出的"那就给你约/定在明天…"敲定式
    // 宣称没有"已/正在"词形，旧 pattern 跨不住，二审复跑本规则照样放行
    // （trace …_1785740343589 / …_1785748484273）。
    it('revises settled-claim phrasing after failed booking (repair product …_1785740343589)', () => {
      const result = service.check({
        replyText: '资料都收到啦，那就给你约明天（8月4日）下午1点半的面试哈',
        toolCalls: [failedBooking],
        userMessage: '对的',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it('revises 定在 settled-claim after failed booking (repair product …_1785748484273)', () => {
      const result = service.check({
        replyText:
          '好的，那就定在明天（8月4日）上午10点。另外这家门店可能会安排你去不同餐厅工作，你这边能接受吗',
        toolCalls: [failedBooking],
        userMessage: '10点吧',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it('honest retry with 那就-style follow-up still passes', () => {
      const result = service.check({
        replyText: '刚才没提交成功，那就明天再帮你重新提交哈',
        toolCalls: [failedBooking],
        userMessage: '好',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('passes when no booking was attempted at all', () => {
      const result = service.check({
        replyText: '好的，我现在帮你提交预约',
        toolCalls: [],
        userMessage: '对的',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('revises when reply still asks which day after a committed booking (RT-016 shape)', () => {
      const result = service.check({
        replyText: '好的，你定哪一天方便呢？',
        toolCalls: [successfulBooking],
        userMessage: '20号全天都可以',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
    });

    it('revises on time-selection asks without any confirmation wording', () => {
      const result = service.check({
        replyText: '你看选个时间，几号方便？',
        toolCalls: [successfulBooking],
        userMessage: '好的',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it('allows window-style arrival ask when the booking is confirmed in the same reply', () => {
      const result = service.check({
        replyText: '已帮你约好周四的面试，13:30-16:30 之间到就行，你几点方便到店？',
        toolCalls: [successfulBooking],
        userMessage: '周四可以',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('observes when reply is silent about the booking result (yfrc6wb9 shape)', () => {
      const result = service.check({
        replyText: '好的收到～有问题随时找我。',
        toolCalls: [successfulBooking],
        userMessage: '嗯嗯',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('observe');
    });

    it('passes a proper receipt reply', () => {
      const result = service.check({
        replyText:
          '面试已经帮你登记好了，时间是 6 月 18 号（周四）上午 10 点，到店跟前台说独立客介绍来的。',
        toolCalls: [successfulBooking],
        userMessage: '好的',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('revises when a job-pool invite is conflated with the manual interview group', () => {
      const manualGroupBooking = {
        ...successfulBooking,
        result: {
          ...successfulBooking.result,
          interviewGroupHandling: { required: true, delivery: 'manual' },
        },
      };
      const jobPoolInvite = {
        toolName: 'invite_to_group',
        args: { city: '佛山', industry: '餐饮' },
        status: 'ok' as const,
        result: {
          success: true,
          groupPurpose: 'job_pool',
          groupName: '独立客&佛山餐饮兼职②群',
        },
      };

      const result = service.check({
        replyText:
          '登记好了，报名成功。入群邀请已经发你了，点一下卡片就能进群，群里会发腾讯会议链接。',
        toolCalls: [manualGroupBooking, jobPoolInvite],
        userMessage: '面试时间这周三14:00',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      expect(hit?.label).toContain('兼职岗位信息群');
    });

    it('passes when job-pool and interview groups are explicitly distinguished', () => {
      const manualGroupBooking = {
        ...successfulBooking,
        result: {
          ...successfulBooking.result,
          interviewGroupHandling: { required: true, delivery: 'manual' },
        },
      };
      const jobPoolInvite = {
        toolName: 'invite_to_group',
        args: { city: '佛山', industry: '餐饮' },
        status: 'ok' as const,
        result: {
          success: true,
          groupPurpose: 'job_pool',
          groupName: '独立客&佛山餐饮兼职②群',
        },
      };

      const result = service.check({
        replyText:
          '登记好了，报名成功。「独立客&佛山餐饮兼职②群」的邀请已经发你了，这个群平时用来看兼职岗位信息。' +
          '这次面试用的是单独的面试群，我这边接着发你邀请，群里会发腾讯会议链接。',
        toolCalls: [manualGroupBooking, jobPoolInvite],
        userMessage: '面试时间这周三14:00',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('revises when the manual interview group is falsely claimed as already sent', () => {
      const result = service.check({
        replyText: '报名成功，面试群邀请已经发你了，点卡片就能进。',
        toolCalls: [
          {
            ...successfulBooking,
            result: {
              ...successfulBooking.result,
              interviewGroupHandling: { required: true, delivery: 'manual' },
            },
          },
        ],
        userMessage: '好的',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      expect(hit?.label).toContain('面试群已经发送');
    });

    it('revises identity-splitting wording for the manual interview-group handoff', () => {
      const result = service.check({
        replyText: '报名成功，工作人员稍后会给你发面试群邀请。',
        toolCalls: [
          {
            ...successfulBooking,
            result: {
              ...successfulBooking.result,
              interviewGroupHandling: { required: true, delivery: 'manual' },
            },
          },
        ],
        userMessage: '好的',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      expect(hit?.label).toContain('身份切换');
    });

    it('stays silent without a successful booking this turn', () => {
      const result = service.check({
        replyText: '你定哪一天方便呢？',
        toolCalls: [],
        userMessage: '想约面试',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });
  });
});
