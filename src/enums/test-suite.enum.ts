/**
 * Agent 测试模块枚举定义
 *
 * 统一管理测试相关的状态枚举，避免字面量散落各处
 */

/**
 * 测试执行状态
 * 表示单个测试用例的执行结果
 */
export enum ExecutionStatus {
  /** 待执行 */
  PENDING = 'pending',
  /** 执行成功 */
  SUCCESS = 'success',
  /** 执行失败 */
  FAILURE = 'failure',
  /** 执行超时 */
  TIMEOUT = 'timeout',
}

/**
 * 评审状态
 * 表示测试结果的人工评审状态
 */
export enum ReviewStatus {
  /** 待评审 */
  PENDING = 'pending',
  /** 评审通过 */
  PASSED = 'passed',
  /** 评审失败 */
  FAILED = 'failed',
  /** 跳过评审 */
  SKIPPED = 'skipped',
}

/**
 * 批次状态
 * 表示测试批次的生命周期状态
 *
 * 状态转换规则：
 * - created → running, cancelled
 * - running → reviewing, cancelled
 * - reviewing → completed, cancelled
 * - completed → (终态)
 * - cancelled → (终态)
 */
export enum BatchStatus {
  /** 已创建，待执行 */
  CREATED = 'created',
  /** 执行中 */
  RUNNING = 'running',
  /** 评审中 */
  REVIEWING = 'reviewing',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 已取消 */
  CANCELLED = 'cancelled',
}

/**
 * 批次来源
 * 表示测试用例的导入来源
 */
export enum BatchSource {
  /** 手动创建 */
  MANUAL = 'manual',
  /** 从飞书导入 */
  FEISHU = 'feishu',
}

/**
 * 失败原因分类
 * 用于标记测试失败的原因类型
 */
export enum FailureReason {
  /** 回答错误 */
  WRONG_ANSWER = 'wrong_answer',
  /** 回答不完整 */
  INCOMPLETE = 'incomplete',
  /** 产生幻觉（虚假信息） */
  HALLUCINATION = 'hallucination',
  /** 工具调用错误 */
  TOOL_ERROR = 'tool_error',
  /** 格式问题 */
  FORMAT_ISSUE = 'format_issue',
  /** 语气问题 */
  TONE_ISSUE = 'tone_issue',
  /** 其他原因 */
  OTHER = 'other',
}

/**
 * 飞书测试状态（中文）
 * 用于回写飞书多维表格的测试结果字段
 */
export enum FeishuTestStatus {
  /** 测试通过 */
  PASSED = '通过',
  /** 测试失败 */
  FAILED = '失败',
  /** 跳过测试 */
  SKIPPED = '跳过',
}

/**
 * 反馈类型
 * 用于用户提交的测试反馈
 */
export enum FeedbackType {
  /** 负面案例 */
  BADCASE = 'badcase',
  /** 正面案例 */
  GOODCASE = 'goodcase',
}

/**
 * 测试类型
 * 区分用例测试和回归验证测试
 */
export enum TestType {
  /** 用例测试 - 预设的测试用例 */
  SCENARIO = 'scenario',
  /** 回归验证 - 真实对话记录验证 */
  CONVERSATION = 'conversation',
}

/**
 * 对话源执行状态
 * 表示回归验证测试的执行状态
 */
export enum ConversationSourceStatus {
  /** 待执行 */
  PENDING = 'pending',
  /** 执行中 */
  RUNNING = 'running',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 执行失败 */
  FAILED = 'failed',
}

/**
 * 相似度评级
 * 基于相似度分数的评级
 */
export enum SimilarityRating {
  /** 优秀 (80-100) - Agent 回复与真人高度一致 */
  EXCELLENT = 'excellent',
  /** 良好 (60-79) - 主要信息覆盖，表述有差异 */
  GOOD = 'good',
  /** 及格 (40-59) - 部分信息一致，需要关注 */
  FAIR = 'fair',
  /** 不及格 (0-39) - 回复内容差异较大，需人工复核 */
  POOR = 'poor',
}
