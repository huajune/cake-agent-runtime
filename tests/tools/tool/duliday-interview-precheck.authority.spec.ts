import { buildInterviewPrecheckTool } from '@tools/duliday-interview-precheck.tool';
import type { ToolBuildContext } from '@shared-types/tool.types';
import type { AgentEvent } from '@/observability/observer.interface';
import { createToolContext } from '../../helpers/tool-context.fixture';

/**
 * 裁决权改造（宪法 P11 / 执行清单工序 A3·C6·D1·E1）的 precheck 侧行为。
 *
 * 生产形态 fixture 纪律（PR #1000 遗产）：候选人文本一律带消息时间后缀，模型
 * 提交的 quote 是剥后缀后的片段——整句锚定的识别器必须先剥后缀才对得上
 * （[[project_badcase_identity_evidence_deadlock]] 7-15 反转的正是这一条）。
 */

const TIME_SUFFIX = '[消息发送时间：2026-08-12 10:00:00]';

/* eslint-disable @typescript-eslint/no-explicit-any */
const makeJob = (overrides: any = {}) => ({
  basicInfo: {
    jobId: 100,
    brandName: 'KFC',
    jobName: '服务员',
    storeInfo: { storeName: '五角场店' },
    ...(overrides.basicInfo ?? {}),
  },
  hiringRequirement: {
    basicPersonalRequirements: { minAge: 18, maxAge: 45, genderRequirement: '不限' },
    certificate: {},
    remark: '',
  },
  interviewProcess: {
    firstInterview: {
      firstInterviewWay: '线下面试',
      interviewAddress: '上海市杨浦区xx路',
      periodicInterviewTimes: [],
      fixedInterviewTimes: [],
    },
    interviewSupplement: [],
  },
});

