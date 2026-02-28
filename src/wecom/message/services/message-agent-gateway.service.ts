import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentService,
  ProfileLoaderService,
  AgentConfigValidator,
  AgentResultHelper,
  AgentProfile,
  ChatResponse,
  ScenarioType,
  AgentError,
  AgentInvocationException,
  SimpleMessage,
  StrategyConfigService,
} from '@agent';
import { MonitoringService } from '@/core/monitoring/monitoring.service';
import { AgentInvokeResult, AgentReply, FallbackMessageOptions } from '../types';
import { ReplyNormalizer } from '../utils/reply-normalizer.util';
import { MessageParser } from '../utils/message-parser.util';

/**
 * Agent 网关服务（增强版）
 * 封装 Agent API 调用的完整流程 + 上下文构建 + 降级处理
 *
 * 职责：
 * - 构建会话上下文
 * - 构造 Agent 请求参数
 * - 调用 Agent API
 * - 解析响应结果
 * - 记录监控指标
 * - 处理降级和告警
 * - 提供降级消息
 */
@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  // 默认降级话术（优化版，学习真实招募经理 LiHanTing 的极简风格）
  // 分级设计：轻量级(12字以内)为主，中等复杂(18字以内)，复杂场景(25字以内)
  private readonly defaultFallbackMessages: string[] = [
    // 轻量级(12字以内) - 首选
    '我确认下哈，马上回你~',
    '我这边查一下，稍等~',
    '让我看看哈，很快~',

    // 中等复杂(18字以内)
    '这块我再核实下，确认好马上告诉你哈~',
    '这个涉及几个细节，我确认下再回你',

    // 复杂场景(25字以内)
    '这块资料我这边暂时没看到，我先帮你记下来，确认好回你~',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: AgentService,
    private readonly profileLoader: ProfileLoaderService,
    private readonly configValidator: AgentConfigValidator,
    private readonly monitoringService: MonitoringService,
    private readonly strategyConfigService: StrategyConfigService,
  ) {}

  // ========================================
  // 降级消息管理（合并自 FallbackMessageProviderService）
  // ========================================

  /**
   * 获取降级消息（内联自 FallbackMessageService）
   *
   * @param options 选项配置
   * @returns 降级消息文本
   */
  getFallbackMessage(options?: FallbackMessageOptions): string {
    // 1. 优先使用自定义消息
    if (options?.customMessage) {
      return options.customMessage;
    }

    // 2. 其次使用环境变量配置
    const envMessage = this.configService.get<string>('AGENT_FALLBACK_MESSAGE', '');
    if (envMessage) {
      return envMessage;
    }

    // 3. 不随机时返回第一条
    if (options?.random === false) {
      return this.defaultFallbackMessages[0];
    }

    // 4. 默认随机返回
    const index = Math.floor(Math.random() * this.defaultFallbackMessages.length);
    return this.defaultFallbackMessages[index];
  }

  // ========================================
  // Agent 调用（原有逻辑）
  // ========================================

  /**
   * 调用 Agent 获取回复
   *
   * @param params 调用参数
   * @returns Agent 调用结果
   */
  async invoke(params: {
    conversationId: string;
    userMessage: string;
    historyMessages: SimpleMessage[];
    scenario?: ScenarioType;
    messageId?: string; // 可选，用于监控埋点
    recordMonitoring?: boolean; // 是否记录监控（默认 true）
  }): Promise<AgentInvokeResult> {
    const {
      conversationId,
      userMessage,
      historyMessages,
      scenario = ScenarioType.CANDIDATE_CONSULTATION,
      messageId,
      recordMonitoring = true,
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;

    try {
      // 1. 获取 Agent 配置档案
      const agentProfile = this.loadAndValidateProfile(scenario);

      // 2. 【监控埋点】记录 AI 处理开始
      if (recordMonitoring && messageId) {
        this.monitoringService.recordAiStart(messageId);
        shouldRecordAiEnd = true;
      }

      // 3. 动态注入当前时间到 System Prompt
      const systemPrompt = this.injectCurrentTime(agentProfile.systemPrompt);

      // 5. 策略配置注入（人格 + 红线 → systemPrompt，阶段目标 → toolContext）
      let finalSystemPrompt = systemPrompt;
      let finalToolContext = agentProfile.toolContext;
      try {
        finalSystemPrompt = await this.strategyConfigService.composeSystemPrompt(
          systemPrompt || '',
        );
        const stageGoals = await this.strategyConfigService.getStageGoalsForToolContext();
        finalToolContext = {
          ...agentProfile.toolContext,
          wework_plan_turn: {
            ...agentProfile.toolContext?.wework_plan_turn,
            stageGoals,
          },
        };
      } catch (error) {
        this.logger.warn('策略配置注入失败，使用基础 prompt', error);
      }

      // 6. 调用 Agent API
      const agentResult = await this.agentService.chat({
        conversationId,
        userMessage,
        messages: historyMessages, // API 契约字段名
        model: agentProfile.model,
        systemPrompt: finalSystemPrompt,
        allowedTools: agentProfile.allowedTools,
        context: agentProfile.context,
        toolContext: finalToolContext,
        contextStrategy: agentProfile.contextStrategy,
        prune: agentProfile.prune,
        pruneOptions: agentProfile.pruneOptions,
      });

      const processingTime = Date.now() - startTime;

      // 4. 检查 Agent 调用结果
      if (AgentResultHelper.isError(agentResult)) {
        this.logger.error(`Agent 调用失败:`, agentResult.error);
        throw this.buildAgentInvocationError(agentResult.error);
      }

      // 5. 检查是否为降级响应
      const isFallback = AgentResultHelper.isFallback(agentResult);
      if (isFallback && agentResult.fallbackInfo) {
        this.handleFallbackResponse(agentResult, conversationId, userMessage, scenario);
      }

      // 6. 提取响应数据
      const chatResponse = AgentResultHelper.getResponse(agentResult);
      if (!chatResponse) {
        this.logger.error(`Agent 返回空响应`);
        throw new Error('Agent 返回空响应');
      }

      // 7. 构造回复对象
      const reply = this.buildAgentReply(chatResponse);

      this.logger.log(
        `Agent 调用成功，耗时 ${processingTime}ms，tokens=${reply.usage?.totalTokens || 'N/A'}`,
      );

      return {
        result: agentResult,
        reply,
        isFallback,
        processingTime,
      };
    } catch (error) {
      this.logger.error(`Agent 调用异常: ${error.message}`);
      throw error;
    } finally {
      // 8. 【监控埋点】记录 AI 处理完成（无论成功还是失败）
      if (shouldRecordAiEnd && messageId) {
        this.monitoringService.recordAiEnd(messageId);
      }
    }
  }

  /**
   * 加载并验证 Agent 配置档案
   */
  private loadAndValidateProfile(scenario: string): AgentProfile {
    const agentProfile = this.profileLoader.getProfile(scenario);

    if (!agentProfile) {
      throw new Error(`无法获取场景 ${scenario} 的 Agent 配置`);
    }

    // 验证配置有效性
    try {
      this.configValidator.validateRequiredFields(agentProfile);
      const contextValidation = this.configValidator.validateContext(agentProfile.context);

      if (!contextValidation.isValid) {
        throw new Error(`Agent 配置验证失败: ${contextValidation.errors.join(', ')}`);
      }
    } catch (error) {
      throw new Error(`Agent 配置验证失败: ${error.message}`);
    }

    return agentProfile;
  }

  /**
   * 处理降级响应
   *
   * 注意：告警已统一移至 MessagePipelineService.handleProcessingError
   * 此处仅记录日志，避免重复告警
   */
  private handleFallbackResponse(
    agentResult: any,
    _conversationId: string,
    _userMessage: string,
    _scenario: ScenarioType,
  ): void {
    const fallbackReason = agentResult.fallbackInfo.reason;
    this.logger.warn(`Agent 降级响应（原因: ${fallbackReason}）`);
  }

  /**
   * 构造 Agent 调用异常并附带诊断信息
   */
  private buildAgentInvocationError(agentError?: AgentError): AgentInvocationException {
    const code = agentError?.code || 'UNKNOWN_ERROR';
    const message = agentError?.message || 'Agent 调用失败';
    const exception = new AgentInvocationException(code, message, {
      details: agentError?.details,
      retryable: agentError?.retryable,
      retryAfter: agentError?.retryAfter,
    });

    const metaSource = agentError as any;
    if (metaSource) {
      if (metaSource.requestParams) {
        (exception as any).requestParams = metaSource.requestParams;
      }
      if (metaSource.apiKey) {
        (exception as any).apiKey = metaSource.apiKey;
      }
      if (metaSource.requestHeaders) {
        (exception as any).requestHeaders = metaSource.requestHeaders;
      }
      if (metaSource.response || metaSource.apiResponse) {
        (exception as any).response = metaSource.response || metaSource.apiResponse;
      }
    }

    (exception as any).isAgentError = true;
    return exception;
  }

  /**
   * 构造 Agent 回复对象
   */
  private buildAgentReply(chatResponse: ChatResponse): AgentReply {
    // 提取回复内容
    const content = this.extractReplyContent(chatResponse);

    return {
      content,
      usage: chatResponse.usage,
      tools: chatResponse.tools,
      rawResponse: chatResponse,
    };
  }

  /**
   * 提取 AI 回复内容
   * 优先级：
   * 1. zhipin_reply_generator 工具的 reply 字段（智能回复）
   * 2. 最后一条 assistant 消息的文本内容
   *
   * 包含兜底清洗逻辑：将 Markdown 格式转换为自然口语
   */
  private extractReplyContent(chatResponse: ChatResponse): string {
    if (!chatResponse.messages || chatResponse.messages.length === 0) {
      throw new Error('AI 未生成有效回复');
    }

    // 获取最后一条 assistant 消息
    const lastAssistantMessage = chatResponse.messages.filter((m) => m.role === 'assistant').pop();

    if (
      !lastAssistantMessage ||
      !lastAssistantMessage.parts ||
      lastAssistantMessage.parts.length === 0
    ) {
      throw new Error('AI 响应中没有找到助手消息');
    }

    // 提取所有文本类型的 parts 并拼接
    const textParts = lastAssistantMessage.parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text);

    if (textParts.length === 0) {
      throw new Error('AI 响应中没有找到文本内容');
    }

    // 拼接所有文本内容
    const rawContent = textParts.join('\n\n');

    return this.normalizeContent(rawContent);
  }

  /**
   * 规范化回复内容
   * 将 Markdown 列表格式转换为自然口语
   */
  private normalizeContent(rawContent: string): string {
    // 🛡️ 兜底清洗：将 Markdown 列表格式转换为自然口语
    // 即使 AI 偶尔生成带列表符号的回复，这里也能保证发出去的是人话
    if (ReplyNormalizer.needsNormalization(rawContent)) {
      const normalizedContent = ReplyNormalizer.normalize(rawContent);
      this.logger.debug(
        `[ReplyNormalizer] 已清洗回复: "${rawContent.substring(0, 50)}..." → "${normalizedContent.substring(0, 50)}..."`,
      );
      return normalizedContent;
    }

    return rawContent;
  }

  /**
   * 动态注入当前时间到 System Prompt
   * 替换 {{CURRENT_TIME}} 占位符为实际时间
   */
  private injectCurrentTime(systemPrompt?: string): string | undefined {
    if (!systemPrompt) return systemPrompt;

    const currentTime = MessageParser.formatCurrentTime();
    return systemPrompt.replace('{{CURRENT_TIME}}', currentTime);
  }
}
