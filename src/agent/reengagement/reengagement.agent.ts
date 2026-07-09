import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { MemoryService } from '@memory/memory.service';
import { z } from 'zod';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type { TurnOutcome } from '../runner/agent-runner.types';
import type { AgentStepDetail } from '@shared-types/agent-telemetry.types';
import type { FollowUpJob, FollowUpScenario } from './follow-up-scheduler.service';

// 复聊记忆用主动复聊专用 recall：已过 formatExtractionFactLines（含陈旧告警）与短期窗口清洗，
// 不再拿 onTurnStart 的裸快照 JSON.stringify，避免绕过主链路的事实处理护栏。
export type ReengagementMemorySnapshot = Awaited<
  ReturnType<MemoryService['recallForProactiveFollowUp']>
>;

// 一次复聊的触发上下文：谁、哪个场景、什么状态、灰度/shadow 开关。
export interface ReengagementComposeContext {
  sessionRef: FollowUpJob['sessionRef'];
  scenario: FollowUpScenario;
  jobData: FollowUpJob;
  state: AuthoritativeSessionState;
  messageId?: string;
  rolloutEnabled?: boolean;
  shadow?: boolean;
}

// 复聊 agent 一次执行的完整输入：既要拼 prompt，也要整体落库观测。
// 两个字段可见性边界不同：memory 会进 system prompt；trigger 只落库、绝不进 prompt。
export interface ReengagementAgentInput {
  // 触发溯源元数据（复用 compose 上下文）：仅写入 agentRequest 供排障 join，不得序列化进 prompt。
  trigger: ReengagementComposeContext;
  // 唯一允许进入 system prompt 的模型输入。
  memory: ReengagementMemorySnapshot;
}

export interface ReengagementAgentExecution {
  outcome: TurnOutcome;
  agentRequest?: Record<string, unknown>;
  aiStartAt: number;
  aiEndAt: number;
  validationReason?: string;
}

const REENGAGEMENT_OUTPUT_SCHEMA = z.object({
  message: z.string().describe('候选人可见的复聊消息'),
  reason: z.string().describe('简短说明文案生成依据，仅供内部观测，不给候选人看'),
});

@Injectable()
export class ReengagementAgent {
  private readonly logger = new Logger(ReengagementAgent.name);

  constructor(
    private readonly llm: LlmExecutorService,
    private readonly memory: MemoryService,
  ) {}

