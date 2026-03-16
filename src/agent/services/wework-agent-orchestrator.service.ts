/**
 * 企微 Agent 编排服务
 *
 * 编排流程：
 * 1. ProfileLoaderService.load() → systemPrompt
 * 2. StrategyConfigService → persona + redLines + stageGoals
 * 3. 构建 ToolBuildContext → toolRegistry.buildAll(context)
 * 4. AgentRunnerService.run() → generateText + tools + maxSteps
 * 5. 返回 AgentRunResult
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage } from 'ai';
import { AgentRunnerService } from '@ai/runner/agent-runner.service';
import { ModelService } from '@ai/model/model.service';
import { ToolRegistryService } from '@ai/tool/tool-registry.service';
import { ToolBuildContext } from '@ai/tool/tool.types';
import { AgentRunResult } from '@ai/runner/agent.types';
import { ProfileLoaderService } from './agent-profile-loader.service';
import { StrategyConfigService } from '../strategy/strategy-config.service';
import {
  type ChannelType,
  type StageGoals,
  type StageGoalPolicy,
} from '../../ai/types/wework.types';

export interface OrchestratorRunParams {
  /** 对话消息列表 */
  messages: ModelMessage[];
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** 场景标识（用于加载 profile） */
  scenario?: string;
  /** 渠道类型，默认 private */
  channelType?: ChannelType;
  /** 最大工具循环步数，默认 5 */
  maxSteps?: number;
}

@Injectable()
export class WeworkAgentOrchestratorService {
  private readonly logger = new Logger(WeworkAgentOrchestratorService.name);

  constructor(
    private readonly agentRunner: AgentRunnerService,
    private readonly modelService: ModelService,
    private readonly profileLoader: ProfileLoaderService,
    private readonly strategyConfig: StrategyConfigService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  async run(params: OrchestratorRunParams): Promise<AgentRunResult> {
    const {
      messages,
      userId,
      corpId,
      scenario = 'candidate-consultation',
      channelType = 'private',
      maxSteps = 5,
    } = params;

    this.logger.log(`编排开始: userId=${userId}, corpId=${corpId}, scenario=${scenario}`);

    // 1. 加载 profile → 基础 systemPrompt
    const profile = this.profileLoader.getProfile(scenario);
    const basePrompt = profile?.systemPrompt ?? '';

    // 2. 策略配置 → persona + redLines + stageGoals
    const { systemPrompt: composedPrompt, stageGoals: rawStageGoals } =
      await this.strategyConfig.composeSystemPromptAndStageGoals(basePrompt);

    // 转换 stageGoals 格式
    const stageGoals = this.convertStageGoals(rawStageGoals);

    // 3. 构建工具上下文 → 一行构建所有工具
    const toolContext: ToolBuildContext = {
      userId,
      corpId,
      messages,
      channelType,
      stageGoals: stageGoals as unknown as Record<string, unknown>,
    };
    const tools = this.toolRegistry.buildAll(toolContext);

    // 4. 执行 Agent Loop
    try {
      const chatModel = this.modelService.resolve('chat');

      const result = await this.agentRunner.run({
        model: chatModel,
        systemPrompt: composedPrompt,
        messages,
        tools,
        maxSteps,
      });

      this.logger.log(`编排完成: steps=${result.steps}, tokens=${result.usage.totalTokens}`);

      return result;
    } catch (err) {
      this.logger.error('Agent 执行失败', err);
      throw err;
    }
  }

  /**
   * 转换 StrategyConfigService 的 stageGoals 格式为 wework.types.ts 的 StageGoals
   */
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
