/**
 * Agent 模块枚举定义
 * 集中管理所有枚举类型，便于维护和避免循环依赖
 */

/**
 * Agent 响应状态枚举
 * 定义 Agent API 调用的三种可能状态
 */
export enum AgentResultStatus {
  /** 成功响应 - Agent API 正常返回结果 */
  SUCCESS = 'success',
  /** 降级响应 - Agent API 不可用，使用降级策略返回友好提示 */
  FALLBACK = 'fallback',
  /** 错误响应 - 不可恢复的错误（如配置错误） */
  ERROR = 'error',
}

/**
 * 场景类型枚举
 * 定义支持的业务场景
 */
export enum ScenarioType {
  /** 候选人私聊咨询服务 - 通过企微私聊为候选人提供招聘咨询 */
  CANDIDATE_CONSULTATION = 'candidate-consultation',
}

/**
 * 上下文策略枚举
 * 定义 Agent 处理上下文获取失败时的策略
 */
export enum ContextStrategy {
  /** 抛出错误，中断请求 */
  ERROR = 'error',
  /** 跳过失败的上下文，继续请求 */
  SKIP = 'skip',
  /** 在响应中报告失败，但继续请求 */
  REPORT = 'report',
}
