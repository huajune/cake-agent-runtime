import type { AgentToolCall } from '@agent/generator/generator.types';
import { OutputGuardrailService } from '@agent/guardrail/output/output-guardrail.service';
import { HardRulesService } from '@agent/guardrail/output/rules/hard-rules.service';
import {
  buildStudentAcceptanceEvidence,
  detectStudentAcceptanceContradiction,
  findStudentAcceptanceClaim,
  type StudentAcceptanceEvidence,
} from '@agent/guardrail/output/rules/student-acceptance.rule';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { sessionFactsOf } from '../../../../helpers/session-facts.fixture';
import { testTurnHint, testTurnHints } from '../../../../helpers/turn-hints.fixture';

const KFC_SOCIAL_ONLY: StudentAcceptanceEvidence = {
  candidateIsStudent: true,
  jobs: [
    { jobId: 529083, studentTier: 'social_only' },
    { jobId: 528942, studentTier: 'social_only' },
  ],
};

/** 生产原文（2026-10-09 batch_6ac85778ce406a6aeef8e575_1791515076511）。 */
const INCIDENT_REPLY = '这家接受学生，但月工时要求至少180小时，你能保证每月做满吗？';

function summary(
  jobId: number,
  studentTier?: RecommendedJobSummary['studentTier'],
  laborForm = '兼职',
) {
  return {
    jobId,
    brandName: '肯德基',
    jobName: '服务员',
    storeName: `门店${jobId}`,
    cityName: '上海',
    regionName: null,
    laborForm,
    salaryDesc: null,
    jobCategoryName: null,
    ...(studentTier === undefined ? {} : { studentTier }),
  } satisfies RecommendedJobSummary;
}

describe('student_acceptance_contradiction', () => {
  it('命中生产原文：已确认学生、零工具、已推荐岗位全部仅限社会人士', () => {
    const finding = detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], KFC_SOCIAL_ONLY);

    expect(finding).toEqual(
      expect.objectContaining({
        ruleId: 'student_acceptance_contradiction',
        action: 'observe',
        currentReplySendable: true,
      }),
    );
    expect(finding?.label).toContain('接受学生');
    expect(finding?.label).toContain('529083');
  });

  it.each([
    '学生也可以，月工时要满180小时',
    '这个岗位不限身份哦',
    '这家没有学生限制',
    '学生和社会人士都可以报名',
  ])('其他封闭肯定断言同样命中：%s', (reply) => {
    expect(detectStudentAcceptanceContradiction(reply, [], KFC_SOCIAL_ONLY)).not.toBeNull();
  });

  it('社会身份字段为空的岗位被说成接受学生同样命中', () => {
    expect(
      detectStudentAcceptanceContradiction('这家不限身份，学生也能做', [], {
        candidateIsStudent: true,
        jobs: [{ jobId: 600003, studentTier: 'unspecified' }],
      }),
    ).not.toBeNull();
  });

  it.each([
    '这家只招社会人士，不接受学生哦',
    '这家暂时不收学生，我再帮你看看别的',
    '不好意思，这家不太接受学生',
    '学生可以吗？',
    '我帮你看看其他接受学生的岗位',
    '要不换个接受学生的门店？',
    '入职需要带学生证吗',
  ])('否定、疑问与指向其他岗位的说法不命中：%s', (reply) => {
    expect(detectStudentAcceptanceContradiction(reply, [], KFC_SOCIAL_ONLY)).toBeNull();
  });

  it('已推荐岗位里有一家接受学生时无法判定回复指哪家，不命中', () => {
    expect(
      detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], {
        candidateIsStudent: true,
        jobs: [
          { jobId: 529083, studentTier: 'social_only' },
          { jobId: 600001, studentTier: 'any' },
        ],
      }),
    ).toBeNull();
  });

  it.each(['duliday_job_list', 'duliday_interview_precheck'])(
    '本轮调过 %s（有新鲜岗位要求事实）不命中',
    (toolName) => {
      const toolCalls = [{ toolName, args: {}, result: { success: true } }] as AgentToolCall[];
      expect(
        detectStudentAcceptanceContradiction(INCIDENT_REPLY, toolCalls, KFC_SOCIAL_ONLY),
      ).toBeNull();
    },
  );

  it('学生身份未确认/为否、没有岗位记忆或存在缺档位历史记录时不命中', () => {
    expect(
      detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], {
        ...KFC_SOCIAL_ONLY,
        candidateIsStudent: null,
      }),
    ).toBeNull();
    expect(
      detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], {
        ...KFC_SOCIAL_ONLY,
        candidateIsStudent: false,
      }),
    ).toBeNull();
    expect(
      detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], {
        candidateIsStudent: true,
        jobs: [],
      }),
    ).toBeNull();
    expect(
      detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], {
        candidateIsStudent: true,
        jobs: [
          { jobId: 529083, studentTier: 'social_only' },
          { jobId: 528942, studentTier: null },
        ],
      }),
    ).toBeNull();
    expect(detectStudentAcceptanceContradiction(INCIDENT_REPLY, [], undefined)).toBeNull();
  });

  it('findStudentAcceptanceClaim 返回断言原文', () => {
    expect(findStudentAcceptanceClaim(INCIDENT_REPLY)).toBe('接受学生');
    expect(findStudentAcceptanceClaim('这家只招社会人士')).toBeNull();
  });
});