describe('precheck 候选人事实裁决权（P11 工序 A3/C6/D1/E1）', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
    fetchSignupWorkOrders: jest.fn(),
  };
  const events: AgentEvent[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
    mockSpongeService.fetchSignupWorkOrders.mockResolvedValue({ total: 0, workOrders: [] });
  });

  const run = async (
    input: Record<string, any>,
    options: {
      mode?: 'shadow' | 'enforce';
      context?: Partial<{
        messages: unknown[];
        currentUserMessage: string;
        sessionFacts: ToolBuildContext['archive']['sessionFacts'];
        candidatePrefillHints: ToolBuildContext['archive']['candidatePrefillHints'];
      }>;
    } = {},
  ) => {
    const context = createToolContext({
      session: { userId: 'user-1', corpId: 'corp-1', sessionId: 'sess-1' },
      archive: {
        ...(options.context?.sessionFacts === undefined
          ? {}
          : { sessionFacts: options.context.sessionFacts }),
        ...(options.context?.candidatePrefillHints === undefined
          ? {}
          : { candidatePrefillHints: options.context.candidatePrefillHints }),
      },
      turnInput: {
        messages: options.context?.messages ?? [],
        ...(options.context?.currentUserMessage === undefined
          ? {}
          : { currentUserMessage: options.context.currentUserMessage }),
      },
    });
    const tool = buildInterviewPrecheckTool(
      mockSpongeService as never,
      { recordEvent: jest.fn() } as never,
      {
        mode: options.mode ?? 'shadow',
        observer: { emit: (event: AgentEvent) => events.push(event) },
      },
    )(context);
    return (await tool.execute(input as any, {
      toolCallId: 't',
      context: {},
      messages: [],
      abortSignal: undefined as any,
    })) as any;
  };

  const factAdjudicationEvent = () =>
    events.find((event) => event.type === 'fact_adjudication') as
      | Extract<AgentEvent, { type: 'fact_adjudication' }>
      | undefined;

  describe('工序 D1：转确认字段带值进收资清单', () => {
    const conflictingClaims = {
      jobId: 100,
      candidateClaims: [
        { field: 'age', value: 24, quote: '我24岁' },
        { field: 'age', value: 26, quote: '写26也行' },
      ],
    };
    const conflictingMessages = {
      messages: [
        { role: 'user', content: `我24岁 ${TIME_SUFFIX}` },
        { role: 'user', content: `写26也行 ${TIME_SUFFIX}` },
      ],
    };

    it('enforce 下值仍进模板，只挂「如有误请改」，不把候选人打回重报', async () => {
      const result = await run(
        conflictingClaims,
        {
          mode: 'enforce',
          context: {
            ...conflictingMessages,
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.factAdjudication.needsConfirmationFields).toContain('age');
      // 旧行为（连坐互杀）会让年龄回到 missingFields，候选人被从头重问。
      expect(result.bookingChecklist.templateText).toContain('年龄：26（如有误请改）');
      expect(result.bookingChecklist.prefilledConfirmationFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: '年龄', reason: 'evidence_needs_confirmation' }),
        ]),
      );
    });

    it('shadow 下只报不改（迁移三阶段 P0 零行为变化）', async () => {
      const result = await run(conflictingClaims, { context: { ...conflictingMessages } });

      // 裁决结论照常回给模型（观测 + 行动指引），但清单一个字都不动。
      expect(result.factAdjudication.needsConfirmationFields).toContain('age');
      expect(result.bookingChecklist.templateText).not.toContain('如有误请改');
      expect(result.bookingChecklist.prefilledConfirmationFields).toBeUndefined();
    });
  });

  describe('工序 A3：带值求证推广到全字段', () => {
    it('medium 置信学历借进模板并随表求证，不升级为候选人自陈', async () => {
      const result = await run(
        { jobId: 100 },
        {
          context: {
            candidatePrefillHints: {
              education: { value: '大专', reason: 'medium_confidence' },
            },
          },
        },
      );

      expect(result.bookingChecklist.templateText).toContain('学历：大专（如有误请改）');
      expect(result.bookingChecklist.prefilledConfirmationFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: '学历', reason: 'medium_confidence' }),
        ]),
      );
    });

    it('借阅排在长期画像清理之后——生产里 currentUserMessage 恒有值，排前面等于没借', async () => {
      // 回归锁：removeProfileOnlyCandidateFields 按"高置信 sessionFacts 里有没有值"
      // 删 knownFieldMap，而弱来源值按定义不在高置信集里。借阅一旦排在它前面，
      // 生产中每一轮都会被立刻删掉（本地 fixture 不传 currentUserMessage 时才看着正常）。
      const result = await run(
        { jobId: 100 },
        {
          context: {
            currentUserMessage: '帮我约面试',
            messages: [{ role: 'user', content: `帮我约面试 ${TIME_SUFFIX}` }],
            candidatePrefillHints: {
              education: { value: '大专', reason: 'medium_confidence' },
            },
          },
        },
      );

      expect(result.bookingChecklist.templateText).toContain('学历：大专（如有误请改）');
    });

    it('借阅的 system 来源手机号挡住 ready_to_book——候选人没认过就不算收齐', async () => {
      // 洞：借阅让"联系电话"离开 missingFields，precheck 可以一路走到 ready_to_book，
      // 而 booking 的出处闸门（号码必须在候选人原文里）会把它拒掉——白跑一轮。
      const result = await run(
        { jobId: 100 },
        {
          context: {
            candidatePrefillHints: {
              phone: { value: '13900000002', reason: 'system_source' },
            },
            messages: [{ role: 'user', content: `帮我约面试 ${TIME_SUFFIX}` }],
          },
        },
      );

      expect(result.bookingChecklist.templateText).toContain('联系方式：13900000002（如有误请改）');
      expect(result.nextAction).toBe('collect_fields');
      expect(result._replyInstruction).toContain('联系电话（表内确认）');
    });

    it('候选人本人打过同一个号码 → 解锁（复用既有出处识别器，不新造确认正则）', async () => {
      const result = await run(
        { jobId: 100 },
        {
          context: {
            candidatePrefillHints: {
              phone: { value: '13900000002', reason: 'system_source' },
            },
            messages: [{ role: 'user', content: `我电话13900000002 ${TIME_SUFFIX}` }],
          },
        },
      );

      expect(result._replyInstruction ?? '').not.toContain('联系电话（表内确认）');
    });
  });

  describe('工序 C6：覆盖率 delta 观测', () => {
    it('解析器抓到、模型没经作证通道提交的字段落进观测事件', async () => {
      await run({ jobId: 100 }, { context: { messages: [{ role: 'user', content: '你好' }] } });
      // ledger.collectedFields 为空 → 无 delta（不制造噪声）
      expect(factAdjudicationEvent()?.coverageDelta).toBeUndefined();
    });
  });

  describe('工序 E1：enforce 下判缺改读账本', () => {
    it('无引文的裸字段进不了清单（账本里没有 = 缺）', async () => {
      const result = await run(
        { jobId: 100, candidateName: '王玥', candidateAge: 24 },
        { mode: 'enforce', context: { messages: [{ role: 'user', content: `你好 ${TIME_SUFFIX}` }] } },
      );

      expect(result.bookingChecklist.missingFields).toEqual(expect.arrayContaining(['姓名', '年龄']));
      expect(result.bookingChecklist.templateText).toContain('姓名：\n');
    });

    it('带真实引文的 claim 进得了清单', async () => {
      const result = await run(
        {
          jobId: 100,
          candidateClaims: [{ field: 'name', value: '王玥', quote: '我叫王玥' }],
        },
        {
          mode: 'enforce',
          context: { messages: [{ role: 'user', content: `我叫王玥 ${TIME_SUFFIX}` }] },
        },
      );

      expect(result.bookingChecklist.missingFields).not.toContain('姓名');
      expect(result.bookingChecklist.templateText).toContain('姓名：王玥');
    });

    it('shadow 下裸字段照旧回灌（迁移三阶段 P0 零行为变化）', async () => {
      const result = await run(
        { jobId: 100, candidateName: '王玥' },
        { context: { messages: [{ role: 'user', content: `你好 ${TIME_SUFFIX}` }] } },
      );

      expect(result.bookingChecklist.missingFields).not.toContain('姓名');
    });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
