export type AgentReplyThinkingMode = 'fast' | 'deep';

export interface BlacklistItem {
  groupId: string;
  reason?: string;
  addedAt: string;
}

export interface BlacklistData {
  chatIds: string[];
  groupIds: string[];
}

export interface AgentReplyConfig {
  // 模型配置
  wecomCallbackModelId: string;
  wecomCallbackThinkingMode: AgentReplyThinkingMode;
  extractModelId: string;

  // 消息聚合配置
  initialMergeWindowMs: number;

  // 打字延迟配置
  typingDelayPerCharMs: number;
  typingSpeedCharsPerSec: number;
  paragraphGapMs: number;

  // 告警节流配置
  alertThrottleWindowMs: number;
  alertThrottleMaxCount: number;

  // 业务指标告警配置
  businessAlertEnabled: boolean;
  minSamplesForAlert: number;
  alertIntervalMinutes: number;

  // 告警阈值配置
  successRateCritical: number;
  avgDurationCritical: number;
  queueDepthCritical: number;
  errorRateCritical: number;

  // 出站守卫 llm 档（语义审查）灰度开关
  outputGuardrailLlmEnabled: boolean;
  outputGuardrailSemanticShadowEnabled: boolean;

  // 主动复聊（reengagement）开关
  reengagementEnabled: boolean;
  reengagementShadow: boolean;
}

export interface GroupTaskConfig {
  enabled: boolean;
  dryRun: boolean;
}

export interface AgentReplyConfigResponse {
  config: AgentReplyConfig;
  defaults: AgentReplyConfig;
  groupTaskConfig: GroupTaskConfig;
}
