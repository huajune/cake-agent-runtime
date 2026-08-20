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

  describe('ungrounded generalizations', () => {
    const successfulJobLookup = {
      toolName: 'duliday_job_list',
      args: { cityNameList: ['张家口'] },
      result: {
        resultCount: 1,
        markdown: '班次：组合排班，每周 5 天；健康证：入职前办妥。',
      },
      resultCount: 1,
      status: 'narrow' as const,
    };

    it('revises a weekly-frequency floor generalized from combination scheduling', () => {
      const result = service.check({
        replyText:
          '组合排班不是每天早中晚全上。不过这类排班通常对每周出勤天数有底线要求，你每周最多两天很难匹配。',
        toolCalls: [],
        userMessage:
          '组合排班是不是代表早中晚每天全部都上？我每周最多只能上两天，只解释标签和周频。',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'combination_schedule_weekly_generalization',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
            feedbackToGenerator: expect.stringContaining('每周最多几天是独立的周频约束'),
          }),
        ]),
      );
    });

    it('allows separating combination scheduling from the job-specific weekly requirement', () => {
      const result = service.check({
        replyText:
          '组合排班表示早中晚等班次会组合或轮换安排，不等于一天三个时段全上。每周最多两天是独立的周频约束，是否匹配要另看具体岗位。',
        toolCalls: [],
        userMessage: '组合排班是什么意思？我每周最多只能上两天。',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it('does not let one successful job lookup support a generic combination-schedule claim', () => {
      const result = service.check({
        replyText: '这类排班每周至少要出勤五天，你每周最多两天不匹配。',
        toolCalls: [successfulJobLookup],
        userMessage: '组合排班是不是每天早中晚全上？我每周最多只能上两天。',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it('allows a weekly-frequency claim explicitly scoped to one concrete job', () => {
      const result = service.check({
        replyText:
          '组合排班表示班次会轮换。这个岗位的详情写明每周至少出勤五天，你每周最多两天与该岗位不匹配。',
        toolCalls: [successfulJobLookup],
        userMessage: '组合排班是不是每天早中晚全上？我每周最多只能上两天。',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it('does not treat a failed job lookup as weekly-frequency evidence', () => {
      const result = service.check({
        replyText: '这类排班通常对周出勤有底线，每周两天很难匹配。',
        toolCalls: [
          {
            ...successfulJobLookup,
            result: { errorType: 'JOB_LIST_FAILED' },
            resultCount: 0,
            status: 'error' as const,
          },
        ],
        userMessage: '组合排班是不是每天都要上？我一周只能两天。',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it('does not apply the combination-schedule rule to an unrelated weekly-frequency question', () => {
      const result = service.check({
        replyText: '这个岗位每周出勤有最低要求，两天不匹配。',
        toolCalls: [],
        userMessage: '这个月结岗位一周要上几天？',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it('still revises a generic floor after a safe clause when a contrast introduces the claim', () => {
      const result = service.check({
        replyText: '组合排班不代表固定周频，但这类排班通常有每周出勤底线，两天很难匹配。',
        toolCalls: [],
        userMessage: '组合排班是什么意思？我每周最多只能上两天。',
      });

      expect(result.contradictions.map((item) => item.ruleId)).toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it.each([
      '组合排班和每周出勤是两个维度，具体需要依据岗位要求判断。',
      '组合排班不一定有固定周频，每周具体要看岗位要求。',
    ])('allows a locally bounded combination-schedule explanation: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '组合排班是什么意思？我每周最多只能上两天。',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'combination_schedule_weekly_generalization',
      );
    });

    it('revises an unsupported health-certificate stage proportion while preserving the universal requirement', () => {
      const result = service.check({
        replyText:
          '餐饮岗位按规定最终都是需要办理健康证的。大部分门店录用后再办，只有极少数要求面试前有证。',
        toolCalls: [],
        userMessage: '一般情况下，所有餐饮岗位都必须有食品健康证吗？不同岗位要求会不会不一样？',
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'health_certificate_generalization',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
            feedbackToGenerator: expect.stringContaining('餐饮类工作一律需要食品健康证'),
          }),
        ]),
      );
    });

    it('allows the confirmed universal requirement with a job-specific stage boundary', () => {
      const result = service.check({
        replyText: '餐饮类工作一律需要食品健康证，具体需要在哪个阶段具备，以具体岗位当前要求为准。',
        toolCalls: [],
        userMessage: '所有餐饮岗位都必须有健康证吗？不同岗位会不会不一样？',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'health_certificate_generalization',
      );
    });

    it('allows a health-certificate claim scoped to the returned result set', () => {
      const result = service.check({
        replyText: '这批岗位都要求入职前办理健康证。',
        toolCalls: [successfulJobLookup],
        userMessage: '所有餐饮岗位都必须有健康证吗？',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'health_certificate_generalization',
      );
    });

    it('allows the confirmed industry-wide health-certificate requirement after a job lookup', () => {
      const result = service.check({
        replyText: '所有餐饮岗位最终都需要办理健康证。',
        toolCalls: [successfulJobLookup],
        userMessage: '所有餐饮岗位都必须有健康证吗？',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'health_certificate_generalization',
      );
    });

    it.each(['做餐饮都得办健康证，具体还是要看岗位。', '餐饮类工作一律要健康证。'])(
      'allows the confirmed universal health-certificate requirement: %s',
      (replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [successfulJobLookup],
          userMessage: '一般情况下，所有餐饮岗位都必须有食品健康证吗？',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'health_certificate_generalization',
        );
      },
    );

    it.each([
      '餐饮类工作一律需要健康证，具体办理阶段以岗位要求为准。',
      '一般要看具体岗位，面试前是否需要有证也以岗位为准。',
      '办理阶段通常不能一概而论，面试前还是入职后要看具体岗位。',
    ])('allows a bounded health-certificate stage claim: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '一般情况下，所有餐饮岗位都必须有食品健康证吗？',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'health_certificate_generalization',
      );
    });

    it('does not apply the general-health rule to a fee question or unrelated proportions', () => {
      const result = service.check({
        replyText: '办理费用一般 100 元左右，需要自费；大部分材料现场提交就行。',
        toolCalls: [],
        userMessage: '健康证办理费用是多少？',
      });

      expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
        'health_certificate_generalization',
      );
    });
  });

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

    // trace batch_6a86626bce406a6aee0e0aa0：rewrite 修复版诚实拒绝候选人的 7-3/8-4 诉求，
    // 却因"能排"在别句 + 复述诉求时段被二审再拦，靠 repair_exhausted_fail_open 才没静默。
    describe('honest refusal echoing the candidate window (badcase 6a86626b)', () => {
      const midShiftLookup = {
        toolName: 'duliday_job_list',
        args: { jobIdList: [528551], includeWorkTime: true },
        status: 'ok' as const,
        result: {
          markdown: '班次：10:30-15:00、11:00-14:00、11:00-15:00、11:30-15:30、17:00-22:30',
        },
      };

      it('allows the repaired reply that denies the requested windows', () => {
        const result = service.check({
          replyText:
            '成都你六姐的兼职主要是饭点高峰班次，目前没有早7到晚3或早8到晚4这样完整的班次。\n\n' +
            '现在能排的白班主要是10:30-15:00、11:00-14:00、11:00-15:00、11:30-15:30这些午高峰时段，晚班则是17:00以后的时段。\n\n' +
            '如果您只能做7-3或8-4的班次，那成都你六姐目前的岗位可能不太匹配，我可以帮您看看其他品牌的岗位。',
          toolCalls: [midShiftLookup],
          userMessage: '兼职 7-3 8-4 这个时间有没有',
          memorySnapshot,
          chatId: '6a86626bce406a6aee0e0aa0',
        });

        expect(result.contradictions.map((item) => item.ruleId)).not.toContain(
          'unsupported_schedule_window_claim',
        );
      });

      it('still rejects the first reply that affirms the unlisted windows', () => {
        const result = service.check({
          replyText:
            '有的～成都你六姐兼职主要是饭点高峰班次，你说的7-3、8-4这两个时间段都有能排的班。',
          toolCalls: [midShiftLookup],
          userMessage: '兼职 7-3 8-4 这个时间有没有',
          memorySnapshot,
          chatId: '6a86626bce406a6aee0e0aa0',
        });

        expect(result.contradictions.map((item) => item.ruleId)).toContain(
          'unsupported_schedule_window_claim',
        );
      });

      it('binds negation to the window clause instead of the whole sentence', () => {
        const safe = service.check({
          replyText: '7:00-15:00排不上，但可以给你排11:00-15:00。',
          toolCalls: [midShiftLookup],
          userMessage: '能不能排7-3',
          memorySnapshot,
          chatId: 'chat-window-mixed-polarity',
        });
        expect(safe.contradictions.map((item) => item.ruleId)).not.toContain(
          'unsupported_schedule_window_claim',
        );

        const unsafe = service.check({
          replyText: '7:00-15:00排不上，但可以给你排8:00-12:00。',
          toolCalls: [midShiftLookup],
          userMessage: '能不能排7-3',
          memorySnapshot,
          chatId: 'chat-window-mixed-polarity-unsafe',
        });
        expect(unsafe.contradictions.map((item) => item.ruleId)).toContain(
          'unsupported_schedule_window_claim',
        );
      });
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
      '这家对常驻地有要求，你方便说下你常驻在哪个城市吗？',
      '门店对居住地有限制，你现在住哪里？',
      '这家对常驻地有明确要求，你方便说下吗？',
      '门店对居住地有一定限制，你现在住哪里？',
      '这个岗位对所在城市有硬性要求。',
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
      '方便问一下你常驻在哪个城市吗？我帮你看下匹配的岗位',
      '这家对常驻地没有要求，外地居住也可以',
      '这家对常驻地不作要求，外地也可以',
      '门店对居住地不设限制，放心报名',
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

  describe('hardRuleOverrides runtime downgrade', () => {
    const productionShapedReply =
      '[引用 候选人：现在报名还来得及吗]\n名额放心，我帮你留着。\n[图片消息]\n[消息发送时间：2026-08-13 16:08:31]';

    it('off drops the hit while retaining an override audit signal', () => {
      const result = service.check({
        replyText: productionShapedReply,
        toolCalls: [],
        hardRuleOverrides: { quota_promise: 'off' },
      });

      expect(result.hit).toBe(false);
      expect(result.contradictions).toEqual([]);
      expect(result.overrideHits).toEqual([{ ruleId: 'quota_promise', mode: 'off' }]);
    });

    it('observe forces a veto rule into the sendable observe tier', () => {
      const result = service.check({
        replyText: productionShapedReply,
        toolCalls: [],
        hardRuleOverrides: { quota_promise: 'observe' },
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'quota_promise',
            action: GUARDRAIL_ACTION.OBSERVE,
            currentReplySendable: true,
          }),
        ]),
      );
      expect(result.overrideHits).toEqual([{ ruleId: 'quota_promise', mode: 'observe' }]);
    });

    it('ignores and warns on an unknown ruleId without changing known rule behavior', () => {
      const warn = jest.spyOn((service as any).logger, 'warn');

      const result = service.check({
        replyText: productionShapedReply,
        toolCalls: [],
        hardRuleOverrides: { catalog_rule_that_does_not_exist: 'off' },
      });

      expect(result.contradictions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'quota_promise',
            action: GUARDRAIL_ACTION.BLOCK,
            currentReplySendable: false,
          }),
        ]),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '忽略未知 hardRuleOverrides ruleId: catalog_rule_that_does_not_exist',
        ),
      );
    });

    it('an absent override and an empty override preserve the exact existing result shape', () => {
      const withoutConfig = service.check({ replyText: productionShapedReply, toolCalls: [] });
      const withEmptyConfig = service.check({
        replyText: productionShapedReply,
        toolCalls: [],
        hardRuleOverrides: {},
      });

      expect(withEmptyConfig).toEqual(withoutConfig);
      expect(withoutConfig).not.toHaveProperty('overrideHits');
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
            'interview.is_student': { value: true, confidence: 'medium', source: 'model' },
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
            'interview.is_student': { value: true, confidence: 'medium', source: 'model' },
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

    it.each([
      '面试时建议把这段经历包装成做过盒马分拣。',
      '把工作经历美化成有盒马经验，会更容易通过。',
    ])('flags packaging fabricated experience without an explicit speech cue: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('experience_fraud_coaching');
    });

    it.each([
      '不要把这段经历包装成做过盒马，应如实说明。',
      '把经历包装成有盒马经验的说法不真实，要改回真实经历。',
      '与其说自己有相关经验，不如如实说没有。',
    ])('allows explicit rejection or correction of fabricated experience: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
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

    it.each([
      '建议面试时如实说没有相关经验，表达愿意学、能吃苦。',
      '面试时请如实说自己未有这方面经验，但愿意从头学习。',
      '可以坦诚说自己无相关经验，不要继续使用虚假经历。',
      '你就说之前没有在盒马做过，愿意学。',
      '面试时说自己不具有相关经验。',
      '不要说有相关经验，应该如实说明没有做过。',
      '你不能就说之前在盒马做过，要如实说明。',
      '不能认为门店不查过往记录，还是要如实说明。',
      '“门店不查记录”这种说法不对，不能抱侥幸。',
    ])('allows negated experience claims after fabrication admission: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
    });

    it.each([
      '别说没做过，直接说有相关经验。',
      '我不能承诺录用，但你就说之前在盒马做过。',
      '没事，门店不会核查报名资料。',
      '虽然不能保证门店不查记录，但你就说之前做过。',
      '你就说没做过分拣，但在盒马干过一段时间。',
      '你就说没有相关经验，但有盒马经历。',
      '不要说自己没经验而是有相关经验。',
      '不是不能说之前在盒马做过。',
      '面试时说明自己有盒马经验就行。',
      '面试时声称自己有盒马经验就行。',
      '面试时表示自己有盒马经验就行。',
      '别担心，面试时就说有相关经验。',
      '面试时不能不说自己有相关经验。',
      '面试时不得不说自己有相关经验。',
      '面试时先如实说有没有相关经验都行，但你就说有相关经验。',
      '面试时先如实说有还是没有相关经验都行，但你就说有相关经验。',
      '面试时就讲自己有相关经验。',
      '跟面试官讲自己在盒马做过。',
      '面试时告诉店长自己有相关经验。',
      '面试官问起就答有相关经验。',
      '面试时你就说有相关经验才行。',
      '你得说有三年经验才能报名。',
      '面试时说有盒马经验才能应聘。',
    ])('still flags positive coaching when another negated phrase is present: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('experience_fraud_coaching');
    });

    it.each([
      '面试官问有经验吗，你就说有',
      '如果问你有没有经验，就回答有',
      '如果问你有没有经验，就答“有”',
      '面试时别忘了说自己有相关经验',
      '不要忘记告诉店长自己在盒马做过',
      '别漏说自己有盒马经验',
    ])('flags affirmative coaching with an elliptical answer or non-omission: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('experience_fraud_coaching');
    });

    it.each([
      '不要在面试时说有相关经验，应如实说明。',
      '我不建议你说有相关经验。',
      '面试时要如实说有没有相关经验。',
      '面试时如实说自己到底有没有相关经验。',
      '面试时如实说有无经验都可以，关键是不能编造。',
      '面试时如实说有还是没有相关经验。',
      '面试时说有或者没有相关经验都行，不能编。',
      '面试时照实说有或没有相关经验。',
      '面试时如实说明自己有过什么经验、没做过什么。',
      '面试时说有必要说明自己的真实经历。',
      '不要说岗位应该有相关经验要求，应说明自己没经验。',
      '岗位说明有相关经验要求，但你没有相关经验，应如实说明。',
      '不要跟面试官说有相关经验，应如实说明。',
      '不能对面试官说自己有盒马经验。',
      '不建议在面试时跟店长说有相关经验。',
      '别当着店长的面说自己做过。',
      '不要再说自己有相关经验。',
      '不要主动说自己有相关经验。',
      '不要继续说有经验。',
      '不要轻易说自己有相关经验。',
      '不要随便说自己有盒马经验。',
      '不要在面试的时候说有相关经验。',
      '不要和面试官说自己做过。',
      '不建议你在面试的时候说有经验。',
      '千万不要再随便说自己有经验。',
      '请勿再说自己有相关经验，要如实说明。',
      '不可以随便说自己有相关经验。',
      '面试时如实说明自己有哪方面的经验。',
      '这不代表门店不查记录。',
      '并不是说门店不查记录。',
      '我没有说门店不查记录。',
    ])('allows locally negated coaching or record-check claims: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
    });

    it.each([
      '你刚才说自己有盒马经验是随便填的，我明白了',
      '你说自己有盒马经验是瞎填的，我明白了',
      '你是说报名表里写的有盒马经验其实不真实吗？',
      '你刚才告诉我自己有盒马经验是瞎填的，我会按真实情况处理',
      '如果你确实有其他相关经验，可以说有相关经验；没有就如实说没有',
      '只有确实做过，面试时才能说自己做过',
      '只有你确实有相关经验时，才能说有相关经验',
      '前提是你确实做过盒马，面试时才能说自己做过',
      '岗位介绍说有相关经验会优先，但没有就如实说明',
      '面试官说有相关经验会优先，但你没有就如实说没有',
      '招聘信息表示有经验会加分，但你没有就如实说没有',
      '门店告诉你有相关经验会加分，但没有也没关系',
      '我没法答应你有经验就一定会录用',
      '没必要跟面试官说自己有相关经验，如实说明没有即可',
      '无需声称自己有盒马经验',
      '不必说自己做过',
      '你不该说自己有盒马经验',
      '面试时如实回答做过还是没做过',
    ])(
      'allows replay, truthful conditions, third-party facts, and genuine negation: %s',
      (replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [],
          userMessage: '我报名表里的盒马经历是随便写的。',
          recentUserTexts: admissionTexts,
        });

        expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
          'experience_fraud_coaching',
        );
      },
    );

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
        replyText: '这家不需要经验，新手也能做。登记信息能改就从原渠道更正，面试时如实说明就好。',
        toolCalls: [],
        userMessage: '过往公司也是随便写的，没事吧',
        recentUserTexts: admissionTexts,
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('experience_fraud_coaching');
    });

    it('revises an unsupported promise to edit the fabricated application record (release v10.38.0 case 05)', () => {
      const result = service.check({
        replyText:
          '面试时建议如实说没有做过，不用靠编经历来加分。要不我把你报名表里的这段经历先改掉？',
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
      });

      const hit = result.contradictions.find(
        (c) => c.ruleId === 'application_record_update_promise',
      );
      expect(hit?.action).toBe('revise');
      expect(hit?.feedbackToGenerator).toContain('原报名渠道');
    });

    it.each([
      ['省略宾语', '你重新说一下真实情况，我帮你更新一下。'],
      ['宾语前置', '报名表我帮你改一下。'],
      ['改下短形', '我帮你改下报名表。'],
      ['近轮指向明确的省略主语动作', '好，我来改一下。'],
      ['引号强调的真实承诺', '我可以按你说的“帮你更新报名信息”。'],
      ['句末口语尾缀', '我帮你更新一下哈。'],
      ['连续白名单修饰词', '我这边可以先帮你更新一下。'],
      ['省略第一人称主语', '好的，帮你更新一下。'],
    ])('revises unsupported application-record promises with %s', (_shape, replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain(
        'application_record_update_promise',
      );
    });

    it.each([
      ['否定能力归属', '不是我帮你修改报名表，需要你从原渠道自己改。'],
      ['引用旧错误话术', '这里不能说“我帮你更新报名信息”，你要自己更正。'],
      ['主语后的明确否定', '我不能帮你把报名表改掉，请从原渠道更正。'],
      ['主语后的能力否定', '我无法把报名表改掉，只能请你自行更正。'],
      ['反向归属否定', '不用我帮你更新报名信息，请你自己从原渠道操作。'],
      ['上一版错误话术复述', '上一版“我帮你更新报名信息”的说法不对，请你自行更正。'],
      ['引用后否定做不到', '“我帮你改报名表”这件事我做不了，你得从原渠道改。'],
      ['引用后否定办不到', '“我帮你更新报名信息”这个我办不到，请你自己更正。'],
    ])('allows a compliant repair that %s', (_shape, replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'application_record_update_promise',
      );
    });

    it('passes the second guardrail review after an unsafe draft is repaired', () => {
      const unsafeDraft = service.check({
        replyText: '这段经历我帮你改一下。',
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
      });
      const repairedDraft = service.check({
        replyText: '不能由我修改报名表，请从原报名渠道自行更正。',
        toolCalls: [],
        userMessage: '我报名表里的盒马经历是随便写的。',
      });

      expect(unsafeDraft.contradictions.map((c) => c.ruleId)).toContain(
        'application_record_update_promise',
      );
      expect(repairedDraft.contradictions.map((c) => c.ruleId)).not.toContain(
        'application_record_update_promise',
      );
    });

    it('allows telling the candidate to correct the record themselves', () => {
      const result = service.check({
        replyText:
          '别继续说有这段经历。能从原报名渠道更正就先更正，改不了就在面试时主动说明真实情况。',
        toolCalls: [],
        userMessage: '盒马经历是我瞎填的。',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'application_record_update_promise',
      );
    });

    it('does not infer a fabricated record without candidate admission', () => {
      const result = service.check({
        replyText: '我可以帮你更新报名信息。',
        toolCalls: [],
        userMessage: '我的联系方式换了。',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain(
        'application_record_update_promise',
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

  describe('repeated_reply (badcase recvlmGXDwMZrz / recvlsYa5SSOn9 / 6a5df7e7)', () => {
    it('verbatim duplicate is observe-only after deterministic delivery-shaped pruning', () => {
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
      expect(hit?.action).toBe('observe');
      expect(hit?.currentReplySendable).toBe(true);
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
      expect(hit?.action).toBe('observe');
    });

    it('near-duplicate (≥0.85 but not verbatim) stays observe-only', () => {
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

    it('revises an unsupported immediate retry promise even when failure is disclosed', () => {
      const result = service.check({
        replyText: '不好意思，这次预约没提交成功，我重新帮你试一下',
        toolCalls: [failedBooking],
        userMessage: '对的',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      expect(hit?.feedbackToGenerator).toContain('不得承诺以后重试');
    });

    it('passes a terminal factual failure disclosure without any future promise', () => {
      const result = service.check({
        replyText: '不好意思，这次预约没提交成功。',
        toolCalls: [failedBooking],
        userMessage: '只告诉我这次成功没，不要再提交。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it.each([
      '不好意思，这次预约没提交成功。我不能承诺稍后再试。',
      '不好意思，这次预约没提交成功。“我稍后再试”这种承诺不能说。',
    ])('allows an explicit denial of an unsupported retry promise: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [failedBooking],
        userMessage: '只告诉我这次成功没，不要再提交。',
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

    it('revises a future retry promise after an honest failure disclosure', () => {
      const result = service.check({
        replyText: '刚才没提交成功，那就明天再帮你重新提交哈',
        toolCalls: [failedBooking],
        userMessage: '好',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
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

    it('revises when candidate says not to book but reply still pushes registration (release v10.38.0 case 09)', () => {
      const result = service.check({
        replyText:
          '到店前需要先帮你报名约面，不然店里没法接待。你先登记下，我安排个时间让你过去，这样门店也知道你要来。',
        toolCalls: [],
        userMessage:
          '我还没报名也没约面，想先自己去门店看看情况，可以吗？先别帮我报名，也别发定位。',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      expect(hit?.feedbackToGenerator).toContain('尊重候选人暂不报名');
    });

    it('revises a softer booking CTA after the candidate explicitly opts out', () => {
      const result = service.check({
        replyText: '到店前需要先报名约面，不然店里没法接待。你方便的话我先帮你登记下？',
        toolCalls: [],
        userMessage: '我先不预约，只想问能不能直接去。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it.each([
      '那先登记一下，我再安排时间。',
      '你先把报名信息填一下。',
      '把资料发我，我给你安排个时间过去。',
      '咱们先登记下。',
      '我来安排个面试时间给你。',
      '我现在给你安排个时间。',
    ])('revises additional booking advances after an explicit opt-out: %s', (replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage: '先别帮我报名。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it.each(['我不想报名了。', '暂缓报名。', '报名先放一放。', '先放一放。'])(
      'recognizes a natural current booking opt-out: %s',
      (userMessage) => {
        const result = service.check({
          replyText: '我现在给你安排个时间。',
          toolCalls: [],
          userMessage,
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
      },
    );

    it.each([
      ['先不要提交。', '我先帮你报名。'],
      ['先别给我报了。', '我先帮你报名。'],
      ['我先不报名。', '那登记一下吧。'],
    ])('recognizes additional opt-out wording: %s', (userMessage, replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it.each([
      ['我先不报名，等我想好了再帮我报名。', '我先帮你报名。'],
      ['先别预约，之后需要时再帮我预约。', '我现在帮你预约。'],
      ['暂时不登记，等我确认后再登记。', '那先登记一下。'],
      ['我先不报名，到时候再帮我报名。', '我先帮你报名。'],
      ['我先不报名，过两天再帮我报名。', '我现在帮你报名。'],
      ['我先不报名，稍后再帮我报名。', '我先帮你报名。'],
      ['我先不报名，晚点再帮我报名。', '我先帮你报名。'],
      ['我先不报名，改天再帮我报名。', '我先帮你报名。'],
      ['我先不报名，想好了再帮我报名。', '我先帮你报名。'],
      ['我先不报名，有需要时再帮我报名。', '我先帮你报名。'],
      ['我先不报名，下次再帮我报名。', '我现在帮你报名。'],
      ['我先不报名，有空再帮我报名。', '我现在帮你报名。'],
      ['我先不报名，过一阵子再帮我报名。', '我现在帮你报名。'],
    ])(
      'does not treat a future conditional authorization as current consent: %s',
      (userMessage, replyText) => {
        const result = service.check({
          replyText,
          toolCalls: [],
          userMessage,
          chatId: 'chat-1',
        });

        expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
      },
    );

    it.each([
      ['先别报名 A 店，帮我报名 B 店。', '那我先帮你报名 B 店。'],
      ['先不预约明天，改约后天。', '那我先帮你预约后天。'],
      ['报名信息不用重复确认了，直接帮我提交。', '那我先帮你报名。'],
      ['我先不报名，算了，那再帮我报名一次。', '那我先帮你报名。'],
      ['我先不报名。现在想好了，帮我报名吧。', '那我先帮你报名。'],
      ['我先不报名，后来考虑好了，现在帮我报名。', '那我先帮你报名。'],
      ['我先不报名，已经决定好了，直接提交吧。', '那我先帮你报名。'],
      ['我之前不想报名，之后想了想，还是帮我报名吧。', '那我先帮你报名。'],
      ['我先不报名，之后考虑了一下，现在帮我报名。', '那我先帮你报名。'],
      ['我先不报名，晚点再说吧，还是帮我报名吧。', '那我先帮你报名。'],
    ])('honors the later positive booking instruction: %s', (userMessage, replyText) => {
      const result = service.check({
        replyText,
        toolCalls: [],
        userMessage,
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('abstains when positive and negative instructions target different stores', () => {
      const result = service.check({
        replyText: '那我先帮你报名B店。',
        toolCalls: [],
        userMessage: 'B店帮我报名，A店先别报名。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('uses the last generic booking instruction after the candidate changes their mind', () => {
      const optOutResult = service.check({
        replyText: '我先帮你报名。',
        toolCalls: [],
        userMessage: '帮我报名吧……算了，报名先放一放。',
        chatId: 'chat-1',
      });
      const proceedResult = service.check({
        replyText: '我先帮你报名。',
        toolCalls: [],
        userMessage: '先别报名，还是帮我报名吧。',
        chatId: 'chat-1',
      });

      expect(optOutResult.contradictions.map((c) => c.ruleId)).toContain(
        'booking_receipt_mismatch',
      );
      expect(proceedResult.contradictions.map((c) => c.ruleId)).not.toContain(
        'booking_receipt_mismatch',
      );
    });

    it('allows an explicitly deferred booking offer after opt-out', () => {
      const result = service.check({
        replyText: '好的，这轮先不报名。等你想好后，我再帮你安排面试时间。',
        toolCalls: [],
        userMessage: '我不想报名了。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('allows the process explanation while respecting the current booking opt-out', () => {
      const result = service.check({
        replyText: '未报名约面时不建议直接到店，不然门店没法接待。好的，这轮先不帮你报名。',
        toolCalls: [],
        userMessage: '先别帮我报名，我只是问问能不能直接去。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it.each([
      '那你先自己看看，后续想报名再找我。',
      '可以，你先去店里看看情况吧。',
      '那就先过去了解一下。',
      '可以直接过去。',
      '可以自行前往。',
    ])('revises encouragement to visit a store after opting out of booking: %s', (replyText) => {
      const result = service.check({
        replyText: '未报名约面直接过去的话门店可能没法接待。' + replyText,
        toolCalls: [],
        userMessage:
          '我还没报名也没约面，想先自己去门店看看情况，可以吗？先别帮我报名，也别发定位。',
        chatId: 'chat-1',
      });

      const hit = result.contradictions.find((c) => c.ruleId === 'booking_receipt_mismatch');
      expect(hit?.action).toBe('revise');
      expect(hit?.feedbackToGenerator).toContain('这轮先不推进');
    });

    it('revises direct-visit encouragement when the store is only implied by context', () => {
      const result = service.check({
        replyText: '可以，你先自己过去看看。',
        toolCalls: [],
        userMessage: '那我自己过去看看，先不报名。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).toContain('booking_receipt_mismatch');
    });

    it('does not mistake job-information review for an encouraged store visit', () => {
      const result = service.check({
        replyText:
          '未报名约面时不建议直接到店，不然门店没法接待。你先自己看看岗位信息，既然暂不报名，这轮先不推进。',
        toolCalls: [],
        userMessage:
          '我还没报名也没约面，想先自己去门店看看情况，可以吗？先别帮我报名，也别发定位。',
        chatId: 'chat-1',
      });

      expect(result.contradictions.map((c) => c.ruleId)).not.toContain('booking_receipt_mismatch');
    });

    it('does not apply the opt-out override when the candidate wants to proceed', () => {
      const result = service.check({
        replyText: '你先登记下，我安排个时间让你过去。',
        toolCalls: [],
        userMessage: '可以，帮我报名吧。',
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
        // 形态 E（2026-08-06）：booking 成功后必须把已建单的日期告诉候选人，
        // 故本用例回复补上「6 月 18 号（周四）」；它检验的是兼职群与面试群的区分，
        // 与是否播报日期无关，补日期不改变本用例的被测点。
        replyText:
          '登记好了，报名成功，面试时间是 6 月 18 号（周四）上午 10 点。' +
          '「独立客&佛山餐饮兼职②群」的邀请已经发你了，这个群平时用来看兼职岗位信息。' +
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
