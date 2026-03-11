/**
 * 系统配置键枚举
 */
export enum SystemConfigKey {
  AI_REPLY_ENABLED = 'ai_reply_enabled',
  MESSAGE_MERGE_ENABLED = 'message_merge_enabled',
  GROUP_BLACKLIST = 'group_blacklist',
  AGENT_REPLY_CONFIG = 'agent_reply_config',
  SYSTEM_CONFIG = 'system_config',
}

/**
 * 系统配置接口
 */
export interface SystemConfig {
  workerConcurrency?: number; // Worker 并发数 (1-20)
}

/**
 * Agent 回复策略配置
 */
export interface AgentReplyConfig {
  // 消息聚合配置
  initialMergeWindowMs: number; // 首次聚合等待时间（毫秒）
  maxMergedMessages: number; // 最多聚合消息数

  // 打字延迟配置
  typingDelayPerCharMs: number; // 每字符延迟（毫秒）- 已废弃，使用 typingSpeedCharsPerSec
  typingSpeedCharsPerSec: number; // 打字速度（字符/秒）
  paragraphGapMs: number; // 段落间隔（毫秒）

  // 告警节流配置
  alertThrottleWindowMs: number; // 告警节流窗口（毫秒）
  alertThrottleMaxCount: number; // 窗口内最大告警次数

  // 业务指标告警开关
  businessAlertEnabled: boolean; // 是否启用业务指标告警
  minSamplesForAlert: number; // 最小样本量（低于此值不检查）
  alertIntervalMinutes: number; // 同类告警最小间隔（分钟）

  // 告警阈值配置
  successRateCritical: number; // 成功率严重阈值（百分比，低于此值触发严重告警）
  avgDurationCritical: number; // 响应时间严重阈值（毫秒，高于此值触发严重告警）
  queueDepthCritical: number; // 队列深度严重阈值（条数，高于此值触发严重告警）
  errorRateCritical: number; // 错误率严重阈值（每小时次数，高于此值触发严重告警）
}

/**
 * Agent 回复策略配置默认值
 */
export const DEFAULT_AGENT_REPLY_CONFIG: AgentReplyConfig = {
  initialMergeWindowMs: 3000, // 默认 3000ms
  maxMergedMessages: 3, // 默认 3 条
  typingDelayPerCharMs: 125, // 兼容旧字段 (1000/8)
  typingSpeedCharsPerSec: 8, // 默认 8 字符/秒
  paragraphGapMs: 2000,
  alertThrottleWindowMs: 5 * 60 * 1000, // 5 分钟
  alertThrottleMaxCount: 3,
  businessAlertEnabled: true, // 默认启用
  minSamplesForAlert: 10, // 至少 10 条消息才检查
  alertIntervalMinutes: 30, // 同类告警间隔 30 分钟
  // 告警阈值默认值
  successRateCritical: 80, // 成功率低于 80% 触发告警
  avgDurationCritical: 60000, // 响应时间高于 60 秒触发告警
  queueDepthCritical: 20, // 队列深度高于 20 条触发告警
  errorRateCritical: 10, // 每小时错误超过 10 次触发告警
};
