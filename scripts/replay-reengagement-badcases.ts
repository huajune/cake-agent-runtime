/**
 * 用生产 badcase 数据重放复聊 Agent 语义判定（新提示词效果验证）。
 *
 * 与 scripts/eval-reengagement-agent.ts 同构：真实模型调用，mock 记忆，不碰投递。
 * 每个 case 重放两次：A=角色路由现模型（qwen，隔离 prompt 效应），B=AGENT_REENGAGEMENT_MODEL
 * 指定 deepseek/deepseek-v4-pro（发版目标配置）。
 *
 * 运行：pnpm dotenv -e .env.local -- pnpm ts-node -r tsconfig-paths/register \
 *   -P scripts/tsconfig.json <本文件> <fixtures.json 路径>
 */

import { readFileSync } from 'fs';
import { ConfigService } from '@nestjs/config';
import { ReengagementAgent } from '@agent/reengagement/reengagement.agent';
import {
  getScenario,
  type FollowUpJob,
  type FollowUpScenarioCode,
} from '@agent/reengagement/follow-up-scheduler.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { RegistryService } from '@providers/registry.service';
import { ReliableService } from '@providers/reliable.service';
import { RouterService } from '@providers/router.service';

interface FixtureMessage {
  role: 'user' | 'assistant';
  atIso: string;
  content: string;
}

interface ReplayFixture {
  touchId: number;
  label: string;
  expected: string;
  scenarioCode: FollowUpScenarioCode;
  sessionId: string;
  workOrderId: number;
  anchorAtIso: string;
  decidedAtIso: string;
  interviewAtMs: number;
  booking: Record<string, string>;
  messages: FixtureMessage[];
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 生产短期记忆的消息时间后缀格式：[消息发送时间：2026-07-20 17:36 星期一] */
function withTimestampSuffix(message: FixtureMessage): { role: 'user' | 'assistant'; content: string } {
  const at = new Date(message.atIso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayIndex = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' })
      .format(at)
      .replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, (d) =>
        String(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(d)),
      ),
  );
  const suffix = `[消息发送时间：${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${WEEKDAYS[weekdayIndex]}]`;
  return { role: message.role, content: `${message.content}\n${suffix}` };
}

function buildState(fixture: ReplayFixture): AuthoritativeSessionState & { interviewAt: number } {
  return {
    collectedFields: {},
    recalledJobIds: new Set<number>(),
    hardConstraints: [],
    presentedStores: [],
    stage: 'interview_scheduled',
    terminal: 'booked',
    lastCandidateMessageAt: new Date(fixture.messages.at(-1)!.atIso).getTime(),
    interviewAt: fixture.interviewAtMs,
  } as AuthoritativeSessionState & { interviewAt: number };
}

async function runCase(
  agent: ReengagementAgent,
  fixture: ReplayFixture,
  variant: string,
): Promise<Record<string, unknown>> {
  const scenario = getScenario(fixture.scenarioCode);
  if (!scenario) throw new Error(`Unknown scenario: ${fixture.scenarioCode}`);
  const anchorAt = new Date(fixture.anchorAtIso).getTime();
  const decidedAt = new Date(fixture.decidedAtIso).getTime();

  const jobData: FollowUpJob = {
    sessionRef: { corpId: 'replay-corp', userId: `replay-${fixture.touchId}`, sessionId: fixture.sessionId },
    scenarioCode: fixture.scenarioCode,
    anchorEventId: `replay-${fixture.touchId}`,
    anchorAt,
    workOrderId: fixture.workOrderId,
    expectedInterviewAt: fixture.interviewAtMs,
  };

  const realNow = Date.now.bind(Date);
  Date.now = () => decidedAt;
  try {
    const execution = await agent.compose({
      sessionRef: jobData.sessionRef,
      scenario,
      jobData,
      state: buildState(fixture),
      rolloutEnabled: false,
      shadow: true,
      bookingContext: {
        workOrderId: fixture.workOrderId,
        interviewAt: fixture.interviewAtMs,
        ...fixture.booking,
      },
    });
    const request = execution.agentRequest ?? {};
    const output = request.reengagementOutput as
      | { decision?: string; blockReason?: string; reason?: string; message?: string }
      | undefined;
    return {
      touchId: fixture.touchId,
      variant,
      label: fixture.label,
      expected: fixture.expected,
      outcome: execution.outcome.kind,
      decision: output?.decision,
      blockReason: output?.blockReason,
      validationReason: execution.validationReason,
      reason: output?.reason,
      message: output?.message || execution.outcome.reply?.text,
      model: (request as { modelId?: string }).modelId,
    };
  } finally {
    Date.now = realNow;
  }
}

async function main(): Promise<void> {
  const fixturesPath = process.argv[2];
  if (!fixturesPath) throw new Error('usage: replay-reengagement-badcases.ts <fixtures.json>');
  const fixtures = (JSON.parse(readFileSync(fixturesPath, 'utf8')) as { cases: ReplayFixture[] })
    .cases;

  // ConfigService.get 会回退读 process.env，所以必须直接改 process.env 才能隔离变体。
  const variants: Array<{ name: string; reengagementModel?: string }> = [
    { name: 'A:新prompt+chat角色现模型' },
    { name: 'B:新prompt+deepseek-v4-pro', reengagementModel: 'deepseek/deepseek-v4-pro' },
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const variant of variants) {
    if (variant.reengagementModel) {
      process.env.AGENT_REENGAGEMENT_MODEL = variant.reengagementModel;
    } else {
      delete process.env.AGENT_REENGAGEMENT_MODEL;
    }
    const config = new ConfigService(process.env);
    const registry = new RegistryService(config);
    registry.onModuleInit();
    const router = new RouterService(config);
    const reliable = new ReliableService(registry);
    const llm = new LlmExecutorService(router, registry, reliable);

    for (const fixture of fixtures) {
      const memory = {
        recallForProactiveFollowUp: async () => ({
          recentMessages: fixture.messages.map(withTimestampSuffix),
          factLines: [],
        }),
      };
      const agent = new ReengagementAgent(llm, memory as never, config);
      const result = await runCase(agent, fixture, variant.name);
      results.push(result);
      console.log(JSON.stringify({ event: 'replay_case', ...result }, null, 2));
    }
  }
  console.log(JSON.stringify({ event: 'replay_complete', total: results.length }));
}

main().catch((error: unknown) => {
  console.error('replay_failed:', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
