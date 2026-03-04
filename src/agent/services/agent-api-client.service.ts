import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance, AxiosResponse } from 'axios';
import { HttpClientFactory } from '@core/client-http';
import { AgentRateLimitException, AgentAuthException } from '../utils/agent-exceptions';
import { ApiResponse, ChatRequest, ChatResponse } from '../utils/agent-types';
import {
  AGENT_API_KEY_FALLBACK,
  AGENT_API_BASE_URL_FALLBACK,
} from '@core/config/constants/agent.constants';

/**
 * Agent API 客户端服务
 * 负责处理与 Agent API 的所有 HTTP 通信
 *
 * 职责：
 * 1. HTTP 客户端管理
 * 2. API 调用封装（chat, getModels, getTools）
 * 3. 请求重试和速率限制处理
 * 4. 错误转换和统一异常处理
 */
@Injectable()
export class AgentApiClientService {
  private readonly logger = new Logger(AgentApiClientService.name);
  private readonly httpClient: AxiosInstance;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpClientFactory: HttpClientFactory,
  ) {
    // 从环境变量读取配置，如果未配置则使用 fallback
    const envApiKey = this.configService.get<string>('AGENT_API_KEY');
    const envBaseURL = this.configService.get<string>('AGENT_API_BASE_URL');

    this.apiKey = envApiKey || AGENT_API_KEY_FALLBACK;
    this.baseURL = envBaseURL || AGENT_API_BASE_URL_FALLBACK;
    this.timeout = this.configService.get<number>('AGENT_API_TIMEOUT') ?? 180000; // 默认 3 分钟
    // 重试策略：Agent 层仅处理瞬时网络抖动（2次），持久性故障由 Bull Queue 层处理（3次）
    this.maxRetries = this.configService.get<number>('AGENT_API_MAX_RETRIES') ?? 2;

    // 验证最终配置
    if (!this.apiKey) {
      throw new Error(
        '❌ AGENT_API_KEY 未配置或为空，请检查环境变量或 fallback 配置。' +
          '\n提示：请确保 .env 文件存在且包含 AGENT_API_KEY 配置',
      );
    }
    if (!this.baseURL) {
      throw new Error(
        '❌ AGENT_API_BASE_URL 未配置或为空，请检查环境变量或 fallback 配置。' +
          '\n提示：请确保 .env 文件存在且包含 AGENT_API_BASE_URL 配置',
      );
    }

    // 记录配置来源
    if (!envApiKey) {
      this.logger.warn('⚠️  未检测到环境变量 AGENT_API_KEY，使用硬编码 fallback 配置');
    }
    if (!envBaseURL) {
      this.logger.warn('⚠️  未检测到环境变量 AGENT_API_BASE_URL，使用硬编码 fallback 配置');
    }

    // 脱敏显示 API Key（只显示前6位和后6位）
    const maskedApiKey =
      this.apiKey.length > 12
        ? `${this.apiKey.substring(0, 6)}...${this.apiKey.substring(this.apiKey.length - 6)}`
        : '***';

    this.logger.log(`初始化 Agent API 客户端: ${this.baseURL}`);
    this.logger.log(`API Key (脱敏): ${maskedApiKey}`);
    this.logger.log(`API 超时设置: ${this.timeout}ms`);
    this.logger.log(`最大重试次数: ${this.maxRetries}`);

    // 使用工厂创建 HTTP 客户端实例
    this.httpClient = this.httpClientFactory.createWithBearerAuth(
      {
        baseURL: this.baseURL,
        timeout: this.timeout,
        logPrefix: '[Agent API]',
        verbose: false,
      },
      this.apiKey,
    );

    // 配置重试拦截器
    this.setupRetryInterceptor();
  }

  /**
   * 调用 /api/v1/chat 接口
   * @param request 聊天请求参数
   * @param sessionId 会话ID（用于日志）
   * @returns API 响应
   */
  async chat(
    request: ChatRequest,
    sessionId: string,
  ): Promise<AxiosResponse<ApiResponse<ChatResponse>>> {
    try {
      // 仅记录元数据，避免泄漏 system prompt / 用户消息 / toolContext
      this.logger.debug(
        `[Chat Request] 会话: ${sessionId}, 消息数: ${request.messages?.length ?? 0}, 模型: ${request.model ?? 'default'}, 工具数: ${request.allowedTools?.length ?? 0}`,
      );
      // 将 sessionId 附加到 config，供拦截器使用
      const response = await this.httpClient.post<ApiResponse<ChatResponse>>('/chat', request, {
        headers: { 'X-Conversation-Id': sessionId },
      });
      return response;
    } catch (error) {
      // 【优化】调用失败时记录会话ID
      this.logger.error(`Agent API 调用失败，会话: ${sessionId}`);

      // 【优化】将请求元数据和脱敏 API Key 附加到错误对象，供飞书告警使用
      (error as any).requestParams = {
        model: request.model,
        messageCount: request.messages?.length,
      };
      (error as any).apiKey = this.maskApiKey(); // 仅附加脱敏后的 API Key
      const headersClone = (error as any)?.config?.headers
        ? { ...(error as any).config.headers }
        : undefined;
      if (headersClone) {
        (error as any).requestHeaders = headersClone;
      }

      // 转换异常
      throw this.convertError(error);
    }
  }

  /**
   * 调用 /api/v1/chat 接口（流式输出）
   * @param request 聊天请求参数
   * @param sessionId 会话ID（用于日志）
   * @returns 可读流
   */
  async chatStream(
    request: Omit<ChatRequest, 'stream'>,
    sessionId: string,
  ): Promise<NodeJS.ReadableStream> {
    try {
      // 强制设置 stream: true
      const streamRequest = { ...request, stream: true };

      this.logger.log(`[Stream] 发起流式请求，会话: ${sessionId}`);

      const response = await this.httpClient.post('/chat', streamRequest, {
        headers: { 'X-Conversation-Id': sessionId },
        responseType: 'stream',
      });

      return response.data as NodeJS.ReadableStream;
    } catch (error) {
      this.logger.error(`[Stream] Agent API 流式调用失败，会话: ${sessionId}`);
      (error as any).requestParams = {
        model: request.model,
        messageCount: request.messages?.length,
      };
      (error as any).apiKey = this.maskApiKey();
      throw this.convertError(error);
    }
  }

  /**
   * 获取可用模型列表
   */
  async getModels() {
    try {
      this.logger.log('获取可用模型列表...');
      const response = await this.httpClient.get('/models');
      return response.data;
    } catch (error) {
      this.logger.error('获取模型列表失败:', error);
      (error as any).apiKey = this.maskApiKey();
      throw error;
    }
  }

  /**
   * 获取可用工具列表
   */
  async getTools() {
    try {
      this.logger.log('获取可用工具列表...');
      const response = await this.httpClient.get('/tools');
      return response.data;
    } catch (error) {
      this.logger.error('获取工具列表失败:', error);
      (error as any).apiKey = this.maskApiKey();
      throw error;
    }
  }

  /**
   * 配置重试拦截器
   * 使用 Axios 拦截器实现自动重试，避免阻塞业务逻辑
   */
  private setupRetryInterceptor(): void {
    this.httpClient.interceptors.response.use(
      // 成功响应直接返回
      (response) => response,
      // 错误响应处理
      async (error) => {
        const config = error.config;
        const sessionId = config?.headers?.['X-Conversation-Id'] || 'unknown';

        // 初始化重试计数器
        config.retryCount = config.retryCount || 0;

        // 判断是否应该重试
        const shouldRetry = this.shouldRetry(error, config.retryCount);

        if (shouldRetry && config.retryCount < this.maxRetries) {
          config.retryCount += 1;

          // 计算延迟时间
          const delay = this.calculateRetryDelay(error, config.retryCount);

          this.logger.warn(
            `请求失败，${delay}ms后重试，会话: ${sessionId}, 尝试 ${config.retryCount}/${this.maxRetries}`,
          );

          // 延迟后重试（使用 Promise 不阻塞）
          await new Promise((resolve) => setTimeout(resolve, delay));

          // 重新发起请求
          return this.httpClient.request(config);
        }

        // 不应重试或已达最大重试次数，返回错误
        return Promise.reject(error);
      },
    );
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: any, retryCount: number): boolean {
    // 已达最大重试次数
    if (retryCount >= this.maxRetries) {
      return false;
    }

    // 没有响应（网络错误）应该重试
    if (!error.response) {
      return true;
    }

    const status = error.response.status;

    // 不可重试的状态码
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return false;
    }

    // 可重试的状态码：429（速率限制）、5xx（服务器错误）
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }

    return false;
  }

  /**
   * 计算重试延迟时间
   * - 429错误：使用服务器返回的 retryAfter
   * - 其他错误：使用指数退避策略
   */
  private calculateRetryDelay(error: any, retryCount: number): number {
    // 429 错误：使用 Retry-After header 或响应体中的 retryAfter
    if (error.response?.status === 429) {
      const retryAfter =
        parseInt(error.response.headers['retry-after']) ||
        error.response.data?.details?.retryAfter ||
        60;
      return retryAfter * 1000;
    }

    // 其他错误：指数退避 1s, 2s, 4s
    return Math.pow(2, retryCount - 1) * 1000;
  }

  /** 返回脱敏后的 API Key（前6+后6） */
  private maskApiKey(): string {
    return this.apiKey.length > 12
      ? `${this.apiKey.substring(0, 6)}...${this.apiKey.substring(this.apiKey.length - 6)}`
      : '***';
  }

  /**
   * 转换错误为业务异常
   */
  private convertError(error: any): Error {
    const status = error.response?.status;
    const requestParams = error.requestParams; // 保留请求参数
    const apiKey = error.apiKey; // 保留 API Key
    const requestHeaders = error.requestHeaders;
    const originalResponse = error.response; // 保留原始响应

    let convertedError: Error;

    // 401/403 认证失败
    if (status === 401 || status === 403) {
      const message =
        error.response?.data?.message || error.response?.data?.error || 'API Key 无效或已过期';
      const authException = new AgentAuthException(message, status);
      authException.apiResponse = originalResponse; // 【修复】保留原始响应
      convertedError = authException;
    }
    // 429 频率限制
    else if (status === 429) {
      const retryAfter = error.response.data?.details?.retryAfter || 60;
      const rateLimitException = new AgentRateLimitException(
        retryAfter,
        `请求频率过高，请${retryAfter}秒后重试`,
      );
      rateLimitException.apiResponse = originalResponse; // 【修复】保留原始响应
      convertedError = rateLimitException;
    }
    // 其他错误直接返回
    else {
      convertedError = error;
    }

    // 【优化】将请求参数和 API Key 附加到转换后的错误对象
    if (requestParams) {
      (convertedError as any).requestParams = requestParams;
    }
    if (apiKey) {
      (convertedError as any).apiKey = apiKey;
    }
    if (requestHeaders) {
      (convertedError as any).requestHeaders = requestHeaders;
    }

    return convertedError;
  }
}
