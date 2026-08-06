/**
 * Agent 模块枚举定义
 */

/**
 * 场景类型枚举
 * 定义支持的业务场景
 */
export enum ScenarioType {
  /** 候选人私聊咨询服务 - 通过企微私聊为候选人提供招聘咨询 */
  CANDIDATE_CONSULTATION = 'candidate-consultation',
}

/**
 * Agent 调用方身份。
 *
 * 替代历史上分散在 `userMessage !== undefined` / `corpId === 'test' | 'debug'` 的隐式推导，
 * 让 agent 层能显式分叉运行时行为（是否加载短期记忆、tool 默认 strategySource 等）。
 */
export enum CallerKind {
  /** 企微渠道生产链路；只传本轮 userMessage，历史由 memory 从 Redis/DB 加载。 */
  WECOM = 'wecom',
  /** 测试套件链路；直传完整 messages[]，历史不再加载。 */
  TEST_SUITE = 'test-suite',
  /** Controller 调试端点；直传 messages[]，历史不加载。 */
  DEBUG = 'debug',
}
