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
  sessionId: string;
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
  /** 用户 ID（注入 context，供 route.ts / extract_facts / job_list 使用） */
  userId?: string;
  /** 扩展思考配置 */
  thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };
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
   * @param sessionId 会话 ID
   * @param userMessage 用户消息
   * @param options 可选配置
   * @returns AgentResult 统一响应
   */
  async chatWithScenario(
    scenario: string,
    sessionId: string,
    userMessage: string,
    options?: ScenarioOptions,
  ): Promise<AgentResult> {
    // 1. 加载配置档案
    const profile = this.loadProfile(scenario);

    // 2. 准备参数（与生产链路对齐）
    const prepared = await this.prepareRequestParams(profile, options, sessionId);

    this.logger.log(
      `[chatWithScenario] 场景: ${scenario}, 会话: ${sessionId}, ` +
        `context 字段: ${Object.keys(prepared.context || {}).join(', ')}`,
    );

    // 3. 调用 AgentService.chat()
    const result = await this.agentService.chat({
      sessionId,
      userMessage,
      messages: options?.messages,
      thinking: options?.thinking,
      ...prepared,
    });

    return result;
  }

  /**
   * 基于场景进行流式聊天
   *
   * @param scenario 场景标识
   * @param sessionId 会话 ID
   * @param userMessage 用户消息
   * @param options 可选配置
   * @returns StreamChatResult 包含流和元数据
   */
  async chatStreamWithScenario(
    scenario: string,
    sessionId: string,
    userMessage: string,
    options?: ScenarioOptions,
  ): Promise<StreamChatResult> {
    // 1. 加载配置档案
    const profile = this.loadProfile(scenario);

    // 2. 准备参数（与生产链路对齐）
    const prepared = await this.prepareRequestParams(profile, options, sessionId);

    this.logger.log(
      `[chatStreamWithScenario] 场景: ${scenario}, 会话: ${sessionId}, ` +
        `context 字段: ${Object.keys(prepared.context || {}).join(', ')}`,
    );

    // 3. 通过 AgentService 调用流式 API
    const result = await this.agentService.chatStreamWithProfile(sessionId, userMessage, profile, {
      ...prepared,
      messages: options?.messages,
      thinking: options?.thinking,
    });

    return {
      stream: result.stream,
      estimatedInputTokens: result.estimatedInputTokens,
      scenario,
      profileName: profile.name,
      sessionId,
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
   * 1. 合并上下文（profile.context + extraContext + userId，sessionId 从 sessionId 自动注入）
   * 2. 注入 {{CURRENT_TIME}} 到 systemPrompt
   * 3. 注入策略配置（人格+红线）到 systemPrompt
   * 4. 构建 toolContext（仅 stageGoals）
   * 5. 清洗并合并配置
   */
  private async prepareRequestParams(
    profile: AgentProfile,
    options?: ScenarioOptions,
    sessionId?: string,
  ): Promise<PreparedProfile> {
    // 1. 合并上下文（profile.context + extraContext + userId + sessionId）
    // userId + sessionId 是 Agent 会话记忆的组合 key，缺失直接报错
    const userId = options?.userId;

    if (!userId) {
      throw new HttpException(
        'userId 是必填项，用于 Agent 会话记忆管理（userId + sessionId 组合 key）',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!sessionId) {
      throw new HttpException(
        'sessionId 是必填项，用于 Agent 会话记忆管理（userId + sessionId 组合 key）',
        HttpStatus.BAD_REQUEST,
      );
    }

    const mergedContext: ChatContext = {
      ...(profile.context || {}),
      ...options?.extraContext,
      userId,
      sessionId,
    };

    // 2. 注入当前时间到 systemPrompt
    let systemPrompt = this.injectCurrentTime(profile.systemPrompt);

    // 3+4. 一次查询同时获取 systemPrompt 和 stageGoals（避免两次串行 getActiveConfig）
    let toolContext = profile.toolContext;
    try {
      const { systemPrompt: composed, stageGoals } =
        await this.strategyConfigService.composeSystemPromptAndStageGoals(systemPrompt || '');
      systemPrompt = composed;

      toolContext = {
        ...profile.toolContext,
        [TOOL_PLAN_TURN]: {
          ...profile.toolContext?.[TOOL_PLAN_TURN],
          stageGoals,
        },
      };
    } catch (error) {
      this.logger.warn('策略配置注入失败，使用基础配置', error);
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
