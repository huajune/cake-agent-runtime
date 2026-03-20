/**
 * Agent Loop 服务
 *
 * invoke() / stream() 共享完整编排流程：
 * 1. 一次性读取所有记忆（recallAll）
 * 2. 组装 systemPrompt（ContextService + section 体系）
 * 3. 信号检测（SignalDetectorService: needs + riskFlags）
 * 4. 注入上一轮记忆（Profile + SessionFacts）
 * 5. 构建工具 → generateText / streamText 多步循环
 * 6. 记忆后置存储 + 事实提取（异步，供下一轮读取）
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelMessage, generateText, streamText, stepCountIs, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { MemoryService } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import { ContextService } from './context/context.service';
import { SignalDetectorService } from './signal-detector.service';
import { FactExtractionService } from './fact-extraction.service';
import { InputGuardService } from './input-guard.service';

export interface AgentInvokeParams {
  /** 对话消息列表（含历史 + 当前用户消息） */
  messages: { role: string; content: string }[];
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 会话 ID（chatId，用于记忆隔离） */
  sessionId: string;
  /** 场景标识，默认 candidate-consultation */
  scenario?: string;
  /** 最大工具循环步数，默认 5 */
  maxSteps?: number;
}

export interface AgentRunResult {
  text: string;
  /** 模型思考过程（需启用 AGENT_THINKING_BUDGET_TOKENS） */
  reasoning?: string;
  steps: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** prepare() 返回的共享上下文 */
interface PreparedContext {
  finalPrompt: string;
  typedMessages: ModelMessage[];
  chatModel: ReturnType<RouterService['resolveByRole']>;
  tools: ToolSet;
  scenario: string;
  corpId: string;
  userId: string;
  sessionId: string;
  maxSteps: number;
}

@Injectable()
export class LoopService {
  private readonly logger = new Logger(LoopService.name);

  /** thinking token 预算，>0 时启用 extended thinking */
  private readonly thinkingBudgetTokens: number;
  /** 输出 token 上限 */
  private readonly maxOutputTokens: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly router: RouterService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly memoryService: MemoryService,
    private readonly memoryConfig: MemoryConfig,
    private readonly context: ContextService,
    private readonly classifier: SignalDetectorService,
    private readonly factExtraction: FactExtractionService,
    private readonly inputGuard: InputGuardService,
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

  /**
   * Agent 执行入口 — prompt 编排 + 多步工具循环
   */
  async invoke(params: AgentInvokeParams): Promise<AgentRunResult> {
    const ctx = await this.prepare(params, 'invoke');

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

      await this.storePostMemory(ctx);

      return {
        text: r.text,
        reasoning: r.reasoningText || undefined,
        steps: r.steps.length,
        usage: {
          inputTokens: r.usage.inputTokens ?? 0,
          outputTokens: r.usage.outputTokens ?? 0,
          totalTokens: r.usage.totalTokens,
        },
      };
    } catch (err) {
      this.logger.error('Agent 执行失败', err);
      throw err;
    }
  }

