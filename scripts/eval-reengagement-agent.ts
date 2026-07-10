/**
 * 用 6 组纯虚构数据隔离运行复聊 Agent。
 *
 * 只调用模型，不连接记忆存储、调度器或消息投递：
 *   pnpm dotenv -e .env.local -- pnpm ts-node -r tsconfig-paths/register \
 *     -P scripts/tsconfig.json scripts/eval-reengagement-agent.ts
 */

import { ConfigService } from '@nestjs/config';
import { ReengagementAgent } from '@agent/reengagement/reengagement.agent';
import {
  getScenario,
  type FollowUpJob,
  type FollowUpScenarioCode,
} from '@agent/reengagement/follow-up-scheduler.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import type { ProactiveMemoryRecall } from '@memory/memory.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { RegistryService } from '@providers/registry.service';
import { ReliableService } from '@providers/reliable.service';
import { RouterService } from '@providers/router.service';

type CoreScenarioCode = Exclude<FollowUpScenarioCode, 'new_job_for_waiting'>;
type ScenarioState = AuthoritativeSessionState & { interviewAt?: number };

interface EvalFixture {
  code: CoreScenarioCode;
  candidate: string;
  state: ScenarioState;
  memory: ProactiveMemoryRecall;
  job?: Partial<FollowUpJob>;
}

const BASE_AT = Date.parse('2026-07-10T12:00:00+08:00');
const INTERVIEW_AT = Date.parse('2026-07-11T14:00:00+08:00');
const FINISHED_INTERVIEW_AT = Date.parse('2026-07-10T10:00:00+08:00');

function state(overrides: Partial<ScenarioState> = {}): ScenarioState {
  return {
    collectedFields: {},
    recalledJobIds: new Set<number>(),
    hardConstraints: [],
    presentedStores: [],
    stage: null,
    lastCandidateMessageAt: BASE_AT - 60 * 60_000,
    ...overrides,
  };
}

const FIXTURES: EvalFixture[] = [
  {
    code: 'opening_no_reply',
    candidate: '虚构候选人-A',
    state: state({ stage: 'opening' }),
    memory: {
      recentMessages: [
        {
          role: 'assistant',
          content: '你好，我是独立客招聘顾问，可以帮你看看附近合适的餐饮岗位。',
        },
      ],
      factLines: [],
    },
  },
  {
    code: 'address_missing',
    candidate: '虚构候选人-B',
    state: state({ stage: 'job_search' }),
    memory: {
      recentMessages: [
        { role: 'user', content: '想找个离家近一点的兼职。' },
        { role: 'assistant', content: '可以的，你把位置或者附近地铁站发我一下。' },
      ],
      factLines: ['- 求职类型: 兼职', '- 意向城市: 上海'],
    },
  },
  {
    code: 'store_presented_no_reply',
    candidate: '虚构候选人-C',
    state: state({
      stage: 'job_presented',
      presentedStores: [{ storeId: 301, jobId: 9001, presentedAt: BASE_AT - 3 * 60 * 60_000 }],
    }),
    memory: {
      recentMessages: [
        { role: 'user', content: '最好静安区，晚班也可以。' },
        {
          role: 'assistant',
          content: '这边有个静安大悦城附近的服务员岗位，你要不要了解一下？',
        },
      ],
      factLines: ['- 意向区域: 上海市静安区', '- 可接受班次: 晚班'],
    },
  },
  {
    code: 'booking_incomplete',
    candidate: '虚构候选人-D',
    state: state({
      stage: 'collecting_profile',
      collectedFields: {
        name: {
          value: '测试小林',
          provenance: 'user_text',
          evidence: '我叫小林',
          at: BASE_AT - 2 * 60 * 60_000,
        },
      },
    }),
    memory: {
      recentMessages: [
        { role: 'user', content: '这个岗位可以报名，我叫小林。' },
        { role: 'assistant', content: '好的，还需要补充一些报名资料。' },
      ],
      factLines: ['- 姓名: 测试小林', '- 报名意向: 明确愿意报名'],
    },
  },
  {
    code: 'interview_reminder',
    candidate: '虚构候选人-E',
    state: state({
      stage: 'interview_scheduled',
      terminal: 'booked',
      interviewAt: INTERVIEW_AT,
    }),
    memory: {
      recentMessages: [
        { role: 'assistant', content: '已经帮你约好了面试，具体时间是明天下午两点。' },
        { role: 'user', content: '好的，谢谢。' },
      ],
      factLines: [
        '- 面试时间: 2026年7月11日 14:00',
        '- 面试地点: 上海市静安区南京西路测试门店',
        '- 需携带材料: 身份证、健康证',
      ],
    },
    job: {
      workOrderId: 70001,
      expectedInterviewAt: INTERVIEW_AT,
    },
  },
  {
    code: 'post_interview_followup',
    candidate: '虚构候选人-F',
    state: state({
      stage: 'interview_completed',
      terminal: 'booked',
      interviewAt: FINISHED_INTERVIEW_AT,
    }),
    memory: {
      recentMessages: [
        { role: 'assistant', content: '面试是今天上午十点，到店后和店长说是来面试的就行。' },
        { role: 'user', content: '收到。' },
      ],
      factLines: ['- 面试时间: 2026年7月10日 10:00', '- 面试地点: 上海市徐汇区测试门店'],
    },
    job: {
      workOrderId: 70002,
      expectedInterviewAt: FINISHED_INTERVIEW_AT,
    },
  },
];

