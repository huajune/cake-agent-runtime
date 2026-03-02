import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { AgentService } from '../agent.service';
import { ProfileLoaderService } from './agent-profile-loader.service';
import { StrategyConfigService } from '../strategy/strategy-config.service';
import { AgentConfigValidator } from '../utils/agent-validator';
import { AgentResult, AgentProfile, SimpleMessage, ChatContext } from '../utils/agent-types';
import {
  ProfileSanitizer,
  AgentProfile as PreparedProfile,
} from '../utils/agent-profile-sanitizer';

/** 需要注入 stageGoals 的 toolContext 工具名 */
const TOOL_PLAN_TURN = 'wework_plan_turn';
/** 需要注入 userId/sessionId 的 toolContext 工具名 */
const TOOL_EXTRACT_FACTS = 'wework_extract_facts';

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
  /** 用户 ID（注入 toolContext.wework_extract_facts，生产传真实值，测试传占位值） */
  userId?: string;
  /** 会话 ID（注入 toolContext.wework_extract_facts，生产传真实值，测试传占位值） */
  sessionId?: string;
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
    private readonly strategyConfigService: StrategyConfigService,
    private readonly configValidator: AgentConfigValidator,
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

    // 2. 准备参数（与生产链路对齐）
    const prepared = await this.prepareRequestParams(profile, options, conversationId);

    this.logger.log(
      `[chatWithScenario] 场景: ${scenario}, 会话: ${conversationId}, ` +
        `context 字段: ${Object.keys(prepared.context || {}).join(', ')}`,
    );

    // 3. 调用 AgentService.chat()
    const result = await this.agentService.chat({
      conversationId,
      userMessage,
      messages: options?.messages,
      ...prepared,
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

    // 2. 准备参数（与生产链路对齐）
    const prepared = await this.prepareRequestParams(profile, options, conversationId);

    this.logger.log(
      `[chatStreamWithScenario] 场景: ${scenario}, 会话: ${conversationId}, ` +
        `context 字段: ${Object.keys(prepared.context || {}).join(', ')}`,
    );

    // 3. 通过 AgentService 调用流式 API
    const result = await this.agentService.chatStreamWithProfile(
      conversationId,
      userMessage,
      profile,
      {
        ...prepared,
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
   * 统一参数准备（与 AgentGatewayService 生产链路对齐）
   *
   * 步骤：
   * 1. 合并上下文（profile.context + extraContext）
   * 2. 注入 {{CURRENT_TIME}} 到 systemPrompt
   * 3. 注入策略配置（人格+红线）到 systemPrompt
   * 4. 构建 toolContext（stageGoals + userId/sessionId）
   * 5. 清洗并合并配置
   */
  private async prepareRequestParams(
    profile: AgentProfile,
    options?: ScenarioOptions,
    conversationId?: string,
  ): Promise<PreparedProfile> {
    // 1. 合并上下文
    const mergedContext: ChatContext = {
      ...(profile.context || {}),
      ...options?.extraContext,
    };

    // 2. 注入当前时间到 systemPrompt
    let systemPrompt = this.injectCurrentTime(profile.systemPrompt);

    // 3. 注入策略配置（人格+红线）到 systemPrompt
    try {
      systemPrompt = await this.strategyConfigService.composeSystemPrompt(systemPrompt || '');
    } catch (error) {
      this.logger.warn('策略配置注入 systemPrompt 失败，使用基础 prompt', error);
    }

    // 4. 构建 toolContext（stageGoals + userId/sessionId）
    let toolContext = profile.toolContext;
    try {
      const stageGoals = await this.strategyConfigService.getStageGoalsForToolContext();

      if (!options?.userId) {
        this.logger.warn(
          `[prepareRequestParams] userId 未传入，${TOOL_EXTRACT_FACTS} 将不含用户信息`,
        );
      }
      const userId = options?.userId;
      // sessionId 即 chatId：优先用显式传入值，其次用 conversationId 兜底
      const sessionId = options?.sessionId || conversationId;

      toolContext = {
        ...profile.toolContext,
        [TOOL_PLAN_TURN]: {
          ...profile.toolContext?.[TOOL_PLAN_TURN],
          stageGoals,
        },
        [TOOL_EXTRACT_FACTS]: {
          ...profile.toolContext?.[TOOL_EXTRACT_FACTS],
          ...(userId !== undefined && { userId }),
          ...(sessionId !== undefined && { sessionId }),
        },
      };
    } catch (error) {
      this.logger.warn('策略配置注入 toolContext 失败，使用基础 toolContext', error);
    }

    // 5. 清洗并合并配置
    return ProfileSanitizer.merge(profile, {
      model: options?.model,
      allowedTools: options?.allowedTools,
      context: mergedContext,
      systemPrompt,
      toolContext,
    });
  }

  /**
   * 加载配置档案（带错误处理和配置验证）
   */
  private loadProfile(scenario: string): AgentProfile {
    const profile = this.profileLoader.getProfile(scenario);
    if (!profile) {
      throw new HttpException(`未找到场景 ${scenario} 的配置`, HttpStatus.NOT_FOUND);
    }

    // 验证 profile 必填字段和 context 结构
    this.configValidator.validateRequiredFields(profile);
    const contextValidation = this.configValidator.validateContext(profile.context);
    if (!contextValidation.isValid) {
      throw new HttpException(
        `场景 ${scenario} 配置验证失败: ${contextValidation.errors.join(', ')}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return profile;
  }

  /**
   * 动态注入当前时间到 System Prompt
   * 替换 {{CURRENT_TIME}} 占位符为实际时间
   */
  private injectCurrentTime(systemPrompt?: string): string | undefined {
    if (!systemPrompt) return systemPrompt;
    const currentTime = this.formatBeijingTime();
    return systemPrompt.replace('{{CURRENT_TIME}}', currentTime);
  }

  /** 格式化北京时间，如 "2025-12-03 17:30 星期三" */
  private formatBeijingTime(): string {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'long',
    });
    const parts = formatter.formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value || '';
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${g('weekday')}`;
  }
}