  /**
   * 流式执行 — 与 invoke() 共享完整的 prompt 编排流程
   */
  async stream(
    params: AgentInvokeParams & {
      thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };
    },
  ): Promise<ReturnType<typeof streamText>> {
    const ctx = await this.prepare(params, 'stream');

    return streamText({
      model: ctx.chatModel,
      system: ctx.finalPrompt,
      messages: ctx.typedMessages,
      tools: ctx.tools,
      maxOutputTokens: this.maxOutputTokens,
      stopWhen: stepCountIs(ctx.maxSteps),
      providerOptions: this.buildProviderOptions(params.thinking),
      onFinish: ({ usage, steps }) => {
        this.logger.log('流式完成, 步数: ' + steps.length + ', Tokens: ' + usage.totalTokens);
        this.storePostMemory(ctx).catch((err) => this.logger.warn('记忆存储失败', err));
      },
    });
  }

  // ==================== 内部方法 ====================

  /**
   * 共享准备流程：参数规范化 → 记忆读取 → prompt 编排 → 工具构建
   */
  private async prepare(
    params: AgentInvokeParams,
    mode: 'invoke' | 'stream',
  ): Promise<PreparedContext> {
    const {
      messages,
      userId,
      corpId,
      sessionId,
      scenario = 'candidate-consultation',
      maxSteps = 5,
    } = params;

    this.logger.log(
      `Agent ${mode}: userId=${userId}, corpId=${corpId}, sessionId=${sessionId}, scenario=${scenario}`,
    );

    // 1. prompt 编排（含一次性记忆读取）
    let finalPrompt = await this.enrichPrompt({ messages, userId, corpId, sessionId, scenario });

    // 2. 输入长度守卫
    const trimmedMessages = this.trimMessages(messages);

    // 3. Prompt injection 检测
    const guardResult = this.inputGuard.detectMessages(trimmedMessages);
    if (!guardResult.safe) {
      finalPrompt += InputGuardService.GUARD_SUFFIX;
      const lastUserMsg = trimmedMessages.filter((m) => m.role === 'user').pop();
      this.inputGuard
        .alertInjection(userId, guardResult.reason!, lastUserMsg?.content ?? '')
        .catch(() => {});
    }

    // 4. 构建工具
    const typedMessages = trimmedMessages as ModelMessage[];
    const chatModel = this.router.resolveByRole('chat');
    const toolContext: ToolBuildContext = { userId, corpId, sessionId, messages: typedMessages };
    const tools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;

    return {
      finalPrompt,
      typedMessages,
      chatModel,
      tools,
      scenario,
      corpId,
      userId,
      sessionId,
      maxSteps,
    };
  }

  /**
   * 构建 provider 选项（thinking 配置）
   */
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
   * 记忆后置存储 — Agent 完成后异步执行（invoke / stream 共用）
   *
   * 1. 记录基本交互信息（lastInteraction, lastTopic）→ SessionFactsService
   * 2. 事实提取（LLM 结构化提取）→ SessionFactsService
   */
  private async storePostMemory(ctx: PreparedContext): Promise<void> {
    const lastUserMsg = ctx.typedMessages.filter((m) => m.role === 'user').pop();
    if (!lastUserMsg) return;

    // 1. 记录交互信息
    await this.memoryService.sessionFacts
      .storeInteraction(ctx.corpId, ctx.userId, ctx.sessionId, {
        lastInteraction: new Date().toISOString(),
        lastTopic:
          typeof lastUserMsg.content === 'string' ? lastUserMsg.content.substring(0, 100) : '',
      })
      .catch((err) => this.logger.warn('记忆存储失败', err));

    // 2. 事实提取（fire-and-forget）
    this.factExtraction
      .extractAndSave(
        ctx.corpId,
        ctx.userId,
        ctx.sessionId,
        ctx.typedMessages as { role: string; content: string }[],
      )
      .catch((err) => this.logger.warn('事实提取失败', err));
  }

  /**
   * prompt 编排流程
   *
   * 1. 一次性读取所有记忆（recallAll）
   * 2. 组装 systemPrompt
   * 3. 信号检测
   * 4. 注入 Profile + SessionFacts
   */
  private async enrichPrompt(params: {
    messages: { role: string; content: string }[];
    userId: string;
    corpId: string;
    sessionId: string;
    scenario: string;
  }): Promise<string> {
    const { messages, userId, corpId, sessionId, scenario } = params;

    // 1. 一次性读取所有记忆（并行：stage + facts + profile）
    const memory = await this.memoryService.recallAll(corpId, userId, sessionId);

    // 2. 组装 systemPrompt（含阶段策略 + 风险场景，由 section 体系完成）
    const currentStage = memory.procedural.currentStage ?? undefined;
    const { systemPrompt } = await this.context.compose({ scenario, currentStage });

    // 3. 检测 needs + riskFlags（消息驱动，追加到 prompt 末尾）
    const detection = this.classifier.detect(messages);
    const detectionBlock = this.classifier.formatDetectionBlock(detection);
    const enrichedPrompt = detectionBlock ? systemPrompt + '\n\n' + detectionBlock : systemPrompt;

    // 4. 注入记忆
    const profileBlock = this.memoryService.longTerm.formatProfileForPrompt(
      memory.longTerm.profile,
    );
    const factsBlock = memory.sessionFacts
      ? this.memoryService.sessionFacts.formatForPrompt(memory.sessionFacts)
      : '';

    return enrichedPrompt + profileBlock + factsBlock;
  }

  /**
   * 输入长度守卫 — 总字符数超限时从最早的消息开始丢弃
   */
  private trimMessages(
    messages: { role: string; content: string }[],
  ): { role: string; content: string }[] {
    const maxChars = this.memoryConfig.shortTermMaxChars;
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    if (totalChars <= maxChars) return messages;

    this.logger.warn(`输入消息总长度 ${totalChars} 超过上限 ${maxChars}，将丢弃最早的消息`);

    const kept: { role: string; content: string }[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgLen = messages[i].content?.length ?? 0;
      if (charCount + msgLen > maxChars && kept.length > 0) break;
      kept.unshift(messages[i]);
      charCount += msgLen;
    }

    this.logger.warn(`保留最近 ${kept.length}/${messages.length} 条消息，共 ${charCount} 字符`);
    return kept;
  }
}