async function main(): Promise<void> {
  const requestedScenario = process.argv[2] as CoreScenarioCode | undefined;
  const fixtures = requestedScenario
    ? FIXTURES.filter((fixture) => fixture.code === requestedScenario)
    : FIXTURES;
  if (fixtures.length === 0) {
    throw new Error(`Unknown or unsupported core scenario: ${requestedScenario}`);
  }

  const config = new ConfigService(process.env);
  const registry = new RegistryService(config);
  registry.onModuleInit();
  const router = new RouterService(config);
  const reliable = new ReliableService(registry);
  const llm = new LlmExecutorService(router, registry, reliable);

  const route = router.getRouteByRole('chat');
  console.log(
    JSON.stringify(
      {
        event: 'reengagement_eval_start',
        fixtureCount: fixtures.length,
        primaryModel: route.modelId,
        fallbackModels: route.fallbacks ?? [],
        deliveryEnabled: false,
      },
      null,
      2,
    ),
  );

  const results: Array<Record<string, unknown>> = [];

  for (const [index, fixture] of fixtures.entries()) {
    const scenario = getScenario(fixture.code);
    if (!scenario) throw new Error(`Unknown scenario: ${fixture.code}`);

    const memory = {
      recallForProactiveFollowUp: async () => fixture.memory,
    };
    const agent = new ReengagementAgent(llm, memory as never);
    const anchorAt = BASE_AT - 4 * 60 * 60_000;
    const jobData: FollowUpJob = {
      sessionRef: {
        corpId: 'eval-corp',
        userId: `eval-user-${index + 1}`,
        sessionId: `eval-session-${index + 1}`,
      },
      scenarioCode: fixture.code,
      anchorEventId: `eval-${fixture.code}`,
      anchorAt,
      ...fixture.job,
    };

    const startedAt = Date.now();
    const execution = await agent.compose({
      sessionRef: jobData.sessionRef,
      scenario,
      jobData,
      state: fixture.state,
      rolloutEnabled: false,
      shadow: true,
    });
    const request = execution.agentRequest ?? {};

    results.push({
      code: fixture.code,
      displayName: scenario.displayName,
      candidate: fixture.candidate,
      outcome: execution.outcome.kind,
      message: execution.outcome.reply?.text,
      generatedText: execution.outcome.generatedText,
      reason: (request.reengagementOutput as { reason?: string } | undefined)?.reason,
      model: request.modelId,
      fallbackModels: request.fallbackModelIds,
      durationMs: Date.now() - startedAt,
      usage: execution.outcome.usage,
      validationReason: execution.validationReason,
    });

    console.log(JSON.stringify({ event: 'reengagement_eval_case', ...results.at(-1) }, null, 2));
  }

  const passed = results.filter((result) => result.outcome === 'reply').length;
  console.log(
    JSON.stringify(
      {
        event: 'reengagement_eval_complete',
        passed,
        failed: results.length - passed,
        results,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'reengagement_eval_failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
