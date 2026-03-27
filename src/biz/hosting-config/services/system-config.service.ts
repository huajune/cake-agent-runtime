import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigRepository } from '../repositories/system-config.repository';
import {
  SystemConfig,
  AgentReplyConfig,
  DEFAULT_AGENT_REPLY_CONFIG,
} from '../types/hosting-config.types';
import { GroupTaskConfig, DEFAULT_GROUP_TASK_CONFIG } from '@biz/group-task/group-task.types';

/**
 * 系统配置服务
 *
 * 封装所有系统配置的业务逻辑，包含：
 * - 两级缓存策略（内存 → 数据库）
 * - 配置变更观察者模式（回调通知）
 * - 缺失记录时的默认值自动初始化
 * - 通过 ConfigService 从环境变量读取默认值
 *
 * SystemConfigRepository 仅负责纯数据访问，本服务承担所有业务逻辑。
 */
@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  // Agent 回复策略配置内存缓存 TTL（秒）
  private readonly AGENT_CONFIG_CACHE_TTL = 60; // 1 分钟

  // 内存缓存
  private aiReplyEnabled: boolean | null = null;
  private messageMergeEnabled: boolean | null = null;
  private agentReplyConfig: AgentReplyConfig | null = null;
  private agentReplyConfigExpiry = 0;

  // 配置变更回调列表
  private readonly configChangeCallbacks: Array<(config: AgentReplyConfig) => void> = [];
  private readonly aiReplyChangeCallbacks: Array<(enabled: boolean) => void> = [];
  private readonly messageMergeChangeCallbacks: Array<(enabled: boolean) => void> = [];

  constructor(
    private readonly systemConfigRepository: SystemConfigRepository,
    private readonly configService: ConfigService,
  ) {}

  // ==================== AI 回复开关 ====================

  /**
   * 获取 AI 回复开关状态
   *
   * 优先级：内存缓存 → 数据库 → 环境变量默认值
   */
  async getAiReplyEnabled(): Promise<boolean> {
    if (this.aiReplyEnabled !== null) {
      return this.aiReplyEnabled;
    }

    return this.loadAiReplyStatus();
  }

  /**
   * 设置 AI 回复开关状态
   */
  async setAiReplyEnabled(enabled: boolean): Promise<boolean> {
    this.aiReplyEnabled = enabled;

    try {
      await this.systemConfigRepository.setConfigValue('ai_reply_enabled', enabled);
      this.logger.log(`AI 回复开关已更新为: ${enabled}`);
    } catch (error) {
      this.logger.error('更新 AI 回复状态到数据库失败', error);
    }

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
   * 优先级：内存缓存 → 数据库 → 环境变量默认值
   */
  async getMessageMergeEnabled(): Promise<boolean> {
    if (this.messageMergeEnabled !== null) {
      return this.messageMergeEnabled;
    }

    return this.loadMessageMergeStatus();
  }

  /**
   * 设置消息聚合开关状态
   */
  async setMessageMergeEnabled(enabled: boolean): Promise<boolean> {
    this.messageMergeEnabled = enabled;

    try {
      await this.systemConfigRepository.setConfigValue('message_merge_enabled', enabled);
      this.logger.log(`消息聚合开关已更新为: ${enabled}`);
    } catch (error) {
      this.logger.error('更新消息聚合状态到数据库失败', error);
    }

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
   * 内存缓存有效期内直接返回，否则重新从 DB 加载
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

      this.logger.log(`消息聚合开关状态已加载: ${this.messageMergeEnabled}`);
      return this.messageMergeEnabled;
    } catch (error) {
      this.logger.error('加载消息聚合开关状态失败，使用默认值', error);
      this.messageMergeEnabled = defaultValue;
      return defaultValue;
    }
  }

  /**
   * 从数据库加载 Agent 回复策略配置，缺失时写入默认值
   */
  private async loadAgentReplyConfig(): Promise<AgentReplyConfig> {
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
}
