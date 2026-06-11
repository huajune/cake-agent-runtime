export type AgentReplyThinkingMode = 'fast' | 'deep';

export interface BlacklistItem {
  groupId: string;
  reason?: string;
  addedAt: string;
}

/**
 * 候选人黑名单记录（对应后端 candidate_blacklist 表，字段为 snake_case）
 */
export interface CandidateBlacklistItem {
  id: string;
  /** 候选人标识：chatId / imContactId / externalUserId 任一 */
  target_id: string;
  reason: string;
  operator: string | null;
  /** 拉黑时的会话快照 */
  chat_id: string | null;
  im_contact_id: string | null;
  contact_name: string | null;
  source: string;
  /** 命中回溯 */
  hit_count: number;
  last_hit_at: string | null;
  last_hit_chat_id: string | null;
  last_hit_bot_id: string | null;
  last_hit_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlacklistData {
  chatIds: string[];
  groupIds: string[];
  candidates?: CandidateBlacklistItem[];
}

export interface AgentReplyConfig {
  // 模型配置
  wecomCallbackModelId: string;
  wecomCallbackThinkingMode: AgentReplyThinkingMode;

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
