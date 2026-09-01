import { HardRulesService, OUTPUT_RULE_IDS } from '@agent/guardrail/output/hard-rules.service';

describe('HardRulesService — 封闭确定性输出规则', () => {
  const alertNotifier = { sendAlert: jest.fn().mockResolvedValue(undefined) };
  let service: HardRulesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HardRulesService(alertNotifier as never);
  });

  const check = (replyText: string, extra: Record<string, unknown> = {}) =>
    service.check({ replyText, toolCalls: [], silent: true, ...extra } as never);
  const ids = (replyText: string, extra: Record<string, unknown> = {}) =>
    check(replyText, extra).contradictions.map((item) => item.ruleId);

  it('catalog 只包含保留的执行档规则与已恢复的 observe 哨兵', () => {
    expect(OUTPUT_RULE_IDS).toEqual([
      'invalid_model_output',
      'internal_output_leak',
      'meta_narration_reply',
      'identity_misregistration_coaching',
      'experience_fraud_coaching',
      'discriminatory_screening_leak',
      'sensitive_origin_probe',
      'quota_promise',
      'online_interview_location_claim',
      'unsupported_store_status_speculation',
      'booking_receipt_mismatch',
      'interview_time_change_unconfirmed',
      'brand_alias_fuzzy_match_ignored',
      // —— 数据复核后恢复的哨兵 ——
      'human_service_phrase_leak',
      'booking_done_claim_without_submission',
      'cancel_done_claim_without_submission',
      'cancel_done_claim_failed_tool',
      'dangling_reply_promise',
      'requested_brand_mismatch',
      'settlement_cycle_mismatch',
      'proactive_insurance_policy_mention',
    ]);
  });

  it.each([
    ['<think>先分析</think>你好', 'invalid_model_output'],
    ['现在调用 duliday_job_list 查一下', 'internal_output_leak'],
    ['（本轮为真人沟通，AI 保持静默，不插入回复）', 'meta_narration_reply'],
    ['名额放心，我已经帮你留好了', 'quota_promise'],
    ['这家不招外地户籍', 'discriminatory_screening_leak'],
    ['方便问下你老家是哪里？', 'sensitive_origin_probe'],
  ])('封闭文本形态 %s 命中 %s', (replyText, expectedRuleId) => {
    expect(ids(replyText)).toContain(expectedRuleId);
  });

  it('复用已确认学生事实拦截虚假社会人士登记', () => {
    expect(
      ids('身份帮你登记成社会人士了', {
        memorySnapshot: { sessionFacts: { 'interview.is_student': true } },
        userMessage: '那怎么办',
      }),
    ).toContain('identity_misregistration_coaching');
  });

  it('候选人自曝经历造假后才拦截继续造假的封闭指导', () => {
    expect(
      ids('面试官问起经验，你就说有餐饮经验', {
        userMessage: '报名表里的经历是我瞎填的',
      }),
    ).toContain('experience_fraud_coaching');
    expect(ids('面试官问起经验，你就如实说自己的情况')).not.toContain('experience_fraud_coaching');
  });

  it('线上面试回执与到店指引不一致时命中', () => {
    expect(
      ids('面试当天直接去店里就行', {
        toolCalls: [
          {
            toolName: 'send_store_location',
            status: 'ok',
            result: { success: true, destination: 'interview', interviewMethod: 'AI 面试' },
          },
        ],
      }),
    ).toContain('online_interview_location_claim');
  });

  it('只有结构化无匹配回执才拦截门店状态猜测', () => {
    const noMatchTool = {
      toolName: 'duliday_job_list',
      status: 'ok',
      result: {
        errorType: 'job_list.no_results',
        noMatchScript: { nextAction: 'wait_for_inventory' },
      },
    };
    expect(ids('这家应该已经招满了', { toolCalls: [noMatchTool] })).toContain(
      'unsupported_store_status_speculation',
    );
    expect(ids('这家应该已经招满了')).not.toContain('unsupported_store_status_speculation');
    expect(
      ids('这家应该已经招满了', {
        toolCalls: [
          {
            ...noMatchTool,
            result: {
              ...noMatchTool.result,
              noMatchScript: { nextAction: 'group_handoff_complete' },
            },
          },
        ],
      }),
    ).not.toContain('unsupported_store_status_speculation');
  });

  it('预约成功回执必须播报已确认日期', () => {
    expect(
      ids('资料齐了，这就帮你提交预约', {
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            status: 'ok',
            result: { success: true, _confirmedInterviewTimeHuman: '8月6日（周四）14:00' },
          },
        ],
      }),
    ).toContain('booking_receipt_mismatch');
  });

  it('高置信品牌目录回指与无品牌回复矛盾时命中', () => {
    expect(
      ids('暂时没找到这个品牌的在招岗位', {
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            result: {
              queryMeta: {
                brand: { fuzzySuggestions: [{ brandName: '成都你六姐', score: 0.91 }] },
              },
            },
          },
        ],
      }),
    ).toContain('brand_alias_fuzzy_match_ignored');
  });

  it.each([
    '这个岗位一般每周排五天，具体看门店安排',
    '这家岗位选择很多，你可以先看看',
    '稍后有合适岗位我再告诉你',
    '我理解你对前两次推荐不满意',
  ])('开放语义不再由输出规则判断：%s', (replyText) => {
    expect(check(replyText).contradictions).toEqual([]);
  });

  it('只允许现有 runtime override 把命中降为 observe 或关闭', () => {
    const observed = check('名额放心，我已经帮你留好了', {
      hardRuleOverrides: { quota_promise: 'observe' },
    });
    expect(observed.contradictions[0]).toEqual(
      expect.objectContaining({
        ruleId: 'quota_promise',
        action: 'observe',
        currentReplySendable: true,
      }),
    );

    const disabled = check('名额放心，我已经帮你留好了', {
      hardRuleOverrides: { quota_promise: 'off' },
    });
    expect(disabled.contradictions).toEqual([]);
    expect(disabled.overrideHits).toEqual([{ ruleId: 'quota_promise', mode: 'off' }]);
  });
});
