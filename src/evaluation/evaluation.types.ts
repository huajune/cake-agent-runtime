import { z } from 'zod';

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
  /** 参考输出；真实对话拆轮时为历史下一条真人回复，动态工具场景不能当硬断言 */
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
export interface EvaluationDimensionResult {
  /** 维度分数 (0-100) */
  score: number;
  /** 维度简评 */
  reason: string;
}

export interface EvaluationDimensions {
  factualAccuracy: EvaluationDimensionResult;
  responseEfficiency: EvaluationDimensionResult;
  processCompliance: EvaluationDimensionResult;
  toneNaturalness: EvaluationDimensionResult;
}

export interface LlmEvaluationResult {
  /** 评估分数 (0-100) */
  score: number;
  /** 是否通过 (score >= 60) */
  passed: boolean;
  /** 评估摘要 */
  summary: string;
  /** 评估理由 */
  reason: string;
  /** 多维评分明细 */
  dimensions: EvaluationDimensions;
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
 * LLM 结构化评估输出。
 *
 * 只保留真正需要模型判断的字段：
 * - `summary`
 * - `dimensions`
 *
 * `score` 与 `passed` 由服务端根据维度权重统一推导，避免模型返回自相矛盾的数据。
 */
const EvaluationDimensionSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().min(1).max(80),
});

export const EvaluationStructuredOutputSchema = z.object({
  summary: z.string().min(1).max(120),
  dimensions: z.object({
    factualAccuracy: EvaluationDimensionSchema,
    responseEfficiency: EvaluationDimensionSchema,
    processCompliance: EvaluationDimensionSchema,
    toneNaturalness: EvaluationDimensionSchema,
  }),
});

export type EvaluationStructuredOutput = z.infer<typeof EvaluationStructuredOutputSchema>;

export const DefaultEvaluationDimensions: EvaluationDimensions = {
  factualAccuracy: { score: 0, reason: '评估失败' },
  responseEfficiency: { score: 0, reason: '评估失败' },
  processCompliance: { score: 0, reason: '评估失败' },
  toneNaturalness: { score: 0, reason: '评估失败' },
};

/**
 * 评估输入参数
 */
export interface EvaluationInput {
  /** 用户消息 */
  userMessage: string;
  /** 参考回复；真实对话拆轮时为历史下一条真人回复 */
  expectedOutput: string;
  /** 实际回复（Agent 生成） */
  actualOutput: string;
  /** 对话历史（可选，提供上下文） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 评估模式：默认按真人参考回复评估；工具动态数据场景按工具结果评估 */
  evaluationMode?: 'reference_reply' | 'tool_grounded';
  /** 本轮工具调用；tool_grounded 模式下作为事实锚点 */
  toolCalls?: unknown[];
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
