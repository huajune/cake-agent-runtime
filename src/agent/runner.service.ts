/**
 * Agent Runner 服务
 *
 * invoke() / stream() 共享完整编排流程：
 * 1. 一次性读取所有记忆（recallAll）
 * 2. 组装 systemPrompt（ContextService + section 体系）
 * 3. 注入记忆块（Profile + SessionFacts）
 * 4. 构建工具 → generateText / streamText 多步循环
 * 5. 记忆后置存储 + 事实提取（异步，供下一轮读取）
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelMessage, generateText, streamText, stepCountIs, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole, supportsVision } from '@providers/types';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { MemoryService } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import { SettlementService } from '@memory/settlement.service';
import { ContextService } from './context/context.service';
import { FactExtractionService } from './fact-extraction.service';
import { InputGuardService } from './input-guard.service';
import { RecommendedJobSummary } from '@memory/memory.types';

export interface AgentInputMessage {
  role: string;
  content: string;
  /** 该条 user message 关联的图片 URL 列表（test-suite/dashboard 路径） */
  imageUrls?: string[];
  /** 与 imageUrls 一一对应的图片消息 ID（wecom 路径供工具回写） */
  imageMessageIds?: string[];
}

export interface AgentInvokeParams {
  /**
   * 对话消息列表（含历史 + 当前用户消息）
   * controller / test-suite 直接调用时使用；wecom 渠道请改用 userMessage。
   */
  messages?: AgentInputMessage[];
  /**
   * 当前用户消息（wecom 渠道路径）
   * 历史消息由 ShortTermService 内部从 Supabase 读取（已含当前消息，无需重复传入）。
   */
  userMessage?: string;
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
  /** 图片 URL 列表（多模态消息，传入 Agent 做 vision 识别） */
  imageUrls?: string[];
  /** 图片消息 ID 列表（供 save_image_description 工具回写 DB） */
  imageMessageIds?: string[];
  /** 策略来源：wecom 读 released，test 读 testing */
  strategySource?: 'released' | 'testing';
}

export interface AgentToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface AgentRunResult {
  text: string;
  /** 模型思考过程（需启用 AGENT_THINKING_BUDGET_TOKENS） */
  reasoning?: string;
  steps: number;
  toolCalls: AgentToolCall[];
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
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

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
    private readonly settlement: SettlementService,
    private readonly context: ContextService,
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