  async compose(ctx: ReengagementComposeContext): Promise<ReengagementAgentExecution> {
    // 走主动复聊专用 recall：拿到的是已渲染的 factLines（含陈旧告警）+ 清洗过的近期消息，
    // 而不是裸记忆快照——与主链路 memoryBlock 同一套事实处理。
    const memory = await this.memory.recallForProactiveFollowUp(
      ctx.sessionRef.corpId,
      ctx.sessionRef.userId,
      ctx.sessionRef.sessionId,
    );
    const agentInput: ReengagementAgentInput = { trigger: ctx, memory };

    // 只把 memory 交给 prompt 构造，trigger 溯源元数据在类型层就进不了 prompt。
    const systemPrompt = this.buildSystemPrompt(ctx, memory);

    const aiStartAt = Date.now();
    let agentRequest: Record<string, unknown> | undefined;

    try {
      const result = await this.llm.generateStructured({
        role: ModelRole.Chat,
        schema: REENGAGEMENT_OUTPUT_SCHEMA,
        outputName: 'ReengagementMessage',
        system: systemPrompt,
        // 主动复聊没有本轮候选人入站消息；上下文材料都属于系统提示词。
        messages: [],
        maxOutputTokens: 160,
        temperature: 0.3,
        onPreparedRequest: (request) => {
          agentRequest = request;
        },
      });
      const aiEndAt = Date.now();
      const agentSteps = this.extractAgentSteps(result.steps);

      const output = result.output;
      const text = output.message;
      const usage = this.normalizeUsage(result.usage);
      const responseMessages = this.normalizeResponseMessages(result.response?.messages);

      const agentRequestWithInput = {
        ...(agentRequest ?? {}),
        reengagementInput: agentInput,
        reengagementOutput: output,
      };

      const outcome: TurnOutcome = {
        kind: 'reply',
        reply: { text },
        generatedText: text,
        scenarioCode: ctx.scenario.code,
        usage,
        responseMessages,
        toolCalls: [],
        agentSteps,
      };

      return {
        outcome,
        agentRequest: agentRequestWithInput,
        aiStartAt,
        aiEndAt,
      };
    } catch (error) {
      this.logger.warn(
        `[reengagement] reengagement agent LLM 生成失败 scenario=${ctx.scenario.code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const generatedText = error instanceof Error ? error.message : String(error);
      return {
        outcome: {
          kind: 'skipped',
          generatedText,
          toolCalls: [],
          scenarioCode: ctx.scenario.code,
          agentSteps: [],
        },
        agentRequest: {
          type: 'reengagement_agent',
          scenarioCode: ctx.scenario.code,
          validationReason: 'reengagement_agent_error',
        },
        aiStartAt,
        aiEndAt: Date.now(),
        validationReason: 'reengagement_agent_error',
      };
    }
  }

  private buildSystemPrompt(
    ctx: ReengagementComposeContext,
    memory: ReengagementMemorySnapshot,
  ): string {
    return [
      '你是「独立客」的招聘顾问，正在企业微信上帮候选人对接餐饮门店的岗位。此刻候选人已经沉默或到了某个关键节点，你要主动发一条简短、自然的消息，把 TA 往前推进一步。',
      '',
      '# 本次需要完成的任务',
      `任务代码：${ctx.scenario.code}`,
      `任务名称：${ctx.scenario.displayName}`,
      `任务目标：${ctx.scenario.objective}`,
      `生成规范：${ctx.scenario.generationPolicy}`,
      '以上「生成规范」是本条消息的最高优先级依据；下面的通用规范只做兜底约束，两者冲突时以生成规范为准。',
      '',
      '# 候选人证据材料',
      '下面是本次复聊唯一可用的候选人上下文。只能基于这些证据生成，缺失的信息不要补全或猜测。',
      '',
      '## 权威状态快照',
      JSON.stringify(ctx.state),
      '',
      '## 近期对话',
      this.formatRecentMessages(memory.recentMessages),
      '',
      '## 已知事实',
      this.formatFactLines(memory.factLines),
      ...(memory.warnings?.length
        ? ['', '## 时效提醒', ...memory.warnings.map((warning) => `- ${warning}`)]
        : []),
      '',
      '# 通用规范',
      '- 只写一到两句中文，像微信里真人顾问随口发的话：不客套、不群发腔、不堆表情。',
      '- 只围绕本次目标提一个问题或一个行动点，不追问、不施压、不重复骚扰。',
      '- 只使用上下文已有的事实；不要复述岗位详情、薪资、班次、地址，更不得编造名额、录用或回电。',
      '- 不能报名、不能拉群、不能发消息、不能创建工单；本 agent 不开放任何工具。',
      '- 不要提及系统、模型、工具、JSON、任务代码、灰度发布或内部观测。',
      '',
      '# 输出协议',
      '返回结构化结果：message 是候选人可见的那一句话；reason 用一句话说明生成依据（仅内部观测，候选人看不到）。只输出最终文案，不要给多个方案或解释过程。',
    ].join('\n');
  }

  private formatRecentMessages(messages: ReengagementMemorySnapshot['recentMessages']): string {
    if (!messages.length) return '（无近期对话）';
    return messages
      .map((message) => `${message.role === 'user' ? '候选人' : '你'}：${message.content}`)
      .join('\n');
  }

  private formatFactLines(factLines: ReengagementMemorySnapshot['factLines']): string {
    return factLines.length ? factLines.join('\n') : '（暂无已知结构化事实）';
  }

  // 以下方法只是把 AI SDK 返回值投影成现有观测字段，不承载复聊业务逻辑。
  private normalizeUsage(usage: unknown): TurnOutcome['usage'] {
    if (!usage || typeof usage !== 'object') return undefined;
    const record = usage as Record<string, unknown>;
    const inputTokens = Number(record.inputTokens ?? record.promptTokens ?? 0);
    const outputTokens = Number(record.outputTokens ?? record.completionTokens ?? 0);
    const totalTokens = Number(record.totalTokens ?? inputTokens + outputTokens);
    return { inputTokens, outputTokens, totalTokens };
  }

  private normalizeResponseMessages(value: unknown): TurnOutcome['responseMessages'] {
    return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : undefined;
  }

  private extractAgentSteps(steps: unknown): AgentStepDetail[] {
    if (!Array.isArray(steps)) return [];
    return (
      steps as Array<{
        text?: string;
        reasoningText?: string;
        finishReason?: string;
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        toolCalls?: Array<{ toolName: string; toolCallId?: string; input?: unknown }>;
        toolResults?: Array<{ toolCallId?: string; output?: unknown }>;
      }>
    ).map((step, stepIndex) => {
      return {
        stepIndex,
        text: step.text || undefined,
        reasoning: step.reasoningText || undefined,
        toolCalls: [],
        usage:
          step.usage && step.usage.totalTokens !== undefined
            ? {
                inputTokens: step.usage.inputTokens ?? 0,
                outputTokens: step.usage.outputTokens ?? 0,
                totalTokens: step.usage.totalTokens,
              }
            : undefined,
        finishReason: step.finishReason,
      };
    });
  }
}
