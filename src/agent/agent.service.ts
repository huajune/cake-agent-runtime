import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import {
  ApiResponse,
  ChatRequest,
  ChatResponse,
  SimpleMessage,
  AgentResult,
  RawHttpResponseInfo,
  ContextStrategy,
} from './utils/agent-types';
import { MessageRole } from '@shared/enums';
import {
  AgentApiException,
  AgentConfigException,
  AgentContextMissingException,
  AgentRateLimitException,
} from './utils/agent-exceptions';
import { getModelDisplayName } from './utils';
import { AgentRegistryService } from './services/agent-registry.service';
import { AgentFallbackService } from './services/agent-fallback.service';
import { AgentApiClientService } from './services/agent-api-client.service';
import { ProfileSanitizer, AgentProfile } from './utils/agent-profile-sanitizer';
import { AgentLogger } from './utils/agent-logger';
import { createSuccessResult, createFallbackResult } from './utils/agent-result-helper';

/**
 * Agent 服务（简化版）
 * 负责调用 Agent API 的核心业务逻辑
 *
 * 职责：
 * 1. 参数验证和预处理
 * 2. 组装请求并调用 API
 * 3. 处理响应和错误
 * 4. 统一降级策略
 *
 * 已委托给其他服务：
 * - API 调用和重试 → AgentApiClientService
 * - 模型/工具验证 → AgentRegistryService
 * - 降级策略 → AgentFallbackService
 * - 配置验证和品牌配置监控 → AgentConfigService (在 getProfile 中处理)
 * - 日志处理 → AgentLogger
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly agentLogger: AgentLogger;

  constructor(
    private readonly configService: ConfigService,
    private readonly apiClient: AgentApiClientService,
    private readonly registryService: AgentRegistryService,
    private readonly fallbackService: AgentFallbackService,
  ) {
    // 初始化日志工具
    this.agentLogger = new AgentLogger(this.logger, this.configService);

    // 注意：工具和模型配置现在统一由 AgentRegistryService 管理
    this.logger.log('AgentService 已初始化（工具/模型由 RegistryService 统一管理）');
  }

  /**
   * 调用 /api/v1/chat 接口（非流式）
   * 支持完整的 API 契约参数
   *
   * 注意：API 契约字段名映射
   * - messages: 历史消息数组（API 契约字段名）
   * - conversationId: 仅用于日志追踪，不传给 API
   * - userMessage: 仅用于内部处理，会被添加到 messages 数组中
   *
   * @returns AgentResult 统一响应模型
   */
  async chat(params: {
    conversationId: string; // 仅用于日志追踪，不传给 API
    userMessage: string; // 用户当前消息，会被添加到 messages 数组
    messages?: SimpleMessage[]; // API 契约字段名：历史消息数组
    model?: string;
    promptType?: string;
    systemPrompt?: string;
    allowedTools?: string[];
    context?: any;
    toolContext?: any;
    contextStrategy?: ContextStrategy;
    prune?: boolean;
    pruneOptions?: {
      maxOutputTokens?: number;
      targetTokens?: number;
      preserveRecentMessages?: number;
    };
    validateOnly?: boolean;
  }): Promise<AgentResult> {
    const { conversationId, messages = [] } = params;

    // 保存 chatRequest 引用，用于错误时也能附加到结果
    let chatRequest: ChatRequest | undefined;

    try {
      // 1. 准备请求（验证 + 构建）
      const preparedRequest = this.prepareRequest(params, conversationId, messages);
      chatRequest = preparedRequest.chatRequest;

      // 2. 执行请求（直接调用 API）
      const result = await this.executeRequest(preparedRequest, conversationId);

      // 3. 记录结果（日志 + 统计）
      this.recordResult(result.data, conversationId);

      // 4. 返回成功结果（包含原始 HTTP 响应信息 + 请求参数）
      const agentResult = createSuccessResult(result.data, undefined, false);
      agentResult.rawHttpResponse = result.rawHttpResponse;
      (agentResult as any).requestBody = chatRequest;
      return agentResult;
    } catch (error) {
      // 统一错误处理，附加 chatRequest
      const agentResult = this.handleChatError(error, conversationId);
      if (chatRequest) {
        (agentResult as any).requestBody = chatRequest;
      }
      return agentResult;
    }
  }

  /**
   * 使用配置档案调用 chat 接口
   * @param conversationId 会话ID
   * @param userMessage 用户消息
   * @param profile Agent配置档案
   * @param overrides 覆盖配置档案的参数
   * @returns AgentResult 统一响应模型
   */
  async chatWithProfile(
    conversationId: string,
    userMessage: string,
    profile: AgentProfile,
    overrides?: Partial<AgentProfile>,
  ): Promise<AgentResult> {
    // 1. 清洗和合并配置
    const sanitized = ProfileSanitizer.merge(profile, overrides);

    // 2. 调用 chat 方法
    // 注意：品牌配置验证已在 AgentConfigService.getProfile() 中完成
    return this.chat({
      conversationId,
      userMessage,
      ...sanitized,
    });
  }

  /**
   * 调用 /api/v1/chat 接口（流式输出）
   * 支持完整的 API 契约参数，返回可读流
   *
   * @returns 包含流和请求元数据的对象
   */
  async chatStream(params: {
    conversationId: string;
    userMessage: string;
    messages?: SimpleMessage[];
    model?: string;
    systemPrompt?: string;
    allowedTools?: string[];
    context?: any;
    toolContext?: any;
    contextStrategy?: ContextStrategy;
    prune?: boolean;
    pruneOptions?: {
      maxOutputTokens?: number;
      targetTokens?: number;
      preserveRecentMessages?: number;
    };
  }): Promise<{
    stream: NodeJS.ReadableStream;
    requestBody: ChatRequest;
    estimatedInputTokens: number;
  }> {
    const { conversationId, messages = [] } = params;

    // 1. 准备请求（验证 + 构建）
    const preparedRequest = this.prepareRequest(params, conversationId, messages);
    const { chatRequest } = preparedRequest;

    // 2. 计算预估输入 Token
    const estimatedInputTokens = this.estimateInputTokens(chatRequest);

    this.logger.log(
      `[Stream] 发起流式请求，会话: ${conversationId}, 预估 Token: ${estimatedInputTokens}`,
    );

    // 3. 调用流式 API
    const stream = await this.apiClient.chatStream(chatRequest, conversationId);

    return {
      stream,
      requestBody: chatRequest,
      estimatedInputTokens,
    };
  }

  /**
   * 使用配置档案调用流式 chat 接口
   * @param conversationId 会话ID
   * @param userMessage 用户消息
   * @param profile Agent配置档案
   * @param overrides 覆盖配置档案的参数
   * @returns 包含流和请求元数据的对象
   */
  async chatStreamWithProfile(
    conversationId: string,
    userMessage: string,
    profile: AgentProfile,
    overrides?: Partial<AgentProfile> & { messages?: SimpleMessage[] },
  ): Promise<{
    stream: NodeJS.ReadableStream;
    requestBody: ChatRequest;
    estimatedInputTokens: number;
  }> {
    // 1. 清洗和合并配置
    const sanitized = ProfileSanitizer.merge(profile, overrides);

    // 2. 调用 chatStream 方法
    return this.chatStream({
      conversationId,
      userMessage,
      messages: overrides?.messages,
      ...sanitized,
    });
  }

  /**
   * 获取可用模型列表
   */
  async getModels() {
    return this.apiClient.getModels();
  }

  /**
   * 获取可用工具列表
   */
  async getTools() {
    return this.apiClient.getTools();
  }

  // ========== 私有辅助方法 ==========

  /**
   * 准备请求（验证 + 构建）
   * 职责：验证用户输入、模型和工具，构建最终的请求对象
   */
  private prepareRequest(
    params: any,
    conversationId: string,
    messages: SimpleMessage[],
  ): { chatRequest: ChatRequest; validatedModel: string; validatedTools: string[] } {
    const { userMessage } = params;

    // 验证用户消息
    this.validateUserMessage(userMessage);

    // 验证和准备模型、工具
    const validatedModel = this.registryService.validateModel(params.model);
    const validatedTools = this.registryService.validateTools(params.allowedTools);

    // 记录模型和工具信息
    this.logModelAndTools(conversationId, validatedModel, validatedTools, params.model);

    // 构建请求
    const chatRequest = this.buildChatRequest({
      ...params,
      model: validatedModel,
      allowedTools: validatedTools,
      messages, // API 契约字段名
      userMessage,
    });

    // 记录请求日志
    this.agentLogger.logRequest(conversationId, chatRequest);

    return { chatRequest, validatedModel, validatedTools };
  }

  /**
   * 执行请求（直接调用 API）
   */
  private async executeRequest(
    preparedRequest: { chatRequest: ChatRequest },
    conversationId: string,
  ): Promise<{ data: ChatResponse; rawHttpResponse?: RawHttpResponseInfo }> {
    const { chatRequest } = preparedRequest;

    // 直接调用 API
    const response = await this.apiClient.chat(chatRequest, conversationId);
    const handled = this.handleChatResponse(response, conversationId);

    return { data: handled.data, rawHttpResponse: response };
  }

  /**
   * 记录结果（日志 + 统计）
   * 职责：记录响应日志和使用统计
   */
  private recordResult(data: ChatResponse, conversationId: string): void {
    // 记录响应日志
    this.agentLogger.logResponse(conversationId, data);

    // 记录使用统计
    this.logUsageStats(data, conversationId);
  }

  /**
   * 验证用户消息
   */
  private validateUserMessage(userMessage: string): void {
    if (!userMessage || userMessage.trim() === '') {
      throw new AgentConfigException('用户消息内容不能为空');
    }
  }

  /**
   * 记录模型和工具信息
   */
  private logModelAndTools(
    conversationId: string,
    validatedModel: string,
    validatedTools: string[],
    requestedModel?: string,
  ): void {
    if (requestedModel && requestedModel !== validatedModel) {
      this.logger.warn(
        `请求的模型 "${requestedModel}" 不可用，已回退到默认模型 "${validatedModel}"`,
      );
      this.logger.warn(`会话: ${conversationId}`);
    } else if (validatedModel !== this.registryService.getConfiguredModel() && requestedModel) {
      this.logger.log(`使用模型: ${getModelDisplayName(validatedModel)}，会话: ${conversationId}`);
    }

    this.logger.log(
      `传递给 Agent API 的消息: ${validatedTools.length} 个工具, 会话: ${conversationId}`,
    );
  }

  /**
   * 构建聊天请求
   * 注意：messages 是 API 契约字段名，包含历史消息
   */
  private buildChatRequest(params: {
    model: string;
    promptType?: string;
    userMessage: string;
    messages: SimpleMessage[]; // API 契约字段名：历史消息数组
    systemPrompt?: string;
    allowedTools?: string[];
    context?: any;
    toolContext?: any;
    contextStrategy?: ContextStrategy;
    prune?: boolean;
    pruneOptions?: any;
    validateOnly?: boolean;
  }): ChatRequest {
    const userMsg: SimpleMessage = { role: MessageRole.USER, content: params.userMessage };
    const chatRequest: ChatRequest = {
      model: params.model,
      messages: [...params.messages, userMsg], // 历史消息 + 当前用户消息
      stream: false,
    };

    // 只添加有值的可选字段
    if (params.promptType) chatRequest.promptType = params.promptType;
    if (params.systemPrompt) chatRequest.systemPrompt = params.systemPrompt;
    // 注意：空数组 [] 表示禁用所有工具，也需要传递
    if (params.allowedTools !== undefined) {
      chatRequest.allowedTools = params.allowedTools;
    }
    // 初始化 context（确保 modelConfig 总是被注入）
    const context = params.context ? { ...params.context } : {};

    // 注入 modelConfig（花卷 API 多模型配置）
    // 如果调用方已提供 modelConfig，则保留调用方的配置（允许覆盖）
    if (!context.modelConfig) {
      context.modelConfig = this.registryService.getModelConfig();
      this.logger.debug(
        `✅ buildChatRequest: 注入 modelConfig - chatModel: ${context.modelConfig.chatModel}, classifyModel: ${context.modelConfig.classifyModel}, extractModel: ${context.modelConfig.extractModel}`,
      );
    }

    // 调试日志：检查 context 中的 dulidayToken
    if ('dulidayToken' in context) {
      this.logger.debug(
        `✅ buildChatRequest: context 中包含 dulidayToken: ${context.dulidayToken ? '已设置' : '为空'}`,
      );
    } else {
      this.logger.warn('⚠️ buildChatRequest: context 中未找到 dulidayToken');
    }

    // 只有在 context 有内容时才添加
    if (Object.keys(context).length > 0) {
      chatRequest.context = context;
    }
    if (params.toolContext && Object.keys(params.toolContext).length > 0) {
      // 过滤 toolContext：只保留 allowedTools 中存在的工具
      // 避免 Agent API 因引用了不在 allowedTools 中的工具 context 而返回 400
      if (params.allowedTools === undefined) {
        // allowedTools 未指定：直接透传全量 toolContext
        chatRequest.toolContext = params.toolContext;
      } else if (params.allowedTools.length > 0) {
        // allowedTools 已指定：过滤掉未在列表中的工具 context
        const allowedSet = new Set(params.allowedTools);
        const filteredToolContext: Record<string, unknown> = {};
        for (const [toolName, toolCtx] of Object.entries(params.toolContext)) {
          if (allowedSet.has(toolName)) {
            filteredToolContext[toolName] = toolCtx;
          }
        }
        if (Object.keys(filteredToolContext).length > 0) {
          chatRequest.toolContext = filteredToolContext as typeof params.toolContext;
        }
      }
      // allowedTools 为 [] 时：禁用所有工具，toolContext 无意义，不传
    }
    if (params.contextStrategy) chatRequest.contextStrategy = params.contextStrategy;
    if (params.prune !== undefined) chatRequest.prune = params.prune;
    if (params.pruneOptions) chatRequest.pruneOptions = params.pruneOptions;
    if (params.validateOnly !== undefined) chatRequest.validateOnly = params.validateOnly;

    return chatRequest;
  }

  /**
   * 处理聊天响应
   * 返回 ChatResponse 和原始 HTTP 响应信息
   */
  private handleChatResponse(
    response: AxiosResponse<ApiResponse<ChatResponse>>,
    conversationId: string,
  ): { data: ChatResponse } {
    // 提取 correlationId
    const correlationId =
      response.headers['x-correlation-id'] || response.data.correlationId || 'N/A';

    // 检查 API 响应是否成功
    if (!response.data.success) {
      const errorData = response.data as any;

      this.logger.error(
        `Agent API 返回失败，会话: ${conversationId}, correlationId: ${correlationId}`,
        errorData,
      );

      // 处理上下文缺失错误
      if (errorData.details?.missingContext && errorData.details?.tools) {
        throw new AgentContextMissingException(
          errorData.details.missingContext,
          errorData.details.tools,
        );
      }

      throw new AgentApiException(response.data.error || '未知错误', errorData.details);
    }

    const chatResponse = response.data.data;

    // 记录 correlationId
    this.logger.log(`Agent API 成功，会话: ${conversationId}, correlationId: ${correlationId}`);

    return { data: chatResponse };
  }

  /**
   * 处理聊天错误（统一降级策略）
   * 所有错误都统一降级，确保用户无感知
   *
   * 注意：告警已统一移至 MessagePipelineService，此处仅负责降级处理
   * 这样可以避免重复告警，确保每个错误只告警一次
   */
  private handleChatError(error: any, conversationId: string): AgentResult {
    this.logger.error(`Agent API 调用失败，会话: ${conversationId}`, error);

    // 提取调试信息（用于附加到结果，供上层告警使用）
    const requestParams = (error as any).requestParams;
    const apiKey = (error as any).apiKey;
    const apiResponse = (error as any).apiResponse || (error as any).response;
    const requestHeaders = (error as any).requestHeaders;

    // 统一降级处理：所有错误都返回降级消息，确保用户无感知
    const retryAfter = error instanceof AgentRateLimitException ? error.retryAfter : undefined;
    const errorMessage = error.message || '未知错误';

    return this.createFallbackResultWithMetadata(errorMessage, retryAfter, conversationId, {
      requestParams,
      apiKey,
      apiResponse,
      requestHeaders,
    });
  }

  /**
   * 创建降级响应（附加元数据）
   */
  private createFallbackResultWithMetadata(
    errorMessage: string,
    retryAfter: number | undefined,
    conversationId: string,
    metadata: { requestParams?: any; apiKey?: any; apiResponse?: any; requestHeaders?: any },
  ): AgentResult {
    const fallbackInfo = this.fallbackService.getFallbackInfo(errorMessage, retryAfter);
    const fallbackResponse = this.createFallbackResponse(fallbackInfo.message);
    const fallbackResult = createFallbackResult(fallbackResponse, fallbackInfo, conversationId);
    // 附加调试信息
    (fallbackResult as any).requestParams = metadata.requestParams;
    (fallbackResult as any).apiKey = metadata.apiKey;
    (fallbackResult as any).response = metadata.apiResponse;
    (fallbackResult as any).requestHeaders = metadata.requestHeaders;
    return fallbackResult;
  }

  /**
   * 记录使用统计
   */
  private logUsageStats(response: ChatResponse, conversationId: string): void {
    const { usage, tools } = response;

    // 记录 Token 使用情况
    this.logger.log(
      `Token使用 [会话: ${conversationId}] - ` +
        `输入: ${usage.inputTokens}, 输出: ${usage.outputTokens}, 总计: ${usage.totalTokens}` +
        (usage.cachedInputTokens ? `, 缓存: ${usage.cachedInputTokens}` : ''),
    );

    // 记录工具调用情况
    if (tools) {
      if (tools.used && tools.used.length > 0) {
        this.logger.log(`工具调用 [会话: ${conversationId}] - 已使用: [${tools.used.join(', ')}]`);
      } else {
        this.logger.log(`工具调用 [会话: ${conversationId}] - 未使用任何工具`);
      }

      if (tools.skipped && tools.skipped.length > 0) {
        this.logger.debug(
          `工具调用 [会话: ${conversationId}] - 已跳过: [${tools.skipped.join(', ')}]`,
        );
      }
    }
  }

  /**
   * 创建降级响应
   * @param fallbackMessage 降级消息文本
   * @returns 模拟的 ChatResponse
   */
  private createFallbackResponse(fallbackMessage: string): ChatResponse {
    return {
      messages: [
        {
          role: MessageRole.ASSISTANT,
          parts: [
            {
              type: 'text',
              text: fallbackMessage,
            },
          ],
        },
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      tools: {
        used: [],
        skipped: [],
      },
    };
  }

  /**
   * 估算输入 Token 数
   * 简单估算：平均每字符约 0.5 token（中英文混合场景）
   */
  private estimateInputTokens(request: ChatRequest): number {
    let totalChars = 0;

    // 消息内容
    for (const msg of request.messages) {
      if ('content' in msg) {
        totalChars += msg.content.length;
      } else if ('parts' in msg) {
        totalChars += msg.parts.reduce((sum, p) => sum + (p.text?.length || 0), 0);
      }
    }

    // 系统提示词
    if (request.systemPrompt) {
      totalChars += request.systemPrompt.length;
    }

    // 上下文（JSON 序列化后估算）
    if (request.context) {
      try {
        totalChars += JSON.stringify(request.context).length;
      } catch {
        // 忽略序列化错误
      }
    }

    // 简单估算：平均每字符 0.5 token
    return Math.ceil(totalChars * 0.5);
  }
}