      // 从 steps 中提取工具调用信息
      // Vercel AI SDK 的 TypedToolCall/TypedToolResult 是泛型类型，绑定到 ToolSet 参数，
      // 而 generateText 返回的 steps 使用 erasure 后的联合类型（StaticToolCall | DynamicToolCall），
      // 导致 `input`/`output` 字段在类型层面不可直接访问，需要最小范围的类型断言。
      const toolCalls: AgentToolCall[] = [];
      for (const step of r.steps) {
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
        text: r.text,
        reasoning: r.reasoningText || undefined,
        steps: r.steps.length,
        toolCalls,
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
   * 共享准备流程：参数规范化 → 记忆读取 → 消息选择 → prompt 编排 → 工具构建
   *
   * 两条路径：
   * - userMessage 路径（wecom 渠道）：历史消息由 ShortTermService 内部读取，当前消息已写入 DB
   * - messages 路径（controller / test-suite）：直接使用传入的完整消息列表
   */
  private async prepare(
    params: AgentInvokeParams,
    mode: 'invoke' | 'stream',
  ): Promise<PreparedContext> {
    const {
      messages: passedMessages,
      userMessage,
      userId,
      corpId,
      sessionId,
      scenario = 'candidate-consultation',
      maxSteps = 5,
      imageUrls,
      imageMessageIds,
    } = params;

    this.logger.log(
      `Agent ${mode}: userId=${userId}, corpId=${corpId}, sessionId=${sessionId}, scenario=${scenario}`,
    );

    // 0. 空闲检测：如果超过 SESSION_TTL，触发沉淀（Session Facts → Profile + Summary）
    // fire-and-forget：沉淀是后台操作，不阻塞当前流的启动
    this.settlement
      .checkAndSettle(corpId, userId, sessionId)
      .catch((err) => this.logger.warn('沉淀检测失败', err));

    // 1. 一次性读取所有记忆（shortTerm + sessionFacts + procedural + profile）
    const memory = await this.memoryService.recallAll(corpId, userId, sessionId);

    // 2. 确定 LLM 消息列表
    //    userMessage 路径：ShortTermService 已处理裁剪，且当前消息已在管线 step3 写入 DB，故已包含
    //    messages 路径：使用传入的完整列表，字符上限裁剪兜底
    const messages =
      userMessage !== undefined ? memory.shortTerm : this.trimMessages(passedMessages ?? []);

    // 3. Prompt injection 检测
    const guardResult = this.inputGuard.detectMessages(messages);
    const chatModel = this.router.resolveByRole(ModelRole.Chat);
    const chatModelId = this.configService.get<string>('AGENT_CHAT_MODEL') || '';
    const typedMessages = this.toModelMessages(messages, supportsVision(chatModelId));

    // 4. 组装 systemPrompt（含阶段策略 + 风险场景，由 section 体系完成）
    const currentStage = memory.procedural.currentStage ?? undefined;
    const { systemPrompt, thresholds } = await this.context.compose({
      scenario,
      currentStage,
      strategySource: params.strategySource,
    });

    // 5. 注入记忆块（Profile + SessionFacts）
    let finalPrompt = systemPrompt;
    const profileBlock = this.memoryService.longTerm.formatProfileForPrompt(
      memory.longTerm.profile,
    );
    const factsBlock = memory.sessionFacts
      ? this.memoryService.sessionFacts.formatForPrompt(memory.sessionFacts)
      : '';
    finalPrompt += profileBlock + factsBlock;

    // 6. Prompt injection 检测
    if (!guardResult.safe) {
      finalPrompt += InputGuardService.GUARD_SUFFIX;
      const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
      this.inputGuard
        .alertInjection(userId, guardResult.reason!, lastUserMsg?.content ?? '')
        .catch(() => {});
    }

    // 7. 图片多模态：将图片 URL 注入最后一条 user message 的 content（wecom 路径）
    if (imageUrls?.length && supportsVision(chatModelId)) {
      this.injectImageParts(typedMessages, imageUrls, imageMessageIds);
    }

    // 8. 构建工具
    const toolContext: ToolBuildContext = {
      userId,
      corpId,
      sessionId,
      messages: typedMessages,
      thresholds,
      imageMessageIds,
      onJobsFetched: async (jobs) => {
        await this.memoryService.sessionFacts.saveLastRecommendedJobs(
          corpId,
          userId,
          sessionId,
          jobs as RecommendedJobSummary[],
        );
      },
    };
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

    // 1. 记录交互信息（兼容多模态 content: 从 array 中提取 text part）
    const lastTopic = this.extractTextFromContent(lastUserMsg.content);
    await this.memoryService.sessionFacts
      .storeInteraction(ctx.corpId, ctx.userId, ctx.sessionId, {
        lastInteraction: new Date().toISOString(),
        lastTopic: lastTopic.substring(0, 100),
      })
      .catch((err) => this.logger.warn('记忆存储失败', err));

    // 2. 事实提取（fire-and-forget）— 将多模态 content 统一为字符串
    const flatMessages = ctx.typedMessages.map((m) => ({
      role: String(m.role),
      content: this.extractTextFromContent(m.content),
    }));
    this.factExtraction
      .extractAndSave(ctx.corpId, ctx.userId, ctx.sessionId, flatMessages)
      .catch((err) => this.logger.warn('事实提取失败', err));
  }

  /**
   * 从 ModelMessage.content 中提取纯文本
   * 兼容 string（普通消息）和 array（多模态消息，提取所有 text part）
   */
  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
    }
    return '';
  }

  /**
   * 将业务输入消息转换为 ModelMessage
   */
  private toModelMessages(messages: AgentInputMessage[], enableVision: boolean): ModelMessage[] {
    return messages.map((message) => {
      const textContent = this.extractTextFromContent(message.content);
      if (message.role === 'user' && message.imageUrls?.length) {
        if (enableVision) {
          const imageParts = this.buildImageParts(message.imageUrls, message.imageMessageIds);
          const textPart = textContent
            ? [{ type: 'text' as const, text: String(textContent) }]
            : [];
          return {
            role: 'user',
            content: [...imageParts, ...textPart],
          };
        }

        const fallbackText =
          message.imageUrls.length === 1
            ? '[图片消息]'
            : `[图片消息 ${message.imageUrls.length} 张]`;
        return {
          role: 'user',
          content: textContent ? `${fallbackText} ${textContent}` : fallbackText,
        };
      }

      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: textContent,
        };
      }

      if (message.role === 'system') {
        return {
          role: 'system',
          content: textContent,
        };
      }

      return {
        role: 'user',
        content: textContent,
      };
    });
  }

  /**
   * 将图片 URL 注入最后一条 user message，转为多模态 content array
   * Vercel AI SDK 支持 UserContent: (TextPart | ImagePart)[]
   */
  private injectImageParts(
    messages: ModelMessage[],
    imageUrls: string[],
    imageMessageIds?: string[],
  ): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const textContent = this.extractTextFromContent(messages[i].content);
        const imageParts = this.buildImageParts(imageUrls, imageMessageIds);
        if (imageParts.length === 0) return;
        const textPart = textContent ? [{ type: 'text' as const, text: String(textContent) }] : [];
        messages[i] = {
          role: 'user',
          content: [...imageParts, ...textPart],
        };
        this.logger.log(`注入 ${imageUrls.length} 张图片到 user message（多模态 vision）`);
        return;
      }
    }
  }

  /**
   * 构建图片 content parts，必要时在图片前注入 messageId 标签
   */
  private buildImageParts(imageUrls: string[], imageMessageIds?: string[]) {
    const validUrls = imageUrls
      .map((url) => {
        try {
          return new URL(url);
        } catch {
          this.logger.warn(`跳过无效的图片 URL: ${url}`);
          return null;
        }
      })
      .filter((url): url is URL => url !== null);

    if (validUrls.length === 0) return [];
    if (imageMessageIds?.length && imageMessageIds.length !== validUrls.length) {
      this.logger.warn(
        `图片 URL 数量(${validUrls.length})与 messageId 数量(${imageMessageIds.length})不一致，将按现有顺序尽力注入`,
      );
    }

    return validUrls.flatMap((url, index) => {
      const messageId = imageMessageIds?.[index];
      const label = messageId
        ? { type: 'text' as const, text: `[图片 messageId=${messageId}]` }
        : null;
      const image = { type: 'image' as const, image: url };
      return label ? [label, image] : [image];
    });
  }

  /**
   * 输入长度守卫 — 总字符数超限时从最早的消息开始丢弃（messages 路径兜底）
   */
  private trimMessages(messages: AgentInputMessage[]): AgentInputMessage[] {
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
