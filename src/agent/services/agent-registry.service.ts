import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseToolsFromEnv } from '../utils';
import { AgentApiClientService } from './agent-api-client.service';
import { FeishuAlertService } from '@core/feishu';
import { maskApiKey } from '@core/utils';

/**
 * 工具信息接口
 */
export interface ToolInfo {
  requiresSandbox: boolean;
  requiredContext: string[];
}

/**
 * Agent 资源注册表服务
 * 负责管理可用的模型和工具列表，统一管理资源的加载、验证和刷新
 *
 * 职责：
 * 1. 在模块初始化时加载可用的模型和工具列表
 * 2. 定期刷新模型和工具列表
 * 3. 验证模型和工具的可用性
 * 4. 提供健康状态查询
 */
@Injectable()
export class AgentRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRegistryService.name);

  // 缓存：可用的模型和工具列表
  private availableModels: string[] = [];
  private availableTools = new Map<string, ToolInfo>();

  // 配置：从环境变量读取的默认配置
  private readonly configuredModel: string;
  private readonly configuredTools: string[];
  private readonly chatModel: string;
  private readonly classifyModel: string;
  private readonly replyModel: string;

  // 刷新策略
  private readonly autoRefreshInterval: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRefreshTime: Date | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly apiClient: AgentApiClientService,
    private readonly feishuAlertService: FeishuAlertService,
  ) {
    // 读取配置
    this.configuredModel = this.configService.get<string>('AGENT_DEFAULT_MODEL')!;
    this.chatModel = this.configService.get<string>('AGENT_CHAT_MODEL')!;
    this.classifyModel = this.configService.get<string>('AGENT_CLASSIFY_MODEL')!;
    this.replyModel = this.configService.get<string>('AGENT_REPLY_MODEL')!;
    const toolsString = this.configService.get<string>('AGENT_ALLOWED_TOOLS', '');
    this.configuredTools = parseToolsFromEnv(toolsString);

    // 自动刷新间隔（默认1小时）
    this.autoRefreshInterval = this.configService.get<number>(
      'AGENT_REGISTRY_REFRESH_INTERVAL_MS',
      3600000,
    );

    this.logger.log(`配置的默认模型: ${this.configuredModel}`);
    this.logger.log(`配置的聊天模型: ${this.chatModel}`);
    this.logger.log(`配置的分类模型: ${this.classifyModel}`);
    this.logger.log(`配置的回复模型: ${this.replyModel}`);
    this.logger.log(
      `配置的工具: ${this.configuredTools.length > 0 ? this.configuredTools.join(', ') : '无'}`,
    );
    this.logger.log(`自动刷新间隔: ${this.autoRefreshInterval / 1000 / 60} 分钟`);
  }

  /**
   * 模块初始化：加载模型和工具列表
   */
  async onModuleInit() {
    try {
      await this.refresh();
      this.startAutoRefresh();
    } catch (error) {
      this.logger.error('注册表初始化失败，将在后续请求时重试:', error);

      // 从 error 对象中提取 API Key（由 AgentApiClientService 附加）
      const apiKey = (error as any)?.apiKey;
      const maskedApiKey = maskApiKey(apiKey);

      // 发送飞书告警（异步，不阻塞服务启动）
      this.feishuAlertService
        .sendAlert({
          errorType: 'agent',
          error,
          apiEndpoint: '/agent/onModuleInit',
          scenario: 'REGISTRY_INIT_FAILED',
          // 添加 API Key 脱敏信息，便于排查 401 问题
          extra: maskedApiKey ? { apiKey: maskedApiKey } : undefined,
        })
        .catch((alertError) => {
          this.logger.error(`飞书告警发送失败: ${alertError.message}`);
        });

      // 不抛出错误，允许服务启动
    }
  }

  /**
   * 模块销毁：清理定时器
   */
  onModuleDestroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      this.logger.log('已清理自动刷新定时器');
    }
  }

  /**
   * 刷新注册表
   * 从 Agent API 获取最新的模型和工具列表
   */
  async refresh(): Promise<void> {
    try {
      this.logger.log('刷新 Agent 资源注册表...');

      // 并行获取模型和工具列表（直接调用 API 客户端）
      const [modelsResponse, toolsResponse] = await Promise.all([
        this.apiClient.getModels(),
        this.apiClient.getTools(),
      ]);

      // 【修复】更新模型列表 - apiClient 返回 response.data，需要访问 data.models
      const models = modelsResponse?.data?.models || [];
      this.availableModels = models.map((m: any) => m.id);

      // 【修复】更新工具列表 - apiClient 返回 response.data，需要访问 data.tools
      const tools = toolsResponse?.data?.tools || [];
      this.availableTools.clear();
      tools.forEach((tool: any) => {
        this.availableTools.set(tool.name, {
          requiresSandbox: tool.requiresSandbox,
          requiredContext: tool.requiredContext,
        });
      });

      // 更新刷新时间
      this.lastRefreshTime = new Date();

      this.logger.log(
        `注册表刷新完成: ${this.availableModels.length} 个模型, ${this.availableTools.size} 个工具`,
      );

      // 验证配置的模型和工具是否在可用列表中
      this.validateConfiguration();
    } catch (error) {
      this.logger.error('刷新注册表失败:', error);
      throw error;
    }
  }

  /**
   * 验证配置的模型和工具是否可用
   */
  private validateConfiguration(): void {
    // 验证模型
    if (this.availableModels.length > 0) {
      const modelsToValidate = [
        { name: '默认模型', value: this.configuredModel },
        { name: '聊天模型', value: this.chatModel },
        { name: '分类模型', value: this.classifyModel },
        { name: '回复模型', value: this.replyModel },
      ];

      let allModelsValid = true;
      for (const model of modelsToValidate) {
        if (!this.availableModels.includes(model.value)) {
          this.logger.warn(
            `⚠️  配置的${model.name} "${model.value}" 不在可用列表中！` +
              `\n   可用模型: ${this.availableModels.join(', ')}`,
          );
          allModelsValid = false;
        } else {
          this.logger.log(`✓ 配置的${model.name} "${model.value}" 验证通过`);
        }
      }

      if (allModelsValid) {
        this.logger.log(`✓ 所有配置的模型验证通过`);
      }
    }

    // 验证工具
    if (this.configuredTools.length > 0 && this.availableTools.size > 0) {
      const unavailableTools = this.configuredTools.filter(
        (tool) => !this.availableTools.has(tool),
      );

      if (unavailableTools.length > 0) {
        this.logger.warn(
          `⚠️  配置的工具中有 ${unavailableTools.length} 个不可用: ${unavailableTools.join(', ')}` +
            `\n   可用工具: ${Array.from(this.availableTools.keys()).join(', ')}`,
        );
      } else {
        this.logger.log(`✓ 配置的 ${this.configuredTools.length} 个工具验证通过`);
      }
    }
  }

  /**
   * 启动自动刷新定时器
   */
  private startAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      try {
        await this.refresh();
      } catch (error) {
        this.logger.error('自动刷新失败:', error);

        // 从 error 对象中提取 API Key（由 AgentApiClientService 附加）
        const apiKey = (error as any)?.apiKey;
        const maskedApiKey = maskApiKey(apiKey);

        // 发送飞书告警（异步，不阻塞定时任务）
        this.feishuAlertService
          .sendAlert({
            errorType: 'agent',
            error,
            apiEndpoint: '/agent/autoRefresh',
            scenario: 'REGISTRY_AUTO_REFRESH_FAILED',
            // 添加 API Key 脱敏信息，便于排查 401 问题
            extra: maskedApiKey ? { apiKey: maskedApiKey } : undefined,
          })
          .catch((alertError) => {
            this.logger.error(`飞书告警发送失败: ${alertError.message}`);
          });

        // 不抛出错误，继续运行
      }
    }, this.autoRefreshInterval);

    this.logger.log(`已启动自动刷新定时器，间隔: ${this.autoRefreshInterval / 1000 / 60} 分钟`);
  }

  /**
   * 验证模型是否可用，如果不可用则返回默认模型
   * @param requestedModel 请求的模型名称
   * @returns 有效的模型名称
   */
  validateModel(requestedModel?: string): string {
    // 如果没有提供模型，使用默认模型
    if (!requestedModel) {
      return this.configuredModel;
    }

    // 如果模型列表未初始化，使用配置的模型
    if (this.availableModels.length === 0) {
      this.logger.warn('模型列表未初始化，使用配置的默认模型');
      return this.configuredModel;
    }

    // 检查模型是否在可用列表中
    if (this.availableModels.includes(requestedModel)) {
      return requestedModel;
    }

    // 模型不可用，回退到默认模型
    this.logger.warn(
      `请求的模型 "${requestedModel}" 不在可用列表中，回退到默认模型 "${this.configuredModel}"`,
    );
    return this.configuredModel;
  }

  /**
   * 检查工具是否可用
   * @param toolName 工具名称
   * @returns 是否可用
   */
  isToolAvailable(toolName: string): boolean {
    return this.availableTools.has(toolName);
  }

  /**
   * 验证工具列表
   * 过滤掉不可用的工具，返回可用的工具列表
   * @param requestedTools 请求的工具列表
   * @returns 可用的工具列表
   */
  validateTools(requestedTools?: string[]): string[] {
    // 如果没有提供工具参数（undefined），使用配置的工具列表
    // 如果明确传递空数组 []，则返回空数组（禁用所有工具）
    if (requestedTools === undefined) {
      return [...this.configuredTools];
    }
    if (requestedTools.length === 0) {
      return [];
    }

    // 如果工具列表未初始化，返回请求的工具（不做验证）
    if (this.availableTools.size === 0) {
      this.logger.warn('工具列表未初始化，跳过工具验证');
      return [...requestedTools];
    }

    // 过滤可用的工具
    const availableTools: string[] = [];
    const unavailableTools: string[] = [];

    for (const tool of requestedTools) {
      if (this.availableTools.has(tool)) {
        availableTools.push(tool);
      } else {
        unavailableTools.push(tool);
      }
    }

    // 如果有不可用的工具，记录警告
    if (unavailableTools.length > 0) {
      this.logger.warn(
        `请求的工具中有 ${unavailableTools.length} 个不可用: ${unavailableTools.join(', ')}`,
      );
      this.logger.warn(`可用的工具: ${Array.from(this.availableTools.keys()).join(', ')}`);
    }

    return availableTools;
  }

  /**
   * 获取工具信息
   * @param toolName 工具名称
   * @returns 工具信息，如果不存在返回 undefined
   */
  getToolInfo(toolName: string): ToolInfo | undefined {
    return this.availableTools.get(toolName);
  }

  /**
   * 获取所有可用模型列表
   * @returns 模型ID数组
   */
  getAvailableModels(): string[] {
    return [...this.availableModels];
  }

  /**
   * 获取所有可用工具列表
   * @returns 工具信息Map的副本
   */
  getAvailableTools(): Map<string, ToolInfo> {
    return new Map(this.availableTools);
  }

  /**
   * 获取配置的默认模型
   */
  getConfiguredModel(): string {
    return this.configuredModel;
  }

  /**
   * 获取配置的工具列表
   */
  getConfiguredTools(): string[] {
    return [...this.configuredTools];
  }

  /**
   * 获取模型配置（用于传递给花卷 API 的 context.modelConfig）
   * 花卷 API 会根据这些配置在不同阶段使用不同模型：
   * - chatModel: 主对话模型
   * - classifyModel: 意图分类模型
   * - replyModel: 回复生成模型
   *
   * @see https://docs.wolian.cc/concepts/context#modelconfig
   */
  getModelConfig(): { chatModel: string; classifyModel: string; replyModel: string } {
    return {
      chatModel: this.chatModel,
      classifyModel: this.classifyModel,
      replyModel: this.replyModel,
    };
  }

  /**
   * 获取健康状态
   * 返回模型和工具的可用性信息
   */
  getHealthStatus() {
    const configuredModelAvailable = this.availableModels.includes(this.configuredModel);
    const chatModelAvailable = this.availableModels.includes(this.chatModel);
    const classifyModelAvailable = this.availableModels.includes(this.classifyModel);
    const replyModelAvailable = this.availableModels.includes(this.replyModel);

    const allConfiguredModelsAvailable =
      configuredModelAvailable &&
      chatModelAvailable &&
      classifyModelAvailable &&
      replyModelAvailable;

    const configuredToolsStatus = this.configuredTools.map((tool) => ({
      name: tool,
      available: this.availableTools.has(tool),
    }));

    const allToolsAvailable =
      configuredToolsStatus.length > 0 && configuredToolsStatus.every((tool) => tool.available);

    // 计算实际配置的模型数量（4个：默认、聊天、分类、回复）
    const configuredModelsList = [
      this.configuredModel,
      this.chatModel,
      this.classifyModel,
      this.replyModel,
    ];
    const uniqueConfiguredModels = [...new Set(configuredModelsList)]; // 去重
    const availableConfiguredModelsCount = uniqueConfiguredModels.filter((model) =>
      this.availableModels.includes(model),
    ).length;

    return {
      models: {
        available: this.availableModels,
        count: this.availableModels.length,
        configured: this.configuredModel,
        configuredAvailable: configuredModelAvailable,
        defaultAvailable: configuredModelAvailable, // 兼容旧 API
        // 前端监控仪表盘需要的字段
        availableCount: availableConfiguredModelsCount,
        configuredCount: uniqueConfiguredModels.length,
        // 新增：候选人咨询场景的模型配置状态
        scenarioModels: {
          chatModel: {
            configured: this.chatModel,
            available: chatModelAvailable,
          },
          classifyModel: {
            configured: this.classifyModel,
            available: classifyModelAvailable,
          },
          replyModel: {
            configured: this.replyModel,
            available: replyModelAvailable,
          },
        },
        allConfiguredModelsAvailable,
      },
      tools: {
        available: Array.from(this.availableTools.entries()).map(([name, info]) => ({
          name,
          requiresSandbox: info.requiresSandbox,
          requiredContext: info.requiredContext,
        })),
        count: this.availableTools.size,
        configured: this.configuredTools,
        configuredStatus: configuredToolsStatus,
        allAvailable: allToolsAvailable, // 配置的工具是否全部可用
        // 前端监控仪表盘需要的字段
        availableCount: configuredToolsStatus.filter((t) => t.available).length,
        configuredCount: this.configuredTools.length,
      },
      lastRefreshTime: this.lastRefreshTime?.toISOString() || null,
    };
  }

  /**
   * 检查注册表是否已初始化
   */
  isInitialized(): boolean {
    return this.availableModels.length > 0 || this.availableTools.size > 0;
  }
}
