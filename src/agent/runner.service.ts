/** Agent 执行编排：prepare -> model -> turn end lifecycle。 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, streamText, stepCountIs } from 'ai';
import { MemoryService } from '@memory/memory.service';
import { AgentPreparationService } from './agent-preparation.service';
import type {
  AgentInvokeParams,
  AgentRunResult,
  AgentStreamResult,
  AgentToolCall,
} from './agent-run.types';
export type {
  AgentInputMessage,
  AgentInvokeParams,
  AgentRunResult,
  AgentStreamResult,
  AgentToolCall,
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

    try {
      const r = await generateText({
        model: ctx.chatModel,
        system: ctx.finalPrompt,
        messages: ctx.typedMessages,
        tools: ctx.tools,
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: stepCountIs(ctx.maxSteps),
        providerOptions: this.buildProviderOptions(),
      });

      if (r.reasoningText) {
        this.logger.debug(`Thinking: ${r.reasoningText.substring(0, 200)}...`);
      }
      this.logger.log(`Loop 完成: steps=${r.steps.length}, tokens=${r.usage.totalTokens}`);

      await this.runTurnEndLifecycle(ctx, r.text);

      return this.buildRunResult({
        text: r.text,
        reasoningText: r.reasoningText,
        steps: r.steps,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
      });
    } catch (err) {
      this.logger.error('Agent 执行失败', err);
      throw err;
    }
  }

  /** 流式执行入口。 */
  async stream(
    params: AgentInvokeParams & {
      thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };
      onFinish?: (result: AgentRunResult) => Promise<void> | void;
    },
  ): Promise<AgentStreamResult> {
    const ctx = await this.preparation.prepare(params, 'stream');

    const streamResult = streamText({
      model: ctx.chatModel,
      system: ctx.finalPrompt,
      messages: ctx.typedMessages,
      tools: ctx.tools,
      maxOutputTokens: this.maxOutputTokens,
      stopWhen: stepCountIs(ctx.maxSteps),
      providerOptions: this.buildProviderOptions(params.thinking),
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
        });
        this.runTurnEndLifecycle(ctx, text).catch((err) =>
          this.logger.warn('记忆生命周期执行失败', err),
        );
        if (params.onFinish) {
          Promise.resolve(params.onFinish(result)).catch((err) =>
            this.logger.warn('流式完成回调执行失败', err),
          );
        }
      },
    });

    return { streamResult, entryStage: ctx.entryStage };
  }

  /** 构建 provider thinking 配置。 */
  private buildProviderOptions(requestThinking?: {
    type: 'enabled' | 'disabled';
    budgetTokens: number;
  }) {
    const effectiveBudget =
      requestThinking?.type === 'enabled'
        ? requestThinking.budgetTokens
        : this.thinkingBudgetTokens;

    return effectiveBudget > 0
      ? { anthropic: { thinking: { type: 'enabled', budgetTokens: effectiveBudget } } }
      : undefined;
  }

  /**
   * 统一触发回合结束收尾。
   *
   * `invoke` 会等待这一步完成，确保关键会话状态已更新；
   * `stream` 则在 `onFinish` 中触发，不影响文本流展示。
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

  private buildRunResult(params: {
    text: string;
    reasoningText?: string;
    steps: Array<{
      toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
      toolResults?: Array<{ toolCallId: string; output?: unknown }>;
    }>;
    usage: AgentRunResult['usage'];
  }): AgentRunResult {
    const toolCalls: AgentToolCall[] = [];
    for (const step of params.steps) {
      if (step.toolCalls && step.toolResults) {
        for (const tc of step.toolCalls) {
          const tr = step.toolResults.find((t) => t.toolCallId === tc.toolCallId);
          toolCalls.push({
            toolName: tc.toolName,
            args: ((tc as { input?: unknown }).input ?? {}) as Record<string, unknown>,
            result: (tr as { output?: unknown } | undefined)?.output,
          });
        }
      }
    }

    return {
      text: params.text,
      reasoning: params.reasoningText || undefined,
      steps: params.steps.length,
      toolCalls,
      usage: params.usage,
    };
  }
}
