import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@core/redis';
import { SystemConfigRepository } from '../repositories/system-config.repository';
import {
  SystemConfig,
  AgentReplyConfig,
  DEFAULT_AGENT_REPLY_CONFIG,
} from '../types/hosting-config.types';
import { HOSTING_CONFIG_REDIS_KEYS } from '../utils/hosting-config-redis-keys';

/**
 * 系统配置服务
 *
 * 封装所有系统配置的业务逻辑，包含：
 * - 三级缓存策略（内存 → Redis → 数据库）
 * - 配置变更观察者模式（回调通知）
 * - 缺失记录时的默认值自动初始化
 * - 通过 ConfigService 从环境变量读取默认值
 *
 * SystemConfigRepository 仅负责纯数据访问，本服务承担所有业务逻辑。
 */
@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  // 缓存 TTL（秒）
  private readonly CONFIG_CACHE_TTL = 300; // 5 分钟
  private readonly AGENT_CONFIG_CACHE_TTL = 60; // 1 分钟

  // 内存缓存
  private aiReplyEnabled: boolean | null = null;
  private messageMergeEnabled: boolean | null = null;
  private agentReplyConfig: AgentReplyConfig | null = null;
  private agentReplyConfigExpiry = 0;

  // 配置变更回调列表
  private readonly configChangeCallbacks: Array<(config: AgentReplyConfig) => void> = [];

  constructor(
    private readonly systemConfigRepository: SystemConfigRepository,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  // ==================== AI 回复开关 ====================

  /**
   * 获取 AI 回复开关状态
   *
   * 优先级：内存缓存 → Redis 缓存 → 数据库 → 环境变量默认值
   */
  async getAiReplyEnabled(): Promise<boolean> {
    if (this.aiReplyEnabled !== null) {
      return this.aiReplyEnabled;
    }

    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.AI_REPLY_ENABLED;
    const cached = await this.redisService.get<boolean>(cacheKey);
    if (cached !== null) {
      this.aiReplyEnabled = cached;
      return cached;
    }

    return this.loadAiReplyStatus();
  }

  /**
   * 设置 AI 回复开关状态
   */
  async setAiReplyEnabled(enabled: boolean): Promise<boolean> {
    this.aiReplyEnabled = enabled;

    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.AI_REPLY_ENABLED;
    await this.redisService.setex(cacheKey, this.CONFIG_CACHE_TTL, enabled);

    try {
      await this.systemConfigRepository.setConfigValue('ai_reply_enabled', enabled);
      this.logger.log(`AI 回复开关已更新为: ${enabled}`);
    } catch (error) {
      this.logger.error('更新 AI 回复状态到数据库失败', error);
    }

    return enabled;
  }

  // ==================== 消息聚合开关 ====================

  /**
   * 获取消息聚合开关状态
   *
   * 优先级：内存缓存 → Redis 缓存 → 数据库 → 环境变量默认值
   */
  async getMessageMergeEnabled(): Promise<boolean> {
    if (this.messageMergeEnabled !== null) {
      return this.messageMergeEnabled;
    }

    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.MESSAGE_MERGE_ENABLED;
    const cached = await this.redisService.get<boolean>(cacheKey);
    if (cached !== null) {
      this.messageMergeEnabled = cached;
      return cached;
    }

    return this.loadMessageMergeStatus();
  }

  /**
   * 设置消息聚合开关状态
   */
  async setMessageMergeEnabled(enabled: boolean): Promise<boolean> {
    this.messageMergeEnabled = enabled;

    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.MESSAGE_MERGE_ENABLED;
    await this.redisService.setex(cacheKey, this.CONFIG_CACHE_TTL, enabled);

    try {
      await this.systemConfigRepository.setConfigValue('message_merge_enabled', enabled);
      this.logger.log(`消息聚合开关已更新为: ${enabled}`);
    } catch (error) {
      this.logger.error('更新消息聚合状态到数据库失败', error);
    }

    return enabled;
  }

  // ==================== Agent 回复策略配置 ====================

  /**
   * 获取 Agent 回复策略配置
   *
   * 内存缓存有效期内直接返回，否则重新加载
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
    const newConfig: AgentReplyConfig = {
      ...(this.agentReplyConfig || DEFAULT_AGENT_REPLY_CONFIG),
      ...config,
    };

    this.agentReplyConfig = newConfig;
    this.agentReplyConfigExpiry = Date.now() + this.AGENT_CONFIG_CACHE_TTL * 1000;

    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.AGENT_REPLY_CONFIG;
    await this.redisService.setex(cacheKey, this.AGENT_CONFIG_CACHE_TTL, newConfig);

    try {
      await this.systemConfigRepository.setConfigValue(
        'agent_reply_config',
        newConfig,
        'Agent 回复策略配置（消息聚合、打字延迟、告警节流）',
      );
      this.logger.log('Agent 回复策略配置已更新');
    } catch (error) {
      this.logger.error('更新 Agent 回复策略配置到数据库失败', error);
    }

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
   * 优先级：Redis 缓存 → 数据库
   */
  async getSystemConfig(): Promise<SystemConfig | null> {
    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.SYSTEM_CONFIG;
    const cached = await this.redisService.get<SystemConfig>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const result =
        await this.systemConfigRepository.getConfigValue<SystemConfig>('system_config');
      if (result) {
        await this.redisService.setex(cacheKey, this.CONFIG_CACHE_TTL, result);
        return result;
      }

      return null;
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

    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.SYSTEM_CONFIG;
    await this.redisService.setex(cacheKey, this.CONFIG_CACHE_TTL, newConfig);

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
   * 清除内存缓存后重新从 Redis/数据库加载
   */
  async refreshCache(): Promise<void> {
    this.aiReplyEnabled = null;
    this.messageMergeEnabled = null;
    this.agentReplyConfigExpiry = 0;

    await this.loadAiReplyStatus();
    await this.loadMessageMergeStatus();
    await this.loadAgentReplyConfig();

    this.logger.log('系统配置缓存已刷新');
  }

  // ==================== 私有加载方法 ====================

  /**
   * 从数据库加载 AI 回复开关状态，缺失时写入默认值
   */
  private async loadAiReplyStatus(): Promise<boolean> {
    const defaultValue = this.configService.get<string>('ENABLE_AI_REPLY', 'true') === 'true';

    try {
      const result = await this.systemConfigRepository.getConfigValue<unknown>('ai_reply_enabled');

      if (result !== null) {
        this.aiReplyEnabled = result === true || result === 'true';
      } else {
        this.aiReplyEnabled = defaultValue;
        await this.systemConfigRepository.setConfigValue(
          'ai_reply_enabled',
          defaultValue,
          'AI 自动回复功能开关',
        );
      }

      const cacheKey = HOSTING_CONFIG_REDIS_KEYS.AI_REPLY_ENABLED;
      await this.redisService.setex(cacheKey, this.CONFIG_CACHE_TTL, this.aiReplyEnabled);

      this.logger.log(`AI 回复开关状态已加载: ${this.aiReplyEnabled}`);
      return this.aiReplyEnabled;
    } catch (error) {
      this.logger.error('加载 AI 回复状态失败，使用默认值', error);
      this.aiReplyEnabled = defaultValue;
      return defaultValue;
    }
  }

  /**
   * 从数据库加载消息聚合开关状态，缺失时写入默认值
   */
  private async loadMessageMergeStatus(): Promise<boolean> {
    const defaultValue = this.configService.get<string>('ENABLE_MESSAGE_MERGE', 'true') === 'true';

    try {
      const result =
        await this.systemConfigRepository.getConfigValue<unknown>('message_merge_enabled');

      if (result !== null) {
        this.messageMergeEnabled = result === true || result === 'true';
      } else {
        this.messageMergeEnabled = defaultValue;
        await this.systemConfigRepository.setConfigValue(
          'message_merge_enabled',
          defaultValue,
          '消息聚合功能开关（多条消息合并发送给 AI）',
        );
      }

      const cacheKey = HOSTING_CONFIG_REDIS_KEYS.MESSAGE_MERGE_ENABLED;
      await this.redisService.setex(cacheKey, this.CONFIG_CACHE_TTL, this.messageMergeEnabled);

      this.logger.log(`消息聚合开关状态已加载: ${this.messageMergeEnabled}`);
      return this.messageMergeEnabled;
    } catch (error) {
      this.logger.error('加载消息聚合开关状态失败，使用默认值', error);
      this.messageMergeEnabled = defaultValue;
      return defaultValue;
    }
  }

  /**
   * 从 Redis/数据库加载 Agent 回复策略配置，缺失时写入默认值
   */
  private async loadAgentReplyConfig(): Promise<AgentReplyConfig> {
    const cacheKey = HOSTING_CONFIG_REDIS_KEYS.AGENT_REPLY_CONFIG;
    const cached = await this.redisService.get<AgentReplyConfig>(cacheKey);

    if (cached) {
      this.agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, ...cached };
      this.agentReplyConfigExpiry = Date.now() + this.AGENT_CONFIG_CACHE_TTL * 1000;
      this.logger.debug('已从 Redis 加载 Agent 回复策略配置');
      return this.agentReplyConfig;
    }

    try {
      const result =
        await this.systemConfigRepository.getConfigValue<Partial<AgentReplyConfig>>(
          'agent_reply_config',
        );

      if (result !== null) {
        this.agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, ...result };
      } else {
        this.agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
        await this.systemConfigRepository.setConfigValue(
          'agent_reply_config',
          DEFAULT_AGENT_REPLY_CONFIG,
          'Agent 回复策略配置（消息聚合、打字延迟、告警节流）',
        );
      }

      await this.redisService.setex(cacheKey, this.AGENT_CONFIG_CACHE_TTL, this.agentReplyConfig);
      this.agentReplyConfigExpiry = Date.now() + this.AGENT_CONFIG_CACHE_TTL * 1000;
      this.logger.log('Agent 回复策略配置已加载');
      return this.agentReplyConfig;
    } catch (error) {
      this.logger.error('加载 Agent 回复策略配置失败，使用默认值', error);
      this.agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
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
}
