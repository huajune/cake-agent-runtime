import {
  BatchSource,
  TestType,
  ExecutionStatus,
  ReviewStatus,
  ReviewerSource,
  ConversationSourceStatus,
} from '../enums/test.enum';

/**
 * 创建批次请求
 */
export interface CreateBatchData {
  name: string;
  source?: BatchSource;
  feishuTableId?: string;
  testType?: TestType;
}

/**
 * 批次统计数据
 */
export interface BatchStatsData {
  totalCases: number;
  executedCount: number;
  passedCount: number;
  failedCount: number;
  pendingReviewCount: number;
  passRate: number | null;
  avgDurationMs: number | null;
  avgTokenUsage: number | null;
}

/**
 * 创建执行记录数据
 */
export interface CreateExecutionData {
  batchId?: string;
  caseId?: string;
  caseName?: string;
  category?: string;
  testInput: unknown;
  expectedOutput?: string;
  agentRequest: unknown;
  agentResponse: unknown;
  actualOutput: string;
  toolCalls: unknown[];
  executionStatus: ExecutionStatus;
  durationMs: number;
  tokenUsage: unknown;
  errorMessage: string | null;
  // 回归验证相关字段
  conversationSnapshotId?: string;
  turnNumber?: number;
  similarityScore?: number | null;
  inputMessage?: string;
  reviewStatus?: ReviewStatus;
  reviewerSource?: ReviewerSource;
  /** LLM 评估理由 */
  evaluationReason?: string | null;
}

/**
 * 更新执行结果数据
 */
export interface UpdateExecutionResultData {
  agentRequest?: unknown;
  agentResponse?: unknown;
  actualOutput?: string;
  toolCalls?: unknown[];
  executionStatus: ExecutionStatus;
  durationMs: number;
  tokenUsage?: unknown;
  errorMessage?: string;
}

/**
 * 更新评审数据
 */
export interface UpdateReviewData {
  reviewStatus: ReviewStatus;
  reviewComment?: string;
  failureReason?: string;
  testScenario?: string;
  reviewedBy?: string;
  reviewerSource?: ReviewerSource;
}

/**
 * 执行记录筛选条件
 */
export interface ExecutionFilters {
  reviewStatus?: ReviewStatus;
  executionStatus?: ExecutionStatus;
  category?: string;
}

/**
 * 创建对话源数据
 */
export interface CreateConversationSourceData {
  batchId: string;
  feishuRecordId: string;
  conversationId: string;
  participantName?: string;
  fullConversation: unknown;
  rawText?: string;
  totalTurns: number;
}

/**
 * 更新对话源数据
 */
export interface UpdateConversationSourceData {
  status?: ConversationSourceStatus;
  totalTurns?: number;
  avgSimilarityScore?: number | null;
  minSimilarityScore?: number | null;
}

/**
 * 对话源筛选条件
 */
export interface ConversationSourceFilters {
  status?: ConversationSourceStatus;
}

/**
 * LLM 评估结果接口
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
