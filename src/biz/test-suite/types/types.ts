import {
  BatchSource,
  TestType,
  ExecutionStatus,
  ReviewStatus,
  ConversationSourceStatus,
} from '@test-suite/enums';

/**
 * 创建批次请求
 */
export interface CreateBatchData {
  name: string;
  source?: BatchSource;
  feishuAppToken?: string;
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
  conversationSourceId?: string;
  turnNumber?: number;
  similarityScore?: number | null;
  inputMessage?: string;
  reviewStatus?: ReviewStatus;
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
  total_turns?: number;
  avg_similarity_score?: number | null;
  min_similarity_score?: number | null;
}

/**
 * 对话源筛选条件
 */
export interface ConversationSourceFilters {
  status?: ConversationSourceStatus;
}
