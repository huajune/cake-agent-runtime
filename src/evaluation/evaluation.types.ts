/**
 * Evaluation 模块类型定义
 *
 * 所有纯 AI 评估相关的类型，供 evaluation/ 服务内部使用，
 * 以及供 biz/test-suite 通过 @evaluation 别名引用。
 */

/**
 * 解析后的对话消息
 */
export interface ParsedMessage {
  /** 角色: user(候选人) | assistant(招募经理) */
  role: 'user' | 'assistant';
  /** 消息内容 */
  content: string;
  /** 发送时间（原始格式，如 "12/04 17:20"） */
  timestamp?: string;
}

/**
 * 回归验证轮次数据
 */
export interface ConversationTurn {
  /** 轮次编号（从1开始） */
  turnNumber: number;
  /** 历史上下文（前 N-1 轮的完整对话） */
  history: ParsedMessage[];
  /** 当前轮用户消息 */
  userMessage: string;
  /** 期望输出（真人经理的实际回复） */
  expectedOutput: string;
}

/**
 * 对话解析结果
 */
export interface ConversationParseResult {
  /** 是否解析成功 */
  success: boolean;
  /** 解析后的消息列表 */
  messages: ParsedMessage[];
  /** 总轮数（候选人发言次数） */
  totalTurns: number;
  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * LLM 评估结果
 */
export interface LlmEvaluationResult {
  /** 评估分数 (0-100) */
  score: number;
  /** 是否通过 (score >= 60) */
  passed: boolean;
  /** 评估理由 */
  reason: string;
  /** 评估 ID（用于追踪） */
  evaluationId: string;
  /** Token 消耗 */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * 评估输入参数
 */
export interface EvaluationInput {
  /** 用户消息 */
  userMessage: string;
  /** 期望回复（真人参考） */
  expectedOutput: string;
  /** 实际回复（Agent 生成） */
  actualOutput: string;
  /** 对话历史（可选，提供上下文） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * 相似度评级
 */
export enum SimilarityRating {
  /** 优秀 (80-100) */
  EXCELLENT = 'excellent',
  /** 良好 (60-79) */
  GOOD = 'good',
  /** 及格 (40-59) */
  FAIR = 'fair',
  /** 不及格 (0-39) */
  POOR = 'poor',
}
