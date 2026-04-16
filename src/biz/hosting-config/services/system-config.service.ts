import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { SystemConfigRepository } from '../repositories/system-config.repository';
import {
  SystemConfig,
  AgentReplyConfig,
  DEFAULT_AGENT_REPLY_CONFIG,
} from '../types/hosting-config.types';
import { GroupTaskConfig, DEFAULT_GROUP_TASK_CONFIG } from '@biz/group-task/group-task.types';

interface SharedBooleanCache {
  value: unknown;
  updatedAt: number;
}

interface SharedAgentReplyConfigCache {
  value: AgentReplyConfig;
  updatedAt: number;
}

/**
 * 系统配置服务
 *
 * 封装所有系统配置的业务逻辑，包含：
 * - 共享缓存策略（本地热缓存 → Redis → 数据库）
 * - 配置变更观察者模式（回调通知）
 * - 缺失记录时的默认值自动初始化
 * - 通过 ConfigService 从环境变量读取默认值
 *
 * SystemConfigRepository 仅负责纯数据访问，本服务承担所有业务逻辑。
 */
@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  private static readonly AI_REPLY_CACHE_KEY = 'hosting:config:ai-reply-enabled:v1';
  private static readonly MESSAGE_MERGE_CACHE_KEY = 'hosting:config:message-merge-enabled:v1';
  private static readonly AGENT_REPLY_CONFIG_CACHE_KEY = 'hosting:config:agent-reply-config:v1';

  // 本地热缓存 TTL（毫秒）
  private readonly FLAG_CACHE_TTL_MS = 1_000;
  private readonly AGENT_CONFIG_CACHE_TTL_MS = 1_000;

  // 内存缓存
  private aiReplyEnabled: boolean | null = null;
  private aiReplyEnabledExpiry = 0;
  private messageMergeEnabled: boolean | null = null;
  private messageMergeEnabledExpiry = 0;
  private agentReplyConfig: AgentReplyConfig | null = null;
  private agentReplyConfigExpiry = 0;

  // 配置变更回调列表
  private readonly configChangeCallbacks: Array<(config: AgentReplyConfig) => void> = [];
  private readonly aiReplyChangeCallbacks: Array<(enabled: boolean) => void> = [];
  private readonly messageMergeChangeCallbacks: Array<(enabled: boolean) => void> = [];

  constructor(
    private readonly systemConfigRepository: SystemConfigRepository,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  private normalizeAgentReplyConfig(
    config: Partial<AgentReplyConfig> | null | undefined,
  ): AgentReplyConfig {
    return {
      wecomCallbackModelId:
        typeof config?.wecomCallbackModelId === 'string'
          ? config.wecomCallbackModelId.trim()
          : DEFAULT_AGENT_REPLY_CONFIG.wecomCallbackModelId,
      initialMergeWindowMs:
        typeof config?.initialMergeWindowMs === 'number'
          ? config.initialMergeWindowMs
          : DEFAULT_AGENT_REPLY_CONFIG.initialMergeWindowMs,
      typingDelayPerCharMs:
        typeof config?.typingDelayPerCharMs === 'number'
          ? config.typingDelayPerCharMs
          : DEFAULT_AGENT_REPLY_CONFIG.typingDelayPerCharMs,
      typingSpeedCharsPerSec:
        typeof config?.typingSpeedCharsPerSec === 'number'
          ? config.typingSpeedCharsPerSec
          : DEFAULT_AGENT_REPLY_CONFIG.typingSpeedCharsPerSec,
      paragraphGapMs:
        typeof config?.paragraphGapMs === 'number'
          ? config.paragraphGapMs
          : DEFAULT_AGENT_REPLY_CONFIG.paragraphGapMs,
      alertThrottleWindowMs:
        typeof config?.alertThrottleWindowMs === 'number'
          ? config.alertThrottleWindowMs
          : DEFAULT_AGENT_REPLY_CONFIG.alertThrottleWindowMs,
      alertThrottleMaxCount:
        typeof config?.alertThrottleMaxCount === 'number'
          ? config.alertThrottleMaxCount
          : DEFAULT_AGENT_REPLY_CONFIG.alertThrottleMaxCount,
      businessAlertEnabled:
        typeof config?.businessAlertEnabled === 'boolean'
          ? config.businessAlertEnabled
          : DEFAULT_AGENT_REPLY_CONFIG.businessAlertEnabled,
      minSamplesForAlert:
        typeof config?.minSamplesForAlert === 'number'
          ? config.minSamplesForAlert
          : DEFAULT_AGENT_REPLY_CONFIG.minSamplesForAlert,
      alertIntervalMinutes:
        typeof config?.alertIntervalMinutes === 'number'
          ? config.alertIntervalMinutes
          : DEFAULT_AGENT_REPLY_CONFIG.alertIntervalMinutes,
      successRateCritical:
        typeof config?.successRateCritical === 'number'
          ? config.successRateCritical
          : DEFAULT_AGENT_REPLY_CONFIG.successRateCritical,
      avgDurationCritical:
        typeof config?.avgDurationCritical === 'number'
          ? config.avgDurationCritical
          : DEFAULT_AGENT_REPLY_CONFIG.avgDurationCritical,
      queueDepthCritical:
        typeof config?.queueDepthCritical === 'number'
          ? config.queueDepthCritical
          : DEFAULT_AGENT_REPLY_CONFIG.queueDepthCritical,
      errorRateCritical:
        typeof config?.errorRateCritical === 'number'
          ? config.errorRateCritical
          : DEFAULT_AGENT_REPLY_CONFIG.errorRateCritical,
    };
  }

  // ==================== AI 回复开关 ====================

  /**
   * 获取 AI 回复开关状态
   *
   * 优先级：本地热缓存 → Redis 共享缓存 → 数据库 → 环境变量默认值
   */
  async getAiReplyEnabled(): Promise<boolean> {
    if (this.aiReplyEnabled !== null && Date.now() < this.aiReplyEnabledExpiry) {
      return this.aiReplyEnabled;
    }

    return this.loadAiReplyStatus();
  }

  /**
   * 设置 AI 回复开关状态
   */
  async setAiReplyEnabled(enabled: boolean): Promise<boolean> {
    this.setAiReplyEnabledCache(enabled);

    try {
      await this.systemConfigRepository.setConfigValue('ai_reply_enabled', enabled);
      this.logger.log(`AI 回复开关已更新为: ${enabled}`);
    } catch (error) {
      this.logger.error('更新 AI 回复状态到数据库失败', error);
    }

    await this.persistSharedBooleanCache(SystemConfigService.AI_REPLY_CACHE_KEY, enabled);

    for (const cb of this.aiReplyChangeCallbacks) {
      try {
        cb(enabled);
      } catch {
        /* ignore */
      }
    }

    return enabled;
  }

  /**
   * 注册 AI 回复开关变更回调
   */
  onAiReplyChange(callback: (enabled: boolean) => void): void {
    this.aiReplyChangeCallbacks.push(callback);
  }

  // ==================== 消息聚合开关 ====================

  /**
   * 获取消息聚合开关状态
   *
   * 优先级：本地热缓存 → Redis 共享缓存 → 数据库 → 环境变量默认值
   */
  async getMessageMergeEnabled(): Promise<boolean> {
    if (this.messageMergeEnabled !== null && Date.now() < this.messageMergeEnabledExpiry) {
      return this.messageMergeEnabled;
    }

    return this.loadMessageMergeStatus();
  }

  /**
   * 设置消息聚合开关状态
   */
  async setMessageMergeEnabled(enabled: boolean): Promise<boolean> {
    this.setMessageMergeEnabledCache(enabled);

    try {
      await this.systemConfigRepository.setConfigValue('message_merge_enabled', enabled);
      this.logger.log(`消息聚合开关已更新为: ${enabled}`);
    } catch (error) {
      this.logger.error('更新消息聚合状态到数据库失败', error);
    }

    await this.persistSharedBooleanCache(SystemConfigService.MESSAGE_MERGE_CACHE_KEY, enabled);

    for (const cb of this.messageMergeChangeCallbacks) {
      try {
        cb(enabled);
      } catch {
        /* ignore */
      }
    }

    return enabled;
  }

  /**
   * 注册消息聚合开关变更回调
   */
  onMessageMergeChange(callback: (enabled: boolean) => void): void {
    this.messageMergeChangeCallbacks.push(callback);
  }

  // ==================== Agent 回复策略配置 ====================

  /**
   * 获取 Agent 回复策略配置
   *
   * 本地热缓存有效期内直接返回，否则按 Redis → DB 顺序回源
   */
  async getAgentReplyConfig(): Promise<AgentReplyConfig> {
    if (this.agentReplyConfig && Date.now() < this.agentReplyConfigExpiry) {
      return this.agentReplyConfig;
    }

    return this.loadAgentReplyConfig();
  }

  /**
   * 更新 Agent 回复策略配置
   */
  async setAgentReplyConfig(config: Partial<AgentReplyConfig>): Promise<AgentReplyConfig> {
    const newConfig = this.normalizeAgentReplyConfig({
      ...(this.agentReplyConfig || DEFAULT_AGENT_REPLY_CONFIG),
      ...config,
    });

    this.setAgentReplyConfigCache(newConfig);

    try {
      await this.systemConfigRepository.setConfigValue(
        'agent_reply_config',
        newConfig,
        'Agent 运行时配置（模型、消息聚合、打字延迟、告警节流）',
      );
      this.logger.log('Agent 回复策略配置已更新');
    } catch (error) {
      this.logger.error('更新 Agent 回复策略配置到数据库失败', error);
    }

    await this.persistSharedAgentReplyConfigCache(newConfig);

    this.notifyConfigChange(newConfig);

    return newConfig;
  }

  /**
   * 注册 Agent 回复策略配置变更回调
   */
  onAgentReplyConfigChange(callback: (config: AgentReplyConfig) => void): void {
    this.configChangeCallbacks.push(callback);
  }

  // ==================== 系统配置 ====================

  /**
   * 获取系统配置（Worker 并发数等）
   *
   * 直接从数据库读取（低频调用，无需缓存）
   */
  async getSystemConfig(): Promise<SystemConfig | null> {
    try {
      return await this.systemConfigRepository.getConfigValue<SystemConfig>('system_config');
    } catch (error) {
      this.logger.error('获取系统配置失败', error);
      return null;
    }
  }

  /**
   * 更新系统配置
   */
  async updateSystemConfig(config: Partial<SystemConfig>): Promise<SystemConfig> {
    const existingConfig = (await this.getSystemConfig()) ?? {};
    const newConfig: SystemConfig = { ...existingConfig, ...config };

    try {
      await this.systemConfigRepository.setConfigValue(
        'system_config',
        newConfig,
        '系统配置（Worker 并发数等）',
      );
      this.logger.log(`系统配置已更新: ${JSON.stringify(config)}`);
    } catch (error) {
      this.logger.error('更新系统配置到数据库失败', error);
    }

    return newConfig;
  }

  // ==================== 缓存管理 ====================

  /**
   * 刷新所有配置缓存
   *
   * 清除内存缓存后重新从数据库加载
   */
  async refreshCache(): Promise<void> {
    this.aiReplyEnabled = null;
    this.aiReplyEnabledExpiry = 0;
    this.messageMergeEnabled = null;
    this.messageMergeEnabledExpiry = 0;
    this.agentReplyConfig = null;
    this.agentReplyConfigExpiry = 0;

    await this.loadAiReplyStatus({ bypassSharedCache: true });
    await this.loadMessageMergeStatus({ bypassSharedCache: true });
    await this.loadAgentReplyConfig({ bypassSharedCache: true });

    this.logger.log('系统配置缓存已刷新');
  }

  // ==================== 私有加载方法 ====================

  /**
   * 从数据库加载 AI 回复开关状态，缺失时写入默认值
   */
  private async loadAiReplyStatus(options?: { bypassSharedCache?: boolean }): Promise<boolean> {
    const defaultValue = this.configService.get<string>('ENABLE_AI_REPLY', 'true') === 'true';

    try {
      if (!options?.bypassSharedCache) {
        const sharedValue = await this.readSharedBooleanCache(
          SystemConfigService.AI_REPLY_CACHE_KEY,
        );
        if (sharedValue !== null) {
          this.setAiReplyEnabledCache(sharedValue);
          return sharedValue;
        }
      }

      const result = await this.systemConfigRepository.getConfigValue<unknown>('ai_reply_enabled');

      if (result !== null) {
        this.setAiReplyEnabledCache(result === true || result === 'true');
      } else {
        this.setAiReplyEnabledCache(defaultValue);
        await this.systemConfigRepository.setConfigValue(
          'ai_reply_enabled',
          defaultValue,
          'AI 自动回复功能开关',
        );
      }

      await this.persistSharedBooleanCache(
        SystemConfigService.AI_REPLY_CACHE_KEY,
        this.aiReplyEnabled ?? defaultValue,
      );
      this.logger.log(`AI 回复开关状态已加载: ${this.aiReplyEnabled}`);
      return this.aiReplyEnabled ?? defaultValue;
    } catch (error) {
      this.logger.error('加载 AI 回复状态失败，使用默认值', error);
      this.setAiReplyEnabledCache(defaultValue);
      return defaultValue;
    }
  }

  /**
   * 从数据库加载消息聚合开关状态，缺失时写入默认值
   */
  private async loadMessageMergeStatus(options?: { bypassSharedCache?: boolean }): Promise<boolean> {
    const defaultValue = this.configService.get<string>('ENABLE_MESSAGE_MERGE', 'true') === 'true';

    try {
      if (!options?.bypassSharedCache) {
        const sharedValue = await this.readSharedBooleanCache(
          SystemConfigService.MESSAGE_MERGE_CACHE_KEY,
        );
        if (sharedValue !== null) {
          this.setMessageMergeEnabledCache(sharedValue);
          return sharedValue;
        }
      }

      const result =
        await this.systemConfigRepository.getConfigValue<unknown>('message_merge_enabled');

      if (result !== null) {
        this.setMessageMergeEnabledCache(result === true || result === 'true');
      } else {
        this.setMessageMergeEnabledCache(defaultValue);
        await this.systemConfigRepository.setConfigValue(
          'message_merge_enabled',
          defaultValue,
          '消息聚合功能开关（多条消息合并发送给 AI）',
        );
      }

      await this.persistSharedBooleanCache(
        SystemConfigService.MESSAGE_MERGE_CACHE_KEY,
        this.messageMergeEnabled ?? defaultValue,
      );
      this.logger.log(`消息聚合开关状态已加载: ${this.messageMergeEnabled}`);
      return this.messageMergeEnabled ?? defaultValue;
    } catch (error) {
      this.logger.error('加载消息聚合开关状态失败，使用默认值', error);
      this.setMessageMergeEnabledCache(defaultValue);
      return defaultValue;
    }
  }

  /**
   * 从数据库加载 Agent 回复策略配置，缺失时写入默认值
   */
  private async loadAgentReplyConfig(options?: { bypassSharedCache?: boolean }): Promise<AgentReplyConfig> {
    try {
      if (!options?.bypassSharedCache) {
        const sharedValue = await this.readSharedAgentReplyConfigCache();
        if (sharedValue) {
          this.setAgentReplyConfigCache(sharedValue);
          return sharedValue;
        }
      }

      const result =
        await this.systemConfigRepository.getConfigValue<Partial<AgentReplyConfig>>(
          'agent_reply_config',
        );

      if (result !== null) {
        this.setAgentReplyConfigCache(this.normalizeAgentReplyConfig(result));
      } else {
        this.setAgentReplyConfigCache(
          this.normalizeAgentReplyConfig(DEFAULT_AGENT_REPLY_CONFIG),
        );
        await this.systemConfigRepository.setConfigValue(
          'agent_reply_config',
          DEFAULT_AGENT_REPLY_CONFIG,
          'Agent 运行时配置（模型、消息聚合、打字延迟、告警节流）',
        );
      }

      await this.persistSharedAgentReplyConfigCache(
        this.agentReplyConfig ?? this.normalizeAgentReplyConfig(DEFAULT_AGENT_REPLY_CONFIG),
      );
      this.logger.log('Agent 回复策略配置已加载');
      return this.agentReplyConfig ?? this.normalizeAgentReplyConfig(DEFAULT_AGENT_REPLY_CONFIG);
    } catch (error) {
      this.logger.error('加载 Agent 回复策略配置失败，使用默认值', error);
      this.agentReplyConfig = this.normalizeAgentReplyConfig(DEFAULT_AGENT_REPLY_CONFIG);
      this.agentReplyConfigExpiry = Date.now() + 30000; // 30 秒后重试
      return this.agentReplyConfig;
    }
  }

  /**
   * 通知所有订阅者 Agent 回复策略配置已变更
   */
  private notifyConfigChange(config: AgentReplyConfig): void {
    for (const callback of this.configChangeCallbacks) {
      try {
        callback(config);
      } catch (error) {
        this.logger.error('配置变更回调执行失败', error);
      }
    }
  }

  // ==================== 群任务配置 ====================

  private static readonly GROUP_TASK_CONFIG_KEY = 'group_task_config';

  /**
   * 读取群任务配置
   */
  async getGroupTaskConfig(): Promise<GroupTaskConfig> {
    const stored = await this.systemConfigRepository.getConfigValue<GroupTaskConfig>(
      SystemConfigService.GROUP_TASK_CONFIG_KEY,
    );
    return {
      enabled: stored?.enabled ?? DEFAULT_GROUP_TASK_CONFIG.enabled,
      dryRun: stored?.dryRun ?? DEFAULT_GROUP_TASK_CONFIG.dryRun,
    };
  }

  /**
   * 更新群任务配置（read-merge-write）
   */
  async updateGroupTaskConfig(partial: Partial<GroupTaskConfig>): Promise<GroupTaskConfig> {
    const current = await this.getGroupTaskConfig();
    const updated = { ...current, ...partial };
    this.logger.log(`更新群任务配置: ${JSON.stringify(updated)}`);
    await this.systemConfigRepository.setConfigValue(
      SystemConfigService.GROUP_TASK_CONFIG_KEY,
      updated,
      '群任务通知配置',
    );
    return updated;
  }

  // ==================== 通用配置项（供其他模块使用）====================

  /**
   * 读取指定键的配置值
   */
  async getConfigValue<T>(key: string): Promise<T | null> {
    return this.systemConfigRepository.getConfigValue<T>(key);
  }

  /**
   * 写入指定键的配置值
   */
  async setConfigValue(key: string, value: unknown, description?: string): Promise<void> {
    await this.systemConfigRepository.setConfigValue(key, value, description);
  }

  private setAiReplyEnabledCache(enabled: boolean): void {
    this.aiReplyEnabled = enabled;
    this.aiReplyEnabledExpiry = Date.now() + this.FLAG_CACHE_TTL_MS;
  }

  private setMessageMergeEnabledCache(enabled: boolean): void {
    this.messageMergeEnabled = enabled;
    this.messageMergeEnabledExpiry = Date.now() + this.FLAG_CACHE_TTL_MS;
  }

  private setAgentReplyConfigCache(config: AgentReplyConfig): void {
    this.agentReplyConfig = config;
    this.agentReplyConfigExpiry = Date.now() + this.AGENT_CONFIG_CACHE_TTL_MS;
  }

  private async readSharedBooleanCache(key: string): Promise<boolean | null> {
    try {
      const cached = await this.redisService.get<
        SharedBooleanCache | boolean | string | number | null
      >(key);
      if (cached === null || cached === undefined) {
        return null;
      }

      if (typeof cached === 'object' && 'value' in cached) {
        const rawValue = cached.value as unknown;
        return rawValue === true || rawValue === 'true' || rawValue === 1;
      }

      return cached === true || cached === 'true' || cached === 1;
    } catch (error) {
      this.logger.warn(`读取 Redis 开关缓存失败 [${key}]`, error);
      return null;
    }
  }

  private async persistSharedBooleanCache(key: string, value: boolean): Promise<void> {
    try {
      await this.redisService.set(key, {
        value,
        updatedAt: Date.now(),
      } satisfies SharedBooleanCache);
    } catch (error) {
      this.logger.warn(`写入 Redis 开关缓存失败 [${key}]`, error);
    }
  }

  private async readSharedAgentReplyConfigCache(): Promise<AgentReplyConfig | null> {
    try {
      const cached = await this.redisService.get<
        SharedAgentReplyConfigCache | Partial<AgentReplyConfig> | null
      >(SystemConfigService.AGENT_REPLY_CONFIG_CACHE_KEY);
      if (!cached) {
        return null;
      }

      if (typeof cached === 'object' && 'value' in cached) {
        return this.normalizeAgentReplyConfig(cached.value);
      }

      return this.normalizeAgentReplyConfig(cached);
    } catch (error) {
      this.logger.warn('读取 Redis Agent 配置缓存失败', error);
      return null;
    }
  }

  private async persistSharedAgentReplyConfigCache(config: AgentReplyConfig): Promise<void> {
    try {
      await this.redisService.set(SystemConfigService.AGENT_REPLY_CONFIG_CACHE_KEY, {
        value: config,
        updatedAt: Date.now(),
      } satisfies SharedAgentReplyConfigCache);
    } catch (error) {
      this.logger.warn('写入 Redis Agent 配置缓存失败', error);
    }
  }
}