describe('buildStudentAcceptanceEvidence', () => {
  it('本轮高置信线索优先于会话事实，焦点与已展示岗位按 jobId 去重并取已知档位', () => {
    const evidence = buildStudentAcceptanceEvidence(
      {
        facts: sessionFactsOf({ interview_info: { is_student: false } }),
        presentedJobs: [summary(529083, 'social_only'), summary(528942, 'social_only')],
        currentFocusJob: summary(529083),
      },
      testTurnHints(testTurnHint('interview_info.is_student', true, '候选人自报学生')),
    );

    expect(evidence).toEqual({
      candidateIsStudent: true,
      jobs: [
        { jobId: 529083, studentTier: 'social_only' },
        { jobId: 528942, studentTier: 'social_only' },
      ],
    });
  });

  it('会话事实只认高置信（与提示词硬约束段同一道门）', () => {
    const medium = buildStudentAcceptanceEvidence(
      {
        facts: sessionFactsOf({ interview_info: { is_student: true } }, { confidence: 'medium' }),
        presentedJobs: null,
        currentFocusJob: null,
      },
      null,
    );
    const high = buildStudentAcceptanceEvidence(
      {
        facts: sessionFactsOf({ interview_info: { is_student: true } }),
        presentedJobs: null,
        currentFocusJob: null,
      },
      null,
    );

    expect(medium.candidateIsStudent).toBeNull();
    expect(high.candidateIsStudent).toBe(true);
  });
});

describe('OutputGuardrailService 接入', () => {
  it('从会话记忆与本轮账本线索组装证据，命中只落 observe、不改变出站裁决', async () => {
    const sessionFacts = {
      getSessionState: jest.fn().mockResolvedValue({
        facts: null,
        presentedJobs: [summary(529083, 'social_only'), summary(528942, 'social_only')],
        lastCandidatePool: null,
        currentFocusJob: summary(528942, 'social_only'),
      }),
    };
    const service = new OutputGuardrailService(
      { getAgentReplyConfig: jest.fn().mockResolvedValue({ hardRuleOverrides: {} }) } as never,
      new HardRulesService({ sendAlert: jest.fn().mockResolvedValue(undefined) } as never),
      { getMessages: jest.fn().mockResolvedValue([]) } as never,
      undefined,
      sessionFacts as never,
    );

    const decision = await service.check({
      reply: INCIDENT_REPLY,
      toolCalls: [],
      chatId: 'chat-1',
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'session-1',
      userMessage: '学生',
      silent: true,
      turnLedger: createTurnLedger({
        turnHints: testTurnHints(testTurnHint('interview_info.is_student', true, '学生')),
      }),
    });

    // observe 哨兵只进 ruleIds 落档，出站裁决仍是放行。
    expect(decision.decision).toBe('pass');
    expect(decision.ruleIds).toContain('student_acceptance_contradiction');
    expect(decision.blockedRuleIds).not.toContain('student_acceptance_contradiction');
  });

  /**
   * 2026-10-15 发版前评审（#1396）：意向切到兼职后，Prompt 的可见性门已把全职岗藏起来，
   * 模型看到的是"没有已推荐岗位"；守卫若仍拿这些全职岗对账会把"学生也可以的"误判成指它们。
   */
  it('全职岗全部 social_only、本轮意向为兼职 → 隐藏岗位不进证据，零工具"学生也可以的"不命中', async () => {
    const sessionFacts = {
      getSessionState: jest.fn().mockResolvedValue({
        facts: null,
        presentedJobs: [
          summary(529083, 'social_only', '全职'),
          summary(528942, 'social_only', '全职'),
        ],
        lastCandidatePool: null,
        currentFocusJob: summary(528942, 'social_only', '全职'),
      }),
    };
    const service = new OutputGuardrailService(
      { getAgentReplyConfig: jest.fn().mockResolvedValue({ hardRuleOverrides: {} }) } as never,
      new HardRulesService({ sendAlert: jest.fn().mockResolvedValue(undefined) } as never),
      { getMessages: jest.fn().mockResolvedValue([]) } as never,
      undefined,
      sessionFacts as never,
    );
    const check = (laborFormIntent: Parameters<typeof createTurnLedger>[0]['laborFormIntent']) =>
      service.check({
        reply: '学生也可以的',
        toolCalls: [],
        chatId: 'chat-1',
        userId: 'user-1',
        corpId: 'corp-1',
        sessionId: 'session-1',
        userMessage: '我是学生，想找兼职',
        silent: true,
        turnLedger: createTurnLedger({
          turnHints: testTurnHints(testTurnHint('interview_info.is_student', true, '学生')),
          laborFormIntent,
        }),
      });

    expect((await check({ kind: 'set', value: '兼职' })).ruleIds).not.toContain(
      'student_acceptance_contradiction',
    );
    // 对照：没有切换意向时全职岗仍可见，同一回复照常命中。
    expect((await check({ kind: 'ignore' })).ruleIds).toContain('student_acceptance_contradiction');
  });
});
