import {
  BatchStatus,
  BatchSource,
  TestType,
  ExecutionStatus,
  ReviewStatus,
  ConversationSourceStatus,
} from '@test-suite/enums';

/**
 * 测试批次（数据库格式）
 */
export interface TestBatch {
  id: string;
  name: string;
  source: BatchSource;
  feishu_app_token: string | null;
  feishu_table_id: string | null;
  total_cases: number;
  executed_count: number;
  passed_count: number;
  failed_count: number;
  pending_review_count: number;
  pass_rate: number | null;
  avg_duration_ms: number | null;
  avg_token_usage: number | null;
  status: BatchStatus;
  test_type: TestType;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

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
 * 测试执行记录（数据库格式）
 */
export interface TestExecution {
  id: string;
  batch_id: string | null;
  case_id: string | null;
  case_name: string | null;
  category: string | null;
  test_input: unknown;
  expected_output: string | null;
  agent_request: unknown;
  agent_response: unknown;
  actual_output: string | null;
  tool_calls: unknown;
  execution_status: ExecutionStatus;
  duration_ms: number | null;
  token_usage: unknown;
  error_message: string | null;
  review_status: ReviewStatus;
  review_comment: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  failure_reason: string | null;
  test_scenario: string | null;
  created_at: string;
  // 回归验证相关字段
  conversation_source_id: string | null;
  turn_number: number | null;
  similarity_score: number | null;
  input_message: string | null;
  /** LLM 评估理由 */
  evaluation_reason: string | null;
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
 * 对话源记录（数据库格式）
 */
export interface ConversationSourceRecord {
  id: string;
  batch_id: string;
  feishu_record_id: string;
  conversation_id: string;
  participant_name: string | null;
  full_conversation: unknown;
  raw_text: string | null;
  total_turns: number;
  avg_similarity_score: number | null;
  min_similarity_score: number | null;
  status: ConversationSourceStatus;
  created_at: string;
  updated_at: string;
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
