import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { AgentService } from '../agent.service';
import { ProfileLoaderService } from './agent-profile-loader.service';
import { AgentResult, AgentProfile, SimpleMessage, ChatContext } from '../utils/agent-types';
import { ProfileSanitizer } from '../utils/agent-profile-sanitizer';

/**
 * 流式聊天结果接口
 */
export interface StreamChatResult {
  /** 可读流 */
  stream: NodeJS.ReadableStream;
  /** 预估输入 Token 数 */
  estimatedInputTokens: number;
  /** 使用的场景 */
  scenario: string;
  /** 使用的配置档案名称 */
  profileName: string;
  /** 会话 ID */
  conversationId: string;
}

/**
 * 场景调用选项
 */
export interface ScenarioOptions {
  /** 覆盖模型 */
  model?: string;
  /** 覆盖工具列表 */
  allowedTools?: string[];
  /** 额外的上下文数据 */
  extraContext?: Record<string, unknown>;
  /** 历史消息 */
  messages?: SimpleMessage[];
}

/**
 * Agent Facade 服务
 *
 * 职责：
 * 1. 封装基于场景的 Agent 调用逻辑
 * 2. 自动加载 Profile 并合并上下文数据
 * 3. 提供统一的流式/非流式调用接口
 * 4. 减轻 Controller 的复杂度
 *
 * 设计原则：
 * - 作为 Controller 和核心服务之间的协调层
 * - 不包含业务逻辑，只负责组装和协调
 * - 使用 Facade 模式简化复杂的服务调用
 */
@Injectable()
export class AgentFacadeService {
  private readonly logger = new Logger(AgentFacadeService.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly profileLoader: ProfileLoaderService,
  ) {}

  /**
   * 基于场景进行非流式聊天
   *
   * @param scenario 场景标识（如 'candidate-consultation'）
   * @param conversationId 会话 ID
   * @param userMessage 用户消息
   * @param options 可选配置
   * @returns AgentResult 统一响应
   */
  async chatWithScenario(
    scenario: string,
    conversationId: string,
    userMessage: string,
    options?: ScenarioOptions,
  ): Promise<AgentResult> {
    // 1. 加载配置档案
    const profile = this.loadProfile(scenario);

    // 2. 合并上下文
    const mergedContext = await this.buildMergedContext(profile, options?.extraContext);

    this.logger.log(
      `[chatWithScenario] 场景: ${scenario}, 会话: ${conversationId}, ` +
        `context 字段: ${Object.keys(mergedContext).join(', ')}`,
    );

    // 3. 清洗并合并配置
    const sanitized = ProfileSanitizer.merge(profile, {
      model: options?.model,
      allowedTools: options?.allowedTools,
      context: mergedContext,
    });

    // 4. 调用 AgentService.chat() - 直接传递 messages 参数
    const result = await this.agentService.chat({
      conversationId,
      userMessage,
      messages: options?.messages,
      ...sanitized,
    });

    return result;
  }

  /**
   * 基于场景进行流式聊天
   *
   * @param scenario 场景标识
   * @param conversationId 会话 ID
   * @param userMessage 用户消息
   * @param options 可选配置
   * @returns StreamChatResult 包含流和元数据
   */
  async chatStreamWithScenario(
    scenario: string,
    conversationId: string,
    userMessage: string,
    options?: ScenarioOptions,
  ): Promise<StreamChatResult> {
    // 1. 加载配置档案
    const profile = this.loadProfile(scenario);

    // 2. 合并上下文
    const mergedContext = await this.buildMergedContext(profile, options?.extraContext);

    this.logger.log(
      `[chatStreamWithScenario] 场景: ${scenario}, 会话: ${conversationId}, ` +
        `context 字段: ${Object.keys(mergedContext).join(', ')}`,
    );

    // 3. 通过 AgentService 调用流式 API（统一入口）
    const result = await this.agentService.chatStreamWithProfile(
      conversationId,
      userMessage,
      profile,
      {
        model: options?.model,
        allowedTools: options?.allowedTools,
        context: mergedContext,
        messages: options?.messages,
      },
    );

    return {
      stream: result.stream,
      estimatedInputTokens: result.estimatedInputTokens,
      scenario,
      profileName: profile.name,
      conversationId,
    };
  }

  /**
   * 获取指定场景的配置档案
   */
  getProfile(scenario: string): AgentProfile | null {
    return this.profileLoader.getProfile(scenario);
  }

  /**
   * 检查场景是否存在
   */
  hasScenario(scenario: string): boolean {
    return this.profileLoader.hasProfile(scenario);
  }

  /**
   * 获取所有可用场景
   */
  getAllScenarios(): string[] {
    return this.profileLoader.getAllProfiles().map((p) => p.name);
  }

  // ========== 私有方法 ==========

  /**
   * 加载配置档案（带错误处理）
   */
  private loadProfile(scenario: string): AgentProfile {
    const profile = this.profileLoader.getProfile(scenario);
    if (!profile) {
      throw new HttpException(`未找到场景 ${scenario} 的配置`, HttpStatus.NOT_FOUND);
    }
    return profile;
  }

  /**
   * 构建合并后的上下文
   * 合并顺序：profile.context -> 额外上下文
   */
  private async buildMergedContext(
    profile: AgentProfile,
    extraContext?: Record<string, unknown>,
  ): Promise<ChatContext> {
    // 合并上下文
    const mergedContext: ChatContext = {
      ...(profile.context || {}),
      // 合并额外上下文
      ...extraContext,
    };

    return mergedContext;
  }
}
