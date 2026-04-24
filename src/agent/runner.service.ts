/** Agent 执行编排：prepare -> model -> turn end lifecycle。 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hasToolCall, stepCountIs, type generateText } from 'ai';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { MemoryService } from '@memory/memory.service';
import { AgentPreparationService, type PreparedAgentContext } from './agent-preparation.service';
import type { AgentError } from '@shared-types/agent-error.types';
import {
  buildToolCallLimitNotice,
  collectCalledToolNames,
  computeResultCount,
  computeToolCallStatus,
  findToolsExceedingLimit,
  MAX_SAME_TOOL_CALLS_PER_TURN,
} from './tool-call-analysis';

/**
 * 跳过本轮回复的沉默工具名。
 *
 * 约束：
 * - 只能在本轮尚未发生任何其它工具调用时使用
 * - 一旦被调用，stopWhen 立即结束本轮 loop，不再进入下一步
 */
const SKIP_REPLY_TOOL_NAME = 'skip_reply';

/** prepareStep 函数类型（沿用 ai SDK，本地不必锁死 TOOLS 泛型）。 */
type PrepareStepFn = NonNullable<Parameters<typeof generateText>[0]['prepareStep']>;
import type {
  AgentThinkingConfig,
  AgentInvokeParams,
  AgentRunResult,
  AgentStepDetail,
  AgentStreamResult,
  AgentToolCall,
} from './agent-run.types';
export type {
  AgentInputMessage,
  AgentInvokeParams,
  AgentRunResult,
  AgentStepDetail,
  AgentStreamResult,
  AgentToolCall,
  AgentToolCallStatus,
} from './agent-run.types';

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  /** thinking token 预算，>0 时启用 extended thinking */
  private readonly thinkingBudgetTokens: number;
  /** 输出 token 上限 */
  private readonly maxOutputTokens: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly preparation: AgentPreparationService,
    private readonly memoryService: MemoryService,
    private readonly llm: LlmExecutorService,
  ) {
    this.thinkingBudgetTokens = parseInt(
      this.configService.get('AGENT_THINKING_BUDGET_TOKENS', '0'),
      10,
    );
    this.maxOutputTokens = parseInt(this.configService.get('AGENT_MAX_OUTPUT_TOKENS', '4096'), 10);
    if (this.thinkingBudgetTokens > 0) {
      this.logger.log(`Extended thinking 已启用, budgetTokens=${this.thinkingBudgetTokens}`);
    }
    this.logger.log(`maxOutputTokens=${this.maxOutputTokens}`);
  }

  /** 非流式执行入口。 */
  async invoke(params: AgentInvokeParams): Promise<AgentRunResult> {
    const enableVision = this.llm.supportsVisionInput({
      role: ModelRole.Chat,
      modelId: params.modelId,
      disableFallbacks: params.disableFallbacks,
    });
    const ctx = await this.preparation.prepare(params, 'invoke', { enableVision });

    if (ctx.normalizedMessages.length === 0) {
      throw this.createEmptyMessagesError(ctx);
    }

    try {
      let agentRequest: Record<string, unknown> | undefined;
      const stepStartMs = Date.now();
      const stepEndWallclocks: number[] = [];
      const r = await this.llm.generate({
        role: ModelRole.Chat,
        modelId: params.modelId,
        disableFallbacks: params.disableFallbacks,
        thinking: this.resolveThinkingConfig(params.thinking),
        system: ctx.finalPrompt,
        messages: ctx.normalizedMessages,
        tools: ctx.tools,
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: [stepCountIs(ctx.maxSteps), hasToolCall(SKIP_REPLY_TOOL_NAME)],
        prepareStep: this.buildPrepareStep(ctx),
        onStepFinish: () => {
          stepEndWallclocks.push(Date.now());
        },
        onPreparedRequest: async (request) => {
          agentRequest = request;
          if (params.onPreparedRequest) {
            await Promise.resolve(params.onPreparedRequest(request));
          }
        },
      });

      if (r.reasoningText) {
        this.logger.debug(`Thinking: ${r.reasoningText.substring(0, 200)}...`);
      }
      this.logger.log(`Loop 完成: steps=${r.steps.length}, tokens=${r.usage.totalTokens}`);

      let result = this.buildRunResult({
        text: r.text,
        reasoningText: r.reasoningText,
        responseMessages: r.response?.messages as Array<Record<string, unknown>> | undefined,
        steps: r.steps,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
        agentRequest,
        memorySnapshot: ctx.memorySnapshot,
        stepStartMs,
        stepEndWallclocks,
      });

      result = await this.recoverEmptyTextResult(result, ctx, params);

      this.attachTurnEnd(result, ctx, params.messageId, result.text, params.deferTurnEnd);

      return result;
    } catch (err) {
      const agentError = this.enrichAgentError(err, ctx);
      this.logger.error('Agent 执行失败', agentError);
      throw agentError;
    }
  }

  /** 流式执行入口。 */
  async stream(
    params: AgentInvokeParams & { onFinish?: (result: AgentRunResult) => Promise<void> | void },
  ): Promise<AgentStreamResult> {
    const enableVision = this.llm.supportsVisionInput({
      role: ModelRole.Chat,
      modelId: params.modelId,
      disableFallbacks: params.disableFallbacks,
    });
    const ctx = await this.preparation.prepare(params, 'stream', { enableVision });

    if (ctx.normalizedMessages.length === 0) {
      throw this.createEmptyMessagesError(ctx);
    }

    try {
      let agentRequest: Record<string, unknown> | undefined;
      const stepStartMs = Date.now();
      const stepEndWallclocks: number[] = [];
      const streamResult = await this.llm.stream({
        role: ModelRole.Chat,
        modelId: params.modelId,
        disableFallbacks: params.disableFallbacks,
        thinking: this.resolveThinkingConfig(params.thinking),
        system: ctx.finalPrompt,
        messages: ctx.normalizedMessages,
        tools: ctx.tools,
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: [stepCountIs(ctx.maxSteps), hasToolCall(SKIP_REPLY_TOOL_NAME)],
        prepareStep: this.buildPrepareStep(ctx),
        onStepFinish: () => {
          stepEndWallclocks.push(Date.now());
        },
        onPreparedRequest: async (request) => {
          agentRequest = request;
          if (params.onPreparedRequest) {
            await Promise.resolve(params.onPreparedRequest(request));
          }
        },
        onFinish: ({ usage, steps, text }) => {
          this.logger.log('流式完成, 步数: ' + steps.length + ', Tokens: ' + usage.totalTokens);
          const result = this.buildRunResult({
            text,
            reasoningText: undefined,
            steps,
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens,
            },
            agentRequest,
            memorySnapshot: ctx.memorySnapshot,
            stepStartMs,
            stepEndWallclocks,
          });
          this.attachTurnEnd(result, ctx, params.messageId, text, params.deferTurnEnd);
          if (params.onFinish) {
            Promise.resolve(params.onFinish(result)).catch((err) =>
              this.logger.warn('流式完成回调执行失败', err),
            );
          }
        },
      });

      return { streamResult, entryStage: ctx.entryStage, agentRequest };
    } catch (err) {
      const agentError = this.enrichAgentError(err, ctx);
      this.logger.error('Agent 流式执行失败', agentError);
      throw agentError;
    }
  }

  private resolveThinkingConfig(requestThinking?: AgentThinkingConfig) {
    if (requestThinking) return requestThinking;
    if (this.thinkingBudgetTokens <= 0) return undefined;
    return {
      type: 'enabled' as const,
      budgetTokens: this.thinkingBudgetTokens,
    };
  }

  /**
   * 构造 prepareStep 钩子：动态屏蔽工具以收敛本轮行为。
   *
   * 两类屏蔽规则：
   * 1. **同名工具调用超限**：单轮同一工具 ≥ MAX_SAME_TOOL_CALLS_PER_TURN 次时屏蔽
   *    （典型如 duliday_job_list 用不稳定字段反复扩面）。
   * 2. **skip_reply 互斥**：本轮只要已经调用过任何其它工具，禁止再调 skip_reply——
   *    沉默只能发生在完全没有业务动作的轮次，已有动作后的沉默属于误用。
   *
   * 屏蔽方式 = activeTools 白名单移除 + system 末尾拼拦截说明。备选方案 stopWhen
   * 会直接结束整轮，可能导致没有最终回复输出；prepareStep 让模型仍能用其他工具或
   * 文本完成本轮。
   */
  private buildPrepareStep(ctx: PreparedAgentContext): PrepareStepFn | undefined {
    const baseTools = Object.keys(ctx.tools ?? {});
    if (baseTools.length === 0) return undefined;
    const baseSystem = ctx.finalPrompt;
    const sessionId = ctx.sessionId;
    const logger = this.logger;

    return ({ steps }) => {
      const overused = findToolsExceedingLimit(steps, MAX_SAME_TOOL_CALLS_PER_TURN);

      // 本轮已调用过业务工具（非 skip_reply 自身）→ 屏蔽 skip_reply
      const called = collectCalledToolNames(steps);
      const hasBusinessAction = [...called].some((name) => name !== SKIP_REPLY_TOOL_NAME);
      const skipReplyBlocked =
        hasBusinessAction && baseTools.includes(SKIP_REPLY_TOOL_NAME) ? [SKIP_REPLY_TOOL_NAME] : [];

      const blocked = Array.from(new Set([...overused, ...skipReplyBlocked]));
      if (blocked.length === 0) return {};

      const activeTools = baseTools.filter((name) => !blocked.includes(name));
      const noticeParts: string[] = [];
      const overuseNotice = buildToolCallLimitNotice(overused, MAX_SAME_TOOL_CALLS_PER_TURN);
      if (overuseNotice) noticeParts.push(overuseNotice);
      if (skipReplyBlocked.length > 0) {
        noticeParts.push(
          `⚠️ 系统拦截：本轮已发生业务工具调用，不可再调用 \`${SKIP_REPLY_TOOL_NAME}\`。沉默仅适用于本轮完全无业务动作且候选人仅发确认词的场景。`,
        );
      }
      const system =
        noticeParts.length > 0 ? `${baseSystem}\n\n${noticeParts.join('\n')}` : baseSystem;

      logger.warn(
        `工具调用硬截断: blocked=${blocked.join(',')} stepCount=${steps.length} sessionId=${sessionId}`,
      );

      // activeTools 在 SDK 内部要求是 keyof TOOLS；这里 TOOLS 是 ToolSet 索引签名，
      // 直接用 string[] 在运行时一致，仅做类型 cast。
      return {
        activeTools: activeTools as Array<string | number | symbol>,
        system,
      };
    };
  }

  /**
   * 统一触发回合结束收尾。
   *
   * 记忆收尾不阻塞主响应；失败只记日志，避免把模型成功回复拖慢或放大成整轮失败。
   */
  private async runTurnEndLifecycle(
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      'corpId' | 'userId' | 'sessionId' | 'messageId' | 'normalizedMessages'
    > & {
      turnState: {
        candidatePool: Parameters<MemoryService['onTurnEnd']>[0]['candidatePool'];
      };
    },
    assistantText?: string,
  ): Promise<void> {
    await this.memoryService.onTurnEnd(
      {
        corpId: ctx.corpId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        normalizedMessages: ctx.normalizedMessages,
        candidatePool: ctx.turnState.candidatePool,
      },
      assistantText,
    );
  }

  private dispatchTurnEndLifecycle(
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      'corpId' | 'userId' | 'sessionId' | 'messageId' | 'normalizedMessages'
    > & {
      turnState: {
        candidatePool: Parameters<MemoryService['onTurnEnd']>[0]['candidatePool'];
      };
    },
    assistantText?: string,
  ): void {
    void this.runTurnEndLifecycle(ctx, assistantText).catch((err) =>
      this.logger.warn('记忆生命周期执行失败', err),
    );
  }

  /**
   * 根据 deferTurnEnd 决定是 fire-and-forget 立即触发，还是把触发器暴露给调用方。
   *
   * 延迟模式用于 replay：首次生成结果可能被后续合并消息丢弃，若立即触发
   * projectAssistantTurn/extractFacts 会把「本应丢弃」的首次回复写进 session 记忆，
   * 污染下一轮 recall。
   */
  private attachTurnEnd(
    result: AgentRunResult,
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      'corpId' | 'userId' | 'sessionId' | 'normalizedMessages'
    > & {
      turnState: {
        candidatePool: Parameters<MemoryService['onTurnEnd']>[0]['candidatePool'];
      };
    },
    messageId: string | undefined,
    assistantText: string,
    deferTurnEnd: boolean | undefined,
  ): void {
    const lifecycleCtx = { ...ctx, messageId };
    if (!deferTurnEnd) {
      this.dispatchTurnEndLifecycle(lifecycleCtx, assistantText);
      return;
    }

    let consumed = false;
    result.runTurnEnd = async () => {
      if (consumed) return;
      consumed = true;
      await this.runTurnEndLifecycle(lifecycleCtx, assistantText);
    };
  }

  private buildRunResult(params: {
    text: string;
    reasoningText?: string;
    responseMessages?: Array<Record<string, unknown>>;
    steps: Array<{
      text?: string;
      reasoningText?: string;
      finishReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      response?: { timestamp?: Date | string | number };
      toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
      toolResults?: Array<{ toolCallId: string; output?: unknown }>;
    }>;
    usage: AgentRunResult['usage'];
    agentRequest?: Record<string, unknown>;
    memorySnapshot?: AgentRunResult['memorySnapshot'];
    /**
     * 本轮 generate/stream 开始的 wallclock 时间（`Date.now()`）。
     * 作为第 0 步的"上一步结束时间"锚点。
     */
    stepStartMs?: number;
    /**
     * 每个 step 结束的 wallclock 时间（通过 Vercel AI SDK `onStepFinish` 记录）。
     * 提供毫秒级精度；若不提供，回退到 `step.response.timestamp`（可能是秒级精度，
     * 导致 durationMs 出现 1000ms 整数倍的假象）。
     */
    stepEndWallclocks?: number[];
  }): AgentRunResult {
    const agentSteps: AgentStepDetail[] = [];
    const toolCalls: AgentToolCall[] = [];

    let prevStepEndMs: number | undefined = params.stepStartMs;
    params.steps.forEach((step, stepIndex) => {
      const wallclockEnd = params.stepEndWallclocks?.[stepIndex];
      const stepEndMs = wallclockEnd ?? this.extractTimestampMs(step.response?.timestamp);
      const stepDurationMs =
        prevStepEndMs !== undefined && stepEndMs !== undefined
          ? Math.max(stepEndMs - prevStepEndMs, 0)
          : undefined;

      const stepToolCalls: AgentToolCall[] = [];
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          const tr = step.toolResults?.find((t) => t.toolCallId === tc.toolCallId);
          const result = (tr as { output?: unknown } | undefined)?.output;
          const resultCount = computeResultCount(result);
          const status = computeToolCallStatus(result, resultCount);
          // 单步中只有一个工具时，把 stepDurationMs 归给这个工具
          const durationMs =
            stepDurationMs !== undefined && step.toolCalls.length === 1
              ? stepDurationMs
              : undefined;

          const call: AgentToolCall = {
            toolName: tc.toolName,
            args: ((tc as { input?: unknown }).input ?? {}) as Record<string, unknown>,
            result,
            resultCount,
            status,
            durationMs,
          };
          stepToolCalls.push(call);
          toolCalls.push(call);
        }
      }

      agentSteps.push({
        stepIndex,
        text: step.text || undefined,
        reasoning: step.reasoningText || undefined,
        toolCalls: stepToolCalls,
        usage:
          step.usage && step.usage.totalTokens !== undefined
            ? {
                inputTokens: step.usage.inputTokens ?? 0,
                outputTokens: step.usage.outputTokens ?? 0,
                totalTokens: step.usage.totalTokens,
              }
            : undefined,
        durationMs: stepDurationMs,
        finishReason: step.finishReason,
      });

      if (stepEndMs !== undefined) prevStepEndMs = stepEndMs;
    });

    return {
      text: params.text,
      reasoning: params.reasoningText || undefined,
      responseMessages: params.responseMessages,
      steps: params.steps.length,
      agentSteps,
      toolCalls,
      usage: params.usage,
      agentRequest: params.agentRequest,
      memorySnapshot: params.memorySnapshot,
    };
  }

  /**
   * 工具链偶发会以“有 reasoning / 有 tool results，但最终 text 为空”结束。
   *
   * 这类结果直接抛给上层会导致用户只收到兜底话术；这里做一次无工具文本恢复：
   * - 不再开放工具，避免重复预约/拉群等副作用
   * - 把已执行工具结果压缩成 transcript，让模型只补一条候选人可见回复
   * - 恢复失败时保留原空结果，让上层按既有异常链路处理
   */
  private async recoverEmptyTextResult(
    result: AgentRunResult,
    ctx: PreparedAgentContext,
    params: AgentInvokeParams,
  ): Promise<AgentRunResult> {
    if (result.text.trim().length > 0) return result;
    if (result.toolCalls.some((call) => call.toolName === SKIP_REPLY_TOOL_NAME)) return result;

    this.logger.warn(
      `Agent 返回空文本，尝试无工具恢复: sessionId=${ctx.sessionId}, steps=${result.steps}`,
    );

    try {
      const recoveryUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      const recovery = await this.llm.generate({
        role: ModelRole.Chat,
        modelId: params.modelId,
        disableFallbacks: params.disableFallbacks,
        thinking: { type: 'disabled', budgetTokens: 0 },
        system: `${ctx.finalPrompt}\n\n[空响应恢复模式]\n只输出一条候选人可见的中文回复。不要提系统、工具、模型、thinking、恢复或异常。不要调用工具。`,
        messages: [
          ...ctx.normalizedMessages,
          {
            role: 'user',
            content: this.buildEmptyTextRecoveryPrompt(result),
          },
        ],
        maxOutputTokens: Math.min(this.maxOutputTokens, 800),
      });

      const text = recovery.text?.trim() ?? '';
      recoveryUsage.inputTokens = recovery.usage.inputTokens ?? 0;
      recoveryUsage.outputTokens = recovery.usage.outputTokens ?? 0;
      recoveryUsage.totalTokens = recovery.usage.totalTokens ?? 0;

      if (!text) {
        this.logger.warn(`空文本恢复仍未产出回复: sessionId=${ctx.sessionId}`);
        return result;
      }

      this.logger.log(
        `空文本恢复成功: sessionId=${ctx.sessionId}, tokens=${recoveryUsage.totalTokens}`,
      );

      return {
        ...result,
        text,
        responseMessages: [
          ...(result.responseMessages ?? []),
          ...((recovery.response?.messages as Array<Record<string, unknown>> | undefined) ?? []),
        ],
        steps: result.steps + 1,
        agentSteps: [
          ...result.agentSteps,
          {
            stepIndex: result.agentSteps.length,
            text,
            reasoning: recovery.reasoningText || undefined,
            toolCalls: [],
            usage: recoveryUsage,
            finishReason: 'empty-text-recovery',
          },
        ],
        usage: {
          inputTokens: result.usage.inputTokens + recoveryUsage.inputTokens,
          outputTokens: result.usage.outputTokens + recoveryUsage.outputTokens,
          totalTokens: result.usage.totalTokens + recoveryUsage.totalTokens,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`空文本恢复失败: sessionId=${ctx.sessionId}; ${message}`);
      return result;
    }
  }

  private buildEmptyTextRecoveryPrompt(result: AgentRunResult): string {
    const transcript = result.agentSteps.map((step) => ({
      stepIndex: step.stepIndex,
      finishReason: step.finishReason,
      text: step.text ? this.truncateForPrompt(step.text, 1000) : undefined,
      reasoning: step.reasoning ? this.truncateForPrompt(step.reasoning, 1200) : undefined,
      toolCalls: step.toolCalls.map((call) => ({
        toolName: call.toolName,
        args: call.args,
        status: call.status,
        resultCount: call.resultCount,
        result: this.truncateForPrompt(this.safeJsonStringify(call.result), 5000),
      })),
    }));

    return [
      '上一轮工具链已经执行完，但最终没有产出可发送文本。',
      '请基于当前对话和下面的工具调用摘要，直接补一条候选人可见回复。',
      '要求：',
      '- 只输出回复正文，不要解释内部过程。',
      '- 如果工具结果显示 requestedDate.status=unavailable，必须明确说明不可约原因，并给最近可选替代时间。',
      '- 不要编造工具结果，不要承诺已经预约成功。',
      '',
      '工具调用摘要：',
      this.truncateForPrompt(this.safeJsonStringify(transcript), 14000),
    ].join('\n');
  }

  private safeJsonStringify(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private truncateForPrompt(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
  }

  private extractTimestampMs(value: unknown): number | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private createEmptyMessagesError(
    ctx: Pick<
      PreparedAgentContext,
      'sessionId' | 'userId' | 'normalizedMessages' | 'memoryLoadWarning'
    >,
  ): AgentError {
    return this.enrichAgentError(
      new Error(
        `messages 为空，无法调用 LLM | sessionId=${ctx.sessionId}` +
          ` | memoryWarning=${ctx.memoryLoadWarning ?? 'none'}`,
      ),
      ctx,
    );
  }

  private enrichAgentError(
    err: unknown,
    ctx: Pick<
      PreparedAgentContext,
      'sessionId' | 'userId' | 'normalizedMessages' | 'memoryLoadWarning'
    >,
  ): AgentError {
    const error =
      err instanceof Error ? (err as AgentError) : (new Error(String(err)) as AgentError);

    error.isAgentError = true;
    error.agentMeta = {
      ...(error.agentMeta ?? {}),
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      messageCount: ctx.normalizedMessages.length,
      memoryLoadWarning: ctx.memoryLoadWarning,
      modelsAttempted: error.agentMeta?.modelsAttempted,
      lastCategory: error.agentMeta?.lastCategory,
    };

    return error;
  }
}
