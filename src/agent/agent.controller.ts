import {
  Controller,
  Get,
  Post,
  Body,
  Logger,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentRegistryService } from './services/agent-registry.service';
import { ProfileLoaderService } from './services/agent-profile-loader.service';
import { AgentFacadeService } from './services/agent-facade.service';
import { AgentConfigValidator } from './utils/agent-validator';
import { ConfigService } from '@nestjs/config';
import { RawResponse } from '@/core';
import { FeishuAlertService } from '@core/feishu';
import * as fs from 'fs';
import * as path from 'path';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly profileLoader: ProfileLoaderService,
    private readonly validator: AgentConfigValidator,
    private readonly registryService: AgentRegistryService,
    private readonly configService: ConfigService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly agentFacade: AgentFacadeService,
  ) {}

  /**
   * 健康检查（从注册表获取健康状态）
   * GET /agent/health
   */
  @Get('health')
  async healthCheck() {
    const healthStatus = this.registryService.getHealthStatus();

    const isModelHealthy = healthStatus.models.configuredAvailable;
    const isToolHealthy = healthStatus.tools.allAvailable;

    const isHealthy = isModelHealthy && isToolHealthy;

    return {
      success: true,
      data: {
        status: isHealthy ? 'healthy' : 'degraded',
        message: isHealthy ? 'Agent 服务正常' : '⚠️ Agent 服务运行中（部分功能降级）',
        ...healthStatus,
      },
    };
  }

  /**
   * 快速健康检查（从缓存读取）
   * GET /agent/health/quick
   */
  @Get('health/quick')
  async quickHealthCheck() {
    return this.registryService.getHealthStatus();
  }

  /**
   * 上游 API 连通性检查（实际调用 Agent API 测试可达性）
   * GET /agent/health/upstream
   *
   * 用途：
   * - 监控上游 Agent API 是否可达
   * - 检测 DNS 解析和网络连接问题
   * - 可配合外部监控服务使用（如 UptimeRobot）
   */
  @Get('health/upstream')
  async checkUpstreamHealth() {
    const startTime = Date.now();

    try {
      // 尝试获取模型列表来测试上游 API 连通性
      await this.agentService.getModels();
      const responseTime = Date.now() - startTime;

      return {
        status: 'healthy',
        upstreamApi: 'reachable',
        message: '上游 Agent API 连接正常',
        responseTime: `${responseTime}ms`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      // 判断错误类型
      const isDnsError =
        error.message?.includes('EAI_AGAIN') || error.message?.includes('getaddrinfo');
      const isTimeoutError = error.message?.includes('timeout') || error.code === 'ETIMEDOUT';
      const isConnectionError =
        error.message?.includes('ECONNREFUSED') || error.message?.includes('Cannot connect');

      return {
        status: 'degraded',
        upstreamApi: 'unreachable',
        message: '⚠️ 上游 Agent API 连接失败',
        error: {
          message: error.message,
          type: isDnsError
            ? 'DNS_ERROR'
            : isTimeoutError
              ? 'TIMEOUT'
              : isConnectionError
                ? 'CONNECTION_ERROR'
                : 'UNKNOWN',
          isDnsError,
          isTimeoutError,
          isConnectionError,
        },
        responseTime: `${responseTime}ms`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * 强制刷新注册表（重新加载模型和工具列表）
   * POST /agent/health/refresh
   */
  @Post('health/refresh')
  async refreshHealth() {
    try {
      this.logger.log('手动触发刷新 Agent 注册表');
      await this.registryService.refresh();
      const healthStatus = this.registryService.getHealthStatus();

      this.logger.log('注册表刷新成功');
      return {
        success: true,
        message: '注册表刷新成功',
        data: healthStatus,
      };
    } catch (error) {
      this.logger.error('注册表刷新失败:', error);

      // 发送飞书告警
      this.feishuAlertService
        .sendAlert({
          errorType: 'agent',
          error,
          apiEndpoint: '/agent/health/refresh',
          scenario: 'REGISTRY_REFRESH_FAILED',
        })
        .catch((alertError) => {
          this.logger.error(`飞书告警发送失败: ${alertError.message}`);
        });

      throw new HttpException(
        {
          success: false,
          message: '注册表刷新失败',
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 获取可用工具列表（Agent API 原始响应）
   * GET /agent/tools
   */
  @RawResponse() // 保持 Agent API 原始响应格式
  @Get('tools')
  async getTools() {
    return await this.agentService.getTools();
  }

  /**
   * 获取可用模型列表（Agent API 原始响应）
   * GET /agent/models
   */
  @RawResponse() // 保持 Agent API 原始响应格式
  @Get('models')
  async getModels() {
    return await this.agentService.getModels();
  }

  /**
   * 获取配置的工具列表（从环境变量）
   * GET /agent/configured-tools
   */
  @Get('configured-tools')
  async getConfiguredTools() {
    const configuredTools = this.registryService.getConfiguredTools();
    const healthStatus = this.registryService.getHealthStatus();

    return {
      configuredTools,
      count: configuredTools.length,
      allAvailable: healthStatus.tools.allAvailable,
      lastRefreshTime: healthStatus.lastRefreshTime,
    };
  }

  /**
   * 获取可用的模型列表（从 Agent API 动态获取）
   * GET /agent/available-models
   */
  @Get('available-models')
  async getAvailableModels() {
    const defaultModel = this.configService.get<string>('AGENT_DEFAULT_MODEL');
    const availableModels = this.registryService.getAvailableModels();
    const healthStatus = this.registryService.getHealthStatus();

    return {
      defaultModel,
      availableModels,
      count: availableModels.length,
      defaultModelAvailable: healthStatus.models.defaultAvailable,
      lastRefreshTime: healthStatus.lastRefreshTime,
    };
  }

  /**
   * 测试工具安全校验
   * POST /agent/test-tool-validation
   * Body: { "message": "你好", "allowedTools": ["duliday_job_list", "unsafe_tool"] }
   */
  @Post('test-tool-validation')
  async testToolValidation(
    @Body()
    body: {
      message: string;
      allowedTools: string[];
      sessionId?: string;
    },
  ) {
    this.logger.log(`测试工具安全校验，请求的工具: ${body.allowedTools.join(', ')}`);
    const sessionId = body.sessionId || 'test-tool-validation';

    const result = await this.agentService.chat({
      sessionId,
      userMessage: body.message,
      allowedTools: body.allowedTools,
    });

    // 基于状态返回不同响应
    if (result.status === 'error') {
      throw new HttpException(
        result.error?.message || 'Agent 调用失败',
        result.error?.retryable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      requestedTools: body.allowedTools,
      message: '工具校验通过，已过滤不安全的工具',
      response: result.data || result.fallback,
      metadata: {
        status: result.status,
        fromCache: result.fromCache,
        correlationId: result.correlationId,
        ...(result.fallbackInfo && { fallbackInfo: result.fallbackInfo }),
      },
    };
  }

  /**
   * 测试模型安全校验
   * POST /agent/test-model-validation
   * Body: { "message": "你好", "model": "gpt-4" }
   */
  @Post('test-model-validation')
  async testModelValidation(
    @Body()
    body: {
      message: string;
      model: string;
      sessionId?: string;
    },
  ) {
    this.logger.log(`测试模型安全校验，请求的模型: ${body.model}`);
    const sessionId = body.sessionId || 'test-model-validation';

    const result = await this.agentService.chat({
      sessionId,
      userMessage: body.message,
      model: body.model,
    });

    // 基于状态返回不同响应
    if (result.status === 'error') {
      throw new HttpException(
        result.error?.message || 'Agent 调用失败',
        result.error?.retryable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      requestedModel: body.model,
      message: '模型校验完成，如果请求的模型不被允许，已自动使用默认模型',
      response: result.data || result.fallback,
      metadata: {
        status: result.status,
        fromCache: result.fromCache,
        correlationId: result.correlationId,
        ...(result.fallbackInfo && { fallbackInfo: result.fallbackInfo }),
      },
    };
  }

  /**
   * 获取所有配置档案
   * GET /agent/profiles
   */
  @Get('profiles')
  async getProfiles() {
    const profiles = this.profileLoader.getAllProfiles();
    return profiles.map((p) => ({
      name: p.name,
      description: p.description,
      model: p.model,
      allowedTools: p.allowedTools,
      hasContext: !!p.context,
      contextStrategy: p.contextStrategy,
      prune: p.prune,
    }));
  }

  /**
   * 获取特定配置档案（公开接口，已脱敏）
   * GET /agent/profiles/:scenario
   *
   * ⚠️ 安全说明：
   * - 此接口返回脱敏后的配置摘要，不包含敏感凭据
   * - context、toolContext、systemPrompt 等字段已移除
   * - 仅返回公开可见的元数据
   */
  @Get('profiles/:scenario')
  async getProfile(@Param('scenario') scenario: string) {
    const profile = this.profileLoader.getProfile(scenario);
    if (!profile) {
      throw new HttpException(`未找到场景 ${scenario} 的配置`, HttpStatus.NOT_FOUND);
    }

    // 返回脱敏后的公开版本，移除敏感字段
    return {
      name: profile.name,
      description: profile.description,
      model: profile.model,
      allowedTools: profile.allowedTools || [],
      contextStrategy: profile.contextStrategy,
      prune: profile.prune,
      pruneOptions: profile.pruneOptions,
      // 敏感字段已移除：
      // - context（可能包含 API tokens）
      // - toolContext（可能包含业务敏感配置）
      // - systemPrompt（可能包含业务逻辑）
    };
  }

  /**
   * 验证配置档案
   * GET /agent/profiles/:scenario/validate
   */
  @Get('profiles/:scenario/validate')
  async validateProfile(@Param('scenario') scenario: string) {
    const profile = this.profileLoader.getProfile(scenario);
    if (!profile) {
      throw new HttpException(`未找到场景 ${scenario} 的配置`, HttpStatus.NOT_FOUND);
    }

    // 验证必填字段
    try {
      this.validator.validateRequiredFields(profile);
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }

    // 验证上下文
    const contextValidation = this.validator.validateContext(profile.context);

    return {
      valid: contextValidation.isValid,
      context: contextValidation,
    };
  }

  /**
   * 调试接口：测试聊天并返回完整的 Agent 原始响应
   * POST /agent/debug-chat
   * Body: { "message": "你好", "sessionId"?: "...", "scenario"?: "..." }
   *
   * 返回完整的 AgentResult，包括：
   * - data: 完整的 ChatResponse 原始响应
   * - status: 成功/降级/错误状态
   * - fromCache: 是否来自缓存
   * - correlationId: 关联ID
   */
  @Post('debug-chat')
  async debugChat(
    @Body()
    body: {
      message: string;
      sessionId?: string;
      scenario?: string;
      model?: string;
      allowedTools?: string[];
      userId?: string;
      thinking?: { type: 'enabled' | 'disabled'; budgetTokens: number };
    },
  ) {
    this.logger.log('【调试模式】测试聊天:', body.message);
    const sessionId = body.sessionId || `debug-${Date.now()}`;
    const scenario = body.scenario || 'candidate-consultation';

    // 通过 Facade 统一调用（参数准备全在 Facade 内部）
    const result = await this.agentFacade.chatWithScenario(scenario, sessionId, body.message, {
      model: body.model,
      allowedTools: body.allowedTools,
      userId: body.userId,
      thinking: body.thinking,
    });

    // 返回完整的 AgentResult，不做任何裁剪
    const debugResponse = {
      success: result.status !== 'error',
      sessionId,
      scenario,
      // === 发给花卷 API 的完整请求体（便于调试入参） ===
      requestBody: (result as any).requestBody || null,
      // === 完整的 AgentResult ===
      agentResult: {
        status: result.status,
        data: result.data,
        fallback: result.fallback,
        fallbackInfo: result.fallbackInfo,
        error: result.error,
        fromCache: result.fromCache,
        correlationId: result.correlationId,
      },
      // === 便于查看的响应文本提取 ===
      extractedText: this.extractResponseText(result),
      timestamp: new Date().toISOString(),
    };

    // 写入调试文件，便于开发时查看完整入参+出参
    this.writeDebugFile(debugResponse);

    return debugResponse;
  }

  /**
   * 写入调试文件 scripts/agent-debug-response.json
   * 异步写入，不阻塞响应
   */
  private writeDebugFile(data: unknown): void {
    const filePath = path.resolve(process.cwd(), 'scripts/agent-debug-response.json');
    fs.promises
      .writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
      .then(() => this.logger.debug(`调试文件已写入: ${filePath}`))
      .catch((err) => this.logger.warn(`调试文件写入失败: ${err.message}`));
  }

  /**
   * 从 AgentResult 中提取响应文本（辅助方法）
   */
  private extractResponseText(result: any): string | null {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return null;

      return response.messages
        .map((msg: any) => {
          if (msg.parts) {
            return msg.parts.map((p: any) => p.text || '').join('');
          }
          return msg.content || '';
        })
        .join('\n\n');
    } catch {
      return null;
    }
  }

  /**
   * 调试接口：查看传给 Agent API 的完整数据结构
   * GET /agent/debug-context
   *
   * 返回将要传递给 Agent API 的完整 context 结构（用于诊断工具配置问题）
   */
  @Get('debug-context')
  async debugContext() {
    const scenario = 'candidate-consultation';
    const profile = this.profileLoader.getProfile(scenario);

    if (!profile) {
      return { error: `未找到场景 ${scenario} 的配置` };
    }

    return {
      scenario,
      profileName: profile.name,
      // 原始 profile.context
      originalContext: {
        ...(profile.context || {}),
        // 脱敏 dulidayToken
        dulidayToken: profile.context?.dulidayToken
          ? `${String(profile.context.dulidayToken).substring(0, 20)}...`
          : undefined,
      },
      // toolContext 结构
      toolContext: profile.toolContext,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 使用配置档案进行聊天（微信群场景示例）
   * POST /agent/chat-with-profile
   * Body: {
   *   "scenario": "wechat-group-assistant",
   *   "message": "你好",
   *   "roomId": "room-123",
   *   "fromUser": "user-456"
   * }
   */
  @Post('chat-with-profile')
  async chatWithProfile(
    @Body()
    body: {
      scenario: string;
      message: string;
      roomId?: string;
      fromUser: string;
      model?: string;
      allowedTools?: string[];
      userId?: string;
    },
  ) {
    this.logger.log(`使用配置档案聊天: ${body.scenario}, 消息: ${body.message}`);

    const sessionId = body.roomId ? `room_${body.roomId}` : `user_${body.fromUser}`;

    // 通过 Facade 统一调用
    const result = await this.agentFacade.chatWithScenario(body.scenario, sessionId, body.message, {
      model: body.model,
      allowedTools: body.allowedTools,
      userId: body.userId,
    });

    if (result.status === 'error') {
      throw new HttpException(
        result.error?.message || 'Agent 调用失败',
        result.error?.retryable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      sessionId,
      scenario: body.scenario,
      response: result.data || result.fallback,
      metadata: {
        status: result.status,
        fromCache: result.fromCache,
        correlationId: result.correlationId,
        ...(result.fallbackInfo && { fallbackInfo: result.fallbackInfo }),
      },
    };
  }
}
