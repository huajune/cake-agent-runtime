export interface SimpleMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  imageUrls?: string[];
}

export interface TestChatRequest {
  message?: string;
  history?: SimpleMessage[];
  imageUrls?: string[];
  scenario?: string;
  saveExecution?: boolean;
  userId?: string;
  botUserId?: string;
  botImId?: string;
  caseId?: string;
  caseName?: string;
  category?: string;
  expectedOutput?: string;
  batchId?: string;
  modelId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TestChatResponse {
  executionId?: string;
  actualOutput: string;
  status: 'success' | 'failure' | 'timeout';
  request: {
    url: string;
    method: string;
    body: any;
  };
  response: {
    statusCode: number;
    body: any;
    toolCalls?: any[];
  };
  metrics: {
    durationMs: number;
    tokenUsage: TokenUsage;
  };
}

export interface TestBatch {
  id: string;
  name: string;
  source: 'manual' | 'feishu';
  feishu_table_id: string | null;
  total_cases: number;
  executed_count: number;
  passed_count: number;
  failed_count: number;
  pending_review_count: number;
  pass_rate: number | null;
  avg_duration_ms: number | null;
  avg_token_usage: number | null;
  status: 'created' | 'running' | 'completed' | 'reviewing';
  test_type: 'scenario' | 'conversation';
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface TestExecution {
  id: string;
  batch_id: string | null;
  case_id: string | null;
  case_name: string | null;
  category: string | null;
  input_message: string | null;
  test_input: any;
  expected_output: string | null;
  agent_request: any;
  agent_response: any;
  actual_output: string | null;
  tool_calls: any;
  execution_status: 'pending' | 'running' | 'success' | 'failure' | 'timeout';
  duration_ms: number | null;
  token_usage: TokenUsage | null;
  error_message: string | null;
  review_status: 'pending' | 'passed' | 'failed' | 'skipped';
  review_comment: string | null;
  reviewed_by: string | null;
  reviewer_source: 'manual' | 'codex' | 'claude' | 'system' | 'api' | null;
  reviewed_at: string | null;
  failure_reason: string | null;
  executed_at: string;
  created_at: string;
}

export interface BatchStats {
  totalCases: number;
  executedCount: number;
  passedCount: number;
  failedCount: number;
  pendingReviewCount: number;
  passRate: number | null;
  avgDurationMs: number | null;
  avgTokenUsage: number | null;
}

export interface CategoryStats {
  category: string;
  total: number;
  passed: number;
  failed: number;
}

export interface FailureReasonStats {
  reason: string;
  count: number;
  percentage: number;
}

export interface UpdateReviewRequest {
  reviewStatus: 'passed' | 'failed' | 'skipped';
  reviewComment?: string;
  failureReason?: string;
  testScenario?: string;
  reviewedBy?: string;
  reviewerSource?: 'manual' | 'codex' | 'claude' | 'system' | 'api';
}

// ==================== 流式测试类型 ====================

export type StreamEventType =
  | 'start'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'metrics'
  | 'done'
  | 'error';

export interface StreamEvent {
  type: StreamEventType;
  data: any;
}

export interface StreamCallbacks {
  onStart?: () => void;
  onText?: (text: string, fullText: string) => void;
  onToolCall?: (toolCall: { toolName: string; input: any }) => void;
  onToolResult?: (result: { toolName: string; output: any }) => void;
  onMetrics?: (metrics: {
    durationMs: number;
    tokenUsage: TokenUsage;
    toolCallsCount: number;
  }) => void;
  onDone?: (result: {
    status: string;
    actualOutput: string;
    toolCalls: any[];
    metrics: { durationMs: number; tokenUsage: TokenUsage };
  }) => void;
  onError?: (error: string) => void;
}

export interface ImportFromFeishuRequest {
  appToken: string;
  tableId: string;
  batchName?: string;
  executeImmediately?: boolean;
  parallel?: boolean;
}

export interface ImportResult {
  batchId: string;
  batchName: string;
  totalImported: number;
  cases: Array<{
    caseId: string;
    caseName: string;
    category?: string;
    message: string;
  }>;
}

// ==================== 反馈相关类型 ====================

export type FeedbackType = 'badcase' | 'goodcase';

export interface SubmitFeedbackRequest {
  type: FeedbackType;
  chatHistory: string;
  userMessage?: string;
  errorType?: string;
  remark?: string;
  chatId?: string;
  candidateName?: string;
  managerName?: string;
}

export interface SubmitFeedbackResponse {
  recordId: string;
  type: FeedbackType;
}

export interface BatchListResponse {
  data: TestBatch[];
  total: number;
}

export type TestType = 'scenario' | 'conversation';

export interface QuickCreateBatchRequest {
  batchName?: string;
  parallel?: boolean;
  testType?: TestType;
}

export interface WriteBackFeishuRequest {
  executionId: string;
  testStatus: '通过' | '失败' | '跳过';
  failureCategory?: string;
}

export interface WriteBackResult {
  success: boolean;
  error?: string;
}

export interface ResetChatSessionResponse {
  userId: string;
  corpId: string;
  cleared: boolean;
}

export interface BatchWriteBackResult {
  totalCount: number;
  successCount: number;
  failureCount: number;
  errors: string[];
}

// ==================== 回归验证相关类型 ====================

export type ConversationSnapshotStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface ConversationSnapshot {
  id: string;
  batchId: string;
  feishuRecordId: string;
  conversationId: string;
  validationTitle: string | null;
  participantName: string | null;
  totalTurns: number;
  avgSimilarityScore: number | null;
  minSimilarityScore: number | null;
  status: ConversationSnapshotStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTurnExecution {
  id: string;
  conversationSnapshotId: string;
  turnNumber: number;
  inputMessage: string;
  history: ParsedMessage[];
  expectedOutput: string | null;
  actualOutput: string | null;
  similarityScore: number | null;
  evaluationReason: string | null;
  executionStatus: string;
  toolCalls: unknown[] | null;
  durationMs: number | null;
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  reviewStatus: string;
  reviewComment: string | null;
  failureReason: string | null;
  reviewedBy: string | null;
  reviewerSource: 'manual' | 'codex' | 'claude' | 'system' | 'api' | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface TurnListResponse {
  turns: ConversationTurnExecution[];
  conversationInfo: {
    id: string;
    participantName: string | null;
    totalTurns: number;
    avgSimilarityScore: number | null;
  };
}

export interface ConversationSnapshotListResponse {
  sources: ConversationSnapshot[];
  total: number;
  page: number;
  pageSize: number;
}
