/**
 * 系统配置接口
 */
export interface SystemConfig {
  workerConcurrency?: number; // Worker 并发数 (1-20)
}

/**
 * Agent 回复策略配置
 */
export type AgentThinkingMode = 'fast' | 'deep';

export interface AgentReplyConfig {
  // 模型配置
  wecomCallbackModelId: string; // 企微消息回调使用的聊天模型 ID；空字符串表示走默认角色路由
  wecomCallbackThinkingMode: AgentThinkingMode; // 企微消息回调使用的思考模式
  extractModelId: string; // 事实提取/沉淀摘要使用的模型 ID；空字符串表示走 extract 角色路由（AGENT_EXTRACT_MODEL）

  // 消息聚合配置
  initialMergeWindowMs: number; // 距离最后一条用户消息静默多久后触发一次 Agent 请求（毫秒）

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

  // 出站守卫 llm 档（语义审查）灰度开关：即时生效，用于灰度上量与紧急熔断
  outputGuardrailLlmEnabled: boolean; // enforce：语义审查结论参与出站裁决（revise/replan/block 真实拦截）
  outputGuardrailSemanticShadowEnabled: boolean; // shadow：未 enforce 时跟随真实流量试跑，结论只观测不拦截

  // 主动复聊（reengagement）开关：即时生效（scheduler 排程 + processor 到点都读最新值）
  reengagementEnabled: boolean; // 总开关：关闭后不再排程新跟进，在途任务到点也直接丢弃
  reengagementShadow: boolean; // shadow：到点走完停止判断与生成但不投递，只记录"本应发"
  reengagementPostBookingEnabled: boolean; // 报名后大场景独立开关：关闭后报名后场景（面试提醒/回访）只 shadow
  reengagementScenarioRollout: Record<string, boolean>; // 场景级灰度 map（key=场景 code）；未配置的场景回退代码默认值
}

/**
 * Agent 回复策略配置默认值
 */
export const DEFAULT_AGENT_REPLY_CONFIG: AgentReplyConfig = {
  wecomCallbackModelId: '',
  wecomCallbackThinkingMode: 'fast',
  extractModelId: '',
  initialMergeWindowMs: 3000, // 默认 3000ms
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
  avgDurationCritical: 90000, // 响应时间高于 90 秒触发告警（totalMs 含 ~3s 合并窗口 + 真实 p50≈52s，60s 阈值会近乎常报）
  queueDepthCritical: 20, // 队列深度高于 20 条触发告警
  errorRateCritical: 10, // 每小时错误超过 10 次触发告警
  // 出站守卫 llm 档默认全关：先 shadow 观测评估，达标后再开 enforce
  outputGuardrailLlmEnabled: false,
  outputGuardrailSemanticShadowEnabled: false,
  // 主动复聊默认关排程、开 shadow：放量顺序是 先开排程看"本应发" → 达标后再关 shadow 真发
  reengagementEnabled: false,
  reengagementShadow: true,
  // 报名后大开关默认开（不额外收紧）；场景级 map 默认空 = 全部回退代码内 defaultRolloutEnabled
  reengagementPostBookingEnabled: true,
  reengagementScenarioRollout: {},
};
