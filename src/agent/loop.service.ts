/**
 * Agent Loop 服务
 *
 * 统一入口 invoke()：
 * 1. 读取持久化阶段（stage）
 * 2. 组装 systemPrompt（ContextService + section 体系）
 * 3. 信号检测（SignalDetectorService: needs + riskFlags）
 * 4. 事实提取（FactExtractionService: LLM 结构化提取 + 品牌别名映射）
 * 5. 注入会话记忆（结构化格式）
 * 6. 构建工具 → generateText 多步循环
 * 7. 记忆后置存储
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage, generateText, streamText, stepCountIs, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { MemoryService } from '@memory/memory.service';
import { ContextService } from './context/context.service';
import { SignalDetectorService } from './signal-detector.service';
import { FactExtractionService } from './fact-extraction.service';

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
  steps: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

@Injectable()
export class LoopService {
  private readonly logger = new Logger(LoopService.name);

  constructor(
    private readonly router: RouterService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly memoryService: MemoryService,
    private readonly context: ContextService,
    private readonly classifier: SignalDetectorService,
    private readonly factExtraction: FactExtractionService,
  ) {}

  /**
   * Agent 执行入口 — prompt 编排 + 多步工具循环
   */
  async invoke(params: AgentInvokeParams): Promise<AgentRunResult> {
    const {
      messages,
      userId,
      corpId,
      sessionId,
      scenario = 'candidate-consultation',
      maxSteps = 5,
    } = params;

    this.logger.log(
      `Agent invoke: userId=${userId}, corpId=${corpId}, sessionId=${sessionId}, scenario=${scenario}`,
    );

    // 1. 读取持久化的当前阶段
    const stageKey = `stage:${corpId}:${userId}:${sessionId}`;
    const stageMemory = await this.memoryService.recall(stageKey);
    const currentStage = (stageMemory?.content?.currentStage as string) ?? undefined;

    // 2. 组装 systemPrompt（含阶段策略 + 风险场景，由 section 体系完成）
    const { systemPrompt } = await this.context.compose({ scenario, currentStage });

    // 3. 检测 needs + riskFlags（消息驱动，追加到 prompt 末尾）
    const detection = this.classifier.detect(messages);
    const detectionBlock = this.classifier.formatDetectionBlock(detection);
    const enrichedPrompt = detectionBlock ? systemPrompt + '\n\n' + detectionBlock : systemPrompt;

    // 4. 事实提取（LLM 结构化提取 + 品牌别名映射，fire-and-forget 不阻塞主流程）
    this.factExtraction
      .extractAndSave(corpId, userId, sessionId, messages)
      .catch((err) => this.logger.warn('事实提取失败', err));

    // 5. 注入会话记忆（结构化格式）
    const sessionState = await this.memoryService.getSessionState(corpId, userId, sessionId);
    const memoryContext = this.memoryService.formatSessionMemoryForPrompt(sessionState);
    const finalPrompt = enrichedPrompt + memoryContext;

    // 6. 构建工具 + 执行 Agent Loop
    const typedMessages = messages as ModelMessage[];
    const toolContext: ToolBuildContext = { userId, corpId, sessionId, messages: typedMessages };
    const tools = this.toolRegistry.buildForScenario(scenario, toolContext);

    try {
      const chatModel = this.router.resolveByRole('chat');

      const r = await generateText({
        model: chatModel,
        system: finalPrompt,
        messages: typedMessages,
        tools: tools as ToolSet,
        stopWhen: stepCountIs(maxSteps),
      });

      this.logger.log(`Loop 完成: steps=${r.steps.length}, tokens=${r.usage.totalTokens}`);

      // 7. 记忆后置 — 保底记录基本交互信息
      const lastUserMsg = typedMessages.filter((m) => m.role === 'user').pop();
      if (lastUserMsg) {
        const factsKey = `wework_session:${corpId}:${userId}:${sessionId}`;
        await this.memoryService
          .store(factsKey, {
            lastInteraction: new Date().toISOString(),
            lastTopic:
              typeof lastUserMsg.content === 'string' ? lastUserMsg.content.substring(0, 100) : '',
          })
          .catch((err) => this.logger.warn('记忆存储失败', err));
      }

      return {
        text: r.text,
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

  /** 流式执行 */
  async stream(
    params: Omit<AgentInvokeParams, 'scenario'> & { systemPrompt: string },
  ): Promise<ReturnType<typeof streamText>> {
    const { systemPrompt, messages, userId, corpId, sessionId, maxSteps = 5 } = params;

    const typedMessages = messages as ModelMessage[];
    const chatModel = this.router.resolveByRole('chat');
    const toolContext: ToolBuildContext = { userId, corpId, sessionId, messages: typedMessages };
    const tools = this.toolRegistry.buildAll(toolContext);

    return streamText({
      model: chatModel,
      system: systemPrompt,
      messages: typedMessages,
      tools: tools as ToolSet,
      stopWhen: stepCountIs(maxSteps),
      onFinish: ({ usage, steps }) =>
        this.logger.log('流式完成, 步数: ' + steps.length + ', Tokens: ' + usage.totalTokens),
    });
  }
}
