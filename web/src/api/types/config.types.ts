export type AgentReplyThinkingMode = 'fast' | 'deep';
/** 深度思考档位（deep 模式下生效） */
export type AgentReplyThinkingEffort = 'low' | 'medium' | 'high';
export type HardRuleOverrideMode = 'off' | 'observe';

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
  wecomCallbackThinkingEffort: AgentReplyThinkingEffort;
  /** 默认降级链运行时覆盖（空数组 = 走 AGENT_DEFAULT_FALLBACKS 环境变量） */
  defaultFallbackModelIds: string[];
  /** 图片理解角色降级链覆盖（空数组 = 走 AGENT_VISION_FALLBACKS / 默认链） */
  visionFallbackModelIds: string[];
  extractModelId: string;
  // 其余角色的运行时模型覆盖（空字符串 = 走对应 AGENT_{ROLE}_MODEL 环境变量路由）
  visionModelId: string;
  evaluateModelId: string;
  reviewModelId: string;
  repairModelId: string;
  reengagementModelId: string;

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
  hardRuleOverrides: Record<string, HardRuleOverrideMode>;

  // 主动复聊（reengagement）开关
  reengagementEnabled: boolean;
  reengagementShadow: boolean;
  // 报名后大场景独立开关：关闭后报名后场景（面试提醒/回访）只 shadow
  reengagementPostBookingEnabled: boolean;
  // 场景级灰度 map（key=场景 code）；未配置的场景回退代码默认值
  reengagementScenarioRollout: Record<string, boolean>;
  reengagementScenarioDelayMinutes: Record<string, number>;
}

export interface GroupTaskConfig {
  enabled: boolean;
  dryRun: boolean;
}

export type AgentModelConfigKey =
  | 'wecomCallbackModelId'
  | 'extractModelId'
  | 'visionModelId'
  | 'evaluateModelId'
  | 'reviewModelId'
  | 'repairModelId'
  | 'reengagementModelId';

/** 单条降级链的生效值与来源（db_override=Dashboard 配置；environment=部署环境变量） */
export interface AgentFallbackChainEntry {
  chain: string[];
  source: 'db_override' | 'environment';
}

/** 模型降级链生效快照：Dashboard 配置优先于环境变量链 */
export interface AgentFallbackChains {
  /** 默认降级链（所有角色共享；含主聊图片轮的识图兜底） */
  default: AgentFallbackChainEntry;
  /** 有专属链的角色 → 生效链（优先于默认链） */
  roleOverrides: Record<string, AgentFallbackChainEntry>;
}

export interface AgentReplyConfigResponse {
  config: AgentReplyConfig;
  defaults: AgentReplyConfig;
  fallbackChains?: AgentFallbackChains;
  resolvedModels: Record<
    AgentModelConfigKey,
    {
      modelId: string;
      source:
        | 'runtime_override'
        | 'role_environment'
        | 'role_fallback'
        | 'chat_fallback'
        | 'unconfigured';
      envVar: string;
    }
  >;
  groupTaskConfig: GroupTaskConfig;
}
