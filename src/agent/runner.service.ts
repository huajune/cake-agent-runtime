/** Agent 执行编排：prepare -> model -> turn end lifecycle。 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { streamText, stepCountIs } from 'ai';
import { MemoryService } from '@memory/memory.service';
import { ReliableService } from '@providers/reliable.service';
import { AgentPreparationService, type PreparedAgentContext } from './agent-preparation.service';
import type { AgentError } from '@shared-types/agent-error.types';
import { computeResultCount, computeToolCallStatus } from './tool-call-analysis';
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
    private readonly reliable: ReliableService,
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
    const ctx = await this.preparation.prepare(params, 'invoke');

    if (ctx.typedMessages.length === 0) {
      throw this.createEmptyMessagesError(ctx);
    }

    try {
      const providerOptions = this.buildProviderOptions(ctx.chatModelId, params.thinking);
      const agentRequest = this.buildObservedAgentRequest(ctx, providerOptions);
      if (params.onPreparedRequest) {
        await Promise.resolve(params.onPreparedRequest(agentRequest));
      }

      const r = await this.reliable.generateText(
        ctx.chatModelId,
        {
          system: ctx.finalPrompt,
          messages: ctx.typedMessages,
          tools: ctx.tools,
          maxOutputTokens: this.maxOutputTokens,
          stopWhen: stepCountIs(ctx.maxSteps),
          providerOptions,
        },
        ctx.chatFallbacks,
      );

      if (r.reasoningText) {
        this.logger.debug(`Thinking: ${r.reasoningText.substring(0, 200)}...`);
      }
      this.logger.log(`Loop 完成: steps=${r.steps.length}, tokens=${r.usage.totalTokens}`);

      this.dispatchTurnEndLifecycle(ctx, r.text);

      return this.buildRunResult({
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
      });
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
    const ctx = await this.preparation.prepare(params, 'stream');

    if (ctx.typedMessages.length === 0) {
      throw this.createEmptyMessagesError(ctx);
    }

    try {
      const providerOptions = this.buildProviderOptions(ctx.chatModelId, params.thinking);
      const agentRequest = this.buildObservedAgentRequest(ctx, providerOptions);
      if (params.onPreparedRequest) {
        await Promise.resolve(params.onPreparedRequest(agentRequest));
      }

      const streamResult = streamText({
        model: ctx.chatModel,
        system: ctx.finalPrompt,
        messages: ctx.typedMessages,
        tools: ctx.tools,
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: stepCountIs(ctx.maxSteps),
        providerOptions,
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
          });
          this.dispatchTurnEndLifecycle(ctx, text);
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

  /**
   * 构建 provider thinking 配置。
   *
   * 不同厂商的思考模式传参方式不同：
   * - Anthropic: providerOptions.anthropic.thinking
   * - 千问/OpenAI-compatible: providerOptions.qwen.enable_thinking（AI SDK 会透传到请求 body）
   *
   * 这里同时传两套参数，各厂商只识别自己的 key，互不干扰。
   */
  private buildProviderOptions(modelId: string, requestThinking?: AgentThinkingConfig) {
    if (requestThinking) {
      return this.buildExplicitThinkingOptions(modelId, requestThinking);
    }

    const effectiveBudget =
      requestThinking?.type === 'enabled'
        ? requestThinking.budgetTokens
        : this.thinkingBudgetTokens;

    if (effectiveBudget <= 0) return undefined;

    return {
      anthropic: { thinking: { type: 'enabled', budgetTokens: effectiveBudget } },
      qwen: { enable_thinking: true },
    };
  }

  private buildExplicitThinkingOptions(modelId: string, thinking: AgentThinkingConfig) {
    const [provider] = modelId.split('/');
    const isDeepMode = thinking.type === 'enabled';

    if (!provider) {
      return undefined;
    }

    if (!isDeepMode) {
      switch (provider) {
        case 'deepseek':
          return { deepseek: { thinking: { type: 'disabled' } } };
        case 'google':
          return { google: { thinkingConfig: { thinkingLevel: 'minimal' } } };
        case 'openai':
          return { openai: { reasoningEffort: 'minimal' } };
        case 'qwen':
          return { qwen: { enable_thinking: false } };
        default:
          return undefined;
      }
    }

    const budgetTokens =
      thinking.budgetTokens > 0 ? thinking.budgetTokens : this.thinkingBudgetTokens;
    const safeBudgetTokens = budgetTokens > 0 ? budgetTokens : 1024;

    switch (provider) {
      case 'anthropic':
        return { anthropic: { thinking: { type: 'enabled', budgetTokens: safeBudgetTokens } } };
      case 'deepseek':
        return { deepseek: { thinking: { type: 'enabled' } } };
      case 'google':
        return {
          google: {
            thinkingConfig: {
              thinkingBudget: safeBudgetTokens,
              thinkingLevel: 'high',
            },
          },
        };
      case 'openai':
        return { openai: { reasoningEffort: 'high' } };
      case 'qwen':
        return { qwen: { enable_thinking: true, reasoningEffort: 'high' } };
      case 'moonshotai':
      case 'ohmygpt':
      case 'gateway':
        return { [provider]: { reasoningEffort: 'high' } };
      default:
        return undefined;
    }
  }

  /**
   * 统一触发回合结束收尾。
   *
   * 记忆收尾不阻塞主响应；失败只记日志，避免把模型成功回复拖慢或放大成整轮失败。
   */
  private async runTurnEndLifecycle(
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      'corpId' | 'userId' | 'sessionId' | 'typedMessages'
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
        typedMessages: ctx.typedMessages,
        candidatePool: ctx.turnState.candidatePool,
      },
      assistantText,
    );
  }

  private dispatchTurnEndLifecycle(
    ctx: Pick<
      Parameters<MemoryService['onTurnEnd']>[0],
      'corpId' | 'userId' | 'sessionId' | 'typedMessages'
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
  }): AgentRunResult {
    const agentSteps: AgentStepDetail[] = [];
    const toolCalls: AgentToolCall[] = [];

    let prevStepEndMs: number | undefined;
    params.steps.forEach((step, stepIndex) => {
      const stepEndMs = this.extractTimestampMs(step.response?.timestamp);
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

  private buildObservedAgentRequest(
    ctx: Pick<
      PreparedAgentContext,
      'chatModelId' | 'chatFallbacks' | 'finalPrompt' | 'typedMessages' | 'tools' | 'maxSteps'
    >,
    providerOptions?: ReturnType<AgentRunnerService['buildProviderOptions']>,
  ): Record<string, unknown> {
    const request: Record<string, unknown> = {
      modelId: ctx.chatModelId,
      system: ctx.finalPrompt,
      messages: ctx.typedMessages,
      maxOutputTokens: this.maxOutputTokens,
      maxSteps: ctx.maxSteps,
    };

    if (ctx.chatFallbacks && ctx.chatFallbacks.length > 0) {
      request.fallbackModelIds = ctx.chatFallbacks;
    }

    const toolNames = Object.keys(ctx.tools ?? {});
    if (toolNames.length > 0) {
      request.toolNames = toolNames;
    }

    if (providerOptions) {
      request.providerOptions = providerOptions;
    }

    return request;
  }

  private createEmptyMessagesError(
    ctx: Pick<
      PreparedAgentContext,
      | 'sessionId'
      | 'userId'
      | 'typedMessages'
      | 'memoryLoadWarning'
      | 'chatModelId'
      | 'chatFallbacks'
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
      | 'sessionId'
      | 'userId'
      | 'typedMessages'
      | 'memoryLoadWarning'
      | 'chatModelId'
      | 'chatFallbacks'
    >,
  ): AgentError {
    const error =
      err instanceof Error ? (err as AgentError) : (new Error(String(err)) as AgentError);

    error.isAgentError = true;
    error.agentMeta = {
      ...(error.agentMeta ?? {}),
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      messageCount: ctx.typedMessages.length,
      memoryLoadWarning: ctx.memoryLoadWarning,
      // 补充模型链信息，供告警卡片展示
      modelsAttempted: error.agentMeta?.modelsAttempted ?? [
        ctx.chatModelId,
        ...(ctx.chatFallbacks ?? []),
      ],
      lastCategory: error.agentMeta?.lastCategory,
    };

    return error;
  }
}
