/**
 * Agent Loop 服务
 *
 * 纯执行层 — 接收调用方传入的 systemPrompt，执行多步工具循环。
 *
 * 执行流程：
 * 1. MemoryService.recall() → 记忆注入到 systemPrompt 末尾
 * 2. 构建 ToolBuildContext → toolRegistry.buildAll(context)
 * 3. RouterService → 模型解析 + generateText
 * 4. MemoryService.store() → 记忆后置存储
 * 5. 返回 AgentRunResult
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage, generateText, streamText, stepCountIs, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { MemoryService } from '@memory/memory.service';
import {
  type ChannelType,
  type StageGoals,
  type StageGoalPolicy,
} from '@channels/wecom/types/wework.types';
import { StageGoalConfig } from '@shared-types/strategy-config.types';

export interface LoopRunParams {
  /** 系统提示词（由调用方通过 ContextService 组装） */
  systemPrompt: string;
  /** stageGoals（由 ContextService.compose() 返回） */
  stageGoals: Record<string, StageGoalConfig>;
  /** 对话消息列表 */
  messages: ModelMessage[];
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 渠道类型，默认 private */
  channelType?: ChannelType;
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
  ) {}

  async run(params: LoopRunParams): Promise<AgentRunResult> {
    const {
      systemPrompt,
      stageGoals: rawStageGoals,
      messages,
      userId,
      corpId,
      channelType = 'private',
      maxSteps = 5,
    } = params;

    this.logger.log(`Loop 开始: userId=${userId}, corpId=${corpId}`);

    // 0. 记忆前置 — 回忆已有事实，注入到 systemPrompt 末尾
    const memoryKey = `wework_session:${corpId}:${userId}`;
    const memory = await this.memoryService.recall(memoryKey);
    const memoryContext = memory
      ? `\n\n[会话记忆]\n${JSON.stringify(memory.content, null, 2)}`
      : '';
    const finalPrompt = systemPrompt + memoryContext;

    // 1. 转换 stageGoals 格式
    const stageGoals = this.convertStageGoals(rawStageGoals);

    // 2. 构建工具上下文 → 一行构建所有工具
    const toolContext: ToolBuildContext = {
      userId,
      corpId,
      messages,
      channelType,
      stageGoals: stageGoals as unknown as Record<string, unknown>,
    };
    const tools = this.toolRegistry.buildAll(toolContext);

    // 3. 通过 RouterService 获取模型并执行 Agent Loop
    try {
      const chatModel = this.router.resolveByRole('chat');

      const r = await generateText({
        model: chatModel,
        system: finalPrompt,
        messages,
        tools: tools as ToolSet,
        stopWhen: stepCountIs(maxSteps),
      });

      this.logger.log(`Loop 完成: steps=${r.steps.length}, tokens=${r.usage.totalTokens}`);

      // 4. 记忆后置 — 保底记录基本交互信息
      const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
      if (lastUserMsg) {
        await this.memoryService
          .store(memoryKey, {
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
  async stream(params: LoopRunParams): Promise<ReturnType<typeof streamText>> {
    const {
      systemPrompt,
      stageGoals: rawStageGoals,
      messages,
      userId,
      corpId,
      channelType = 'private',
      maxSteps = 5,
    } = params;

    const chatModel = this.router.resolveByRole('chat');
    const stageGoals = this.convertStageGoals(rawStageGoals);

    const toolContext: ToolBuildContext = {
      userId,
      corpId,
      messages,
      channelType,
      stageGoals: stageGoals as unknown as Record<string, unknown>,
    };
    const tools = this.toolRegistry.buildAll(toolContext);

    return streamText({
      model: chatModel,
      system: systemPrompt,
      messages,
      tools: tools as ToolSet,
      stopWhen: stepCountIs(maxSteps),
      onFinish: ({ usage, steps }) =>
        this.logger.log('流式完成, 步数: ' + steps.length + ', Tokens: ' + usage.totalTokens),
    });
  }

  private convertStageGoals(rawStageGoals: Record<string, unknown>): StageGoals {
    const result = {} as Record<string, StageGoalPolicy>;

    for (const [stage, config] of Object.entries(rawStageGoals)) {
      const c = config as Record<string, unknown>;
      result[stage] = {
        description: (c.description as string) ?? '',
        primaryGoal: (c.primaryGoal as string) ?? '',
        successCriteria: (c.successCriteria as string[]) ?? [],
        ctaStrategy: Array.isArray(c.ctaStrategy)
          ? (c.ctaStrategy as string[]).join('\n')
          : ((c.ctaStrategy as string) ?? ''),
        disallowedActions: (c.disallowedActions as string[]) ?? [],
      };
    }

    return result as StageGoals;
  }
}
