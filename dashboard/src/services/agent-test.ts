import axios from 'axios';

const api = axios.create({
  baseURL: '',
  timeout: 120000, // Agent API 可能需要较长时间
});

// ==================== 类型定义 ====================

export interface SimpleMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TestChatRequest {
  message: string;
  history?: SimpleMessage[];
  scenario?: string;
  saveExecution?: boolean;
  caseId?: string;
  caseName?: string;
  category?: string;
  expectedOutput?: string;
  batchId?: string;
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
  input_message: string | null; // 用户输入消息（从 test_input 提取）
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
  reviewed_at: string | null;
  failure_reason: string | null;
  executed_at: string; // 执行时间
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
}

// ==================== 流式测试类型 ====================

/**
 * SSE 事件类型
 */
export type StreamEventType =
  | 'start'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'metrics'
  | 'done'
  | 'error';

/**
 * SSE 事件数据
 */
export interface StreamEvent {
  type: StreamEventType;
  data: any;
}

/**
 * 流式测试回调函数
 */
export interface StreamCallbacks {
  onStart?: () => void;
  onText?: (text: string, fullText: string) => void;
  onToolCall?: (toolCall: { toolName: string; input: any }) => void;
  onToolResult?: (result: { toolName: string; output: any }) => void;
  onMetrics?: (metrics: { durationMs: number; tokenUsage: TokenUsage; toolCallsCount: number }) => void;
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
}

export interface SubmitFeedbackResponse {
  recordId: string;
  type: FeedbackType;
}

// ==================== API 函数 ====================

/**
 * 执行单条测试
 */
export async function executeTest(request: TestChatRequest): Promise<TestChatResponse> {
  const { data } = await api.post('/test-suite/chat', request);
  return data.data;
}

/**
 * 执行流式测试
 * 使用 fetch API 接收 SSE 事件流
 *
 * @param request 测试请求参数
 * @param callbacks 事件回调函数
 * @returns AbortController 用于取消请求
 */
export function executeTestStream(
  request: TestChatRequest,
  callbacks: StreamCallbacks,
): AbortController {
  const controller = new AbortController();

  // 使用 fetch 发起 POST 请求接收 SSE
  fetch('/test-suite/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(request),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('无法获取响应流');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 事件（以 \n\n 分隔）
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // 保留最后一个可能不完整的事件

        for (const eventStr of events) {
          if (!eventStr.trim()) continue;

          // 解析事件类型和数据
          const lines = eventStr.split('\n');
          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            }
          }

          if (!eventType || !eventData) continue;

          try {
            const data = JSON.parse(eventData);

            // 根据事件类型调用对应回调
            switch (eventType) {
              case 'start':
                callbacks.onStart?.();
                break;
              case 'text':
                callbacks.onText?.(data.text, data.fullText);
                break;
              case 'tool_call':
                callbacks.onToolCall?.(data);
                break;
              case 'tool_result':
                callbacks.onToolResult?.(data);
                break;
              case 'metrics':
                callbacks.onMetrics?.(data);
                break;
              case 'done':
                callbacks.onDone?.(data);
                break;
              case 'error':
                callbacks.onError?.(data.message);
                break;
            }
          } catch (e) {
            console.warn('解析 SSE 事件失败:', eventStr, e);
          }
        }
      }
    })
    .catch((error) => {
      if (error.name !== 'AbortError') {
        callbacks.onError?.(error.message || '流式请求失败');
      }
    });

  return controller;
}

/**
 * 批量执行测试
 */
export async function executeBatchTest(
  cases: TestChatRequest[],
  batchName?: string,
  parallel = false,
): Promise<{
  batchId: string;
  totalCases: number;
  successCount: number;
  failureCount: number;
  results: TestChatResponse[];
}> {
  const { data } = await api.post('/test-suite/batch', {
    cases,
    batchName,
    parallel,
  });
  return data.data;
}

/**
 * 创建测试批次
 */
export async function createBatch(request: {
  name: string;
  source?: 'manual' | 'feishu';
  feishuAppToken?: string;
  feishuTableId?: string;
}): Promise<TestBatch> {
  const { data } = await api.post('/test-suite/batches', request);
  return data.data;
}

/**
 * 批次列表分页响应
 */
export interface BatchListResponse {
  data: TestBatch[];
  total: number;
}

/**
 * 测试类型
 */
export type TestType = 'scenario' | 'conversation';

/**
 * 获取批次列表（支持分页和类型过滤）
 *
 * @param limit 每页数量
 * @param offset 偏移量
 * @param testType 测试类型过滤：scenario-用例测试，conversation-回归验证
 */
export async function getBatches(
  limit = 20,
  offset = 0,
  testType?: TestType,
): Promise<BatchListResponse> {
  const { data } = await api.get('/test-suite/batches', {
    params: { limit, offset, testType },
  });
  return { data: data.data, total: data.total };
}

/**
 * 获取批次详情
 */
export async function getBatch(id: string): Promise<TestBatch> {
  const { data } = await api.get(`/test-suite/batches/${id}`);
  return data.data;
}

/**
 * 获取批次统计
 */
export async function getBatchStats(id: string): Promise<BatchStats> {
  const { data } = await api.get(`/test-suite/batches/${id}/stats`);
  return data.data;
}

/**
 * 获取批次分类统计
 */
export async function getCategoryStats(id: string): Promise<CategoryStats[]> {
  const { data } = await api.get(`/test-suite/batches/${id}/category-stats`);
  return data.data;
}

/**
 * 获取批次失败原因统计
 */
export async function getFailureReasonStats(id: string): Promise<FailureReasonStats[]> {
  const { data } = await api.get(`/test-suite/batches/${id}/failure-stats`);
  return data.data;
}

/**
 * 获取批次的执行记录
 */
export async function getBatchExecutions(
  batchId: string,
  filters?: {
    reviewStatus?: string;
    executionStatus?: string;
    category?: string;
  },
): Promise<TestExecution[]> {
  const { data } = await api.get(`/test-suite/batches/${batchId}/executions`, {
    params: filters,
  });
  return data.data;
}

/**
 * 获取执行记录列表
 */
export async function getExecutions(limit = 50, offset = 0): Promise<TestExecution[]> {
  const { data } = await api.get('/test-suite/executions', {
    params: { limit, offset },
  });
  return data.data;
}

/**
 * 获取执行记录详情
 */
export async function getExecution(id: string): Promise<TestExecution> {
  const { data } = await api.get(`/test-suite/executions/${id}`);
  return data.data;
}

/**
 * 更新评审状态
 */
export async function updateReview(
  executionId: string,
  review: UpdateReviewRequest,
): Promise<TestExecution> {
  const { data } = await api.patch(`/test-suite/executions/${executionId}/review`, review);
  return data.data;
}

/**
 * 批量更新评审状态
 */
export async function batchUpdateReview(
  executionIds: string[],
  review: UpdateReviewRequest,
): Promise<{ updatedCount: number }> {
  const { data } = await api.patch('/test-suite/executions/batch-review', {
    executionIds,
    review,
  });
  return data.data;
}

/**
 * 从飞书多维表格导入测试用例
 */
export async function importFromFeishu(request: ImportFromFeishuRequest): Promise<ImportResult> {
  const { data } = await api.post('/test-suite/batches/import-from-feishu', request);
  return data.data;
}

/**
 * 提交测试反馈（badcase/goodcase）
 */
export async function submitFeedback(request: SubmitFeedbackRequest): Promise<SubmitFeedbackResponse> {
  const { data } = await api.post('/test-suite/feedback', request);
  return data.data;
}

// ==================== 一键测试 & 飞书回写 ====================

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

export interface BatchWriteBackResult {
  totalCount: number;
  successCount: number;
  failureCount: number;
  errors: string[];
}

/**
 * 一键创建批量测试（从预配置的飞书测试集表导入并执行）
 */
export async function quickCreateBatch(request?: QuickCreateBatchRequest): Promise<ImportResult> {
  const { data } = await api.post('/test-suite/batches/quick-create', request || {});
  return data.data;
}

/**
 * 回写测试结果到飞书
 */
export async function writeBackToFeishu(
  executionId: string,
  testStatus: '通过' | '失败' | '跳过',
  failureCategory?: string,
): Promise<WriteBackResult> {
  const { data } = await api.post(`/test-suite/executions/${executionId}/write-back`, {
    executionId,
    testStatus,
    failureCategory,
  });
  return data.data;
}

/**
 * 批量回写测试结果到飞书
 */
export async function batchWriteBackToFeishu(
  items: WriteBackFeishuRequest[],
): Promise<BatchWriteBackResult> {
  const { data } = await api.post('/test-suite/executions/batch-write-back', { items });
  return data.data;
}

// ==================== 回归验证相关类型 ====================

/**
 * 对话源状态
 */
export type ConversationSourceStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * 解析后的对话消息（真人对话历史）
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
 * 对话源记录
 */
export interface ConversationSource {
  id: string;
  batchId: string;
  feishuRecordId: string;
  conversationId: string;
  participantName: string | null;
  totalTurns: number;
  avgSimilarityScore: number | null;
  minSimilarityScore: number | null;
  status: ConversationSourceStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * 对话轮次执行记录
 */
export interface ConversationTurnExecution {
  id: string;
  conversationSourceId: string;
  turnNumber: number;
  inputMessage: string;
  /** 真人对话历史（候选人 + 招募经理的对话，作为 Agent 的上下文） */
  history: ParsedMessage[];
  expectedOutput: string | null;
  actualOutput: string | null;
  similarityScore: number | null;
  /** LLM 评估理由 */
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
  createdAt: Date;
}

/**
 * 对话轮次列表响应
 */
export interface TurnListResponse {
  turns: ConversationTurnExecution[];
  conversationInfo: {
    id: string;
    participantName: string | null;
    totalTurns: number;
    avgSimilarityScore: number | null;
  };
}

/**
 * 对话源列表响应
 */
export interface ConversationSourceListResponse {
  sources: ConversationSource[];
  total: number;
  page: number;
  pageSize: number;
}

// ==================== 回归验证 API 函数 ====================

/**
 * 获取对话源列表
 */
export async function getConversationSources(params: {
  batchId: string;
  page?: number;
  pageSize?: number;
  status?: ConversationSourceStatus;
}): Promise<ConversationSourceListResponse> {
  const { data } = await api.get('/test-suite/conversations', { params });
  return data.data;
}

/**
 * 获取对话轮次列表
 */
export async function getConversationTurns(sourceId: string): Promise<TurnListResponse> {
  const { data } = await api.get(`/test-suite/conversations/${sourceId}/turns`);
  return data.data;
}

/**
 * 执行单个回归验证
 */
export async function executeConversation(params: {
  sourceId: string;
  forceRerun?: boolean;
}): Promise<{
  sourceId: string;
  conversationId: string;
  totalTurns: number;
  executedTurns: number;
  avgSimilarityScore: number | null;
  minSimilarityScore: number | null;
}> {
  const { data } = await api.post(`/test-suite/conversations/${params.sourceId}/execute`, {
    forceRerun: params.forceRerun,
  });
  return data.data;
}

/**
 * 批量执行回归验证
 */
export async function executeConversationBatch(params: {
  batchId: string;
  forceRerun?: boolean;
  parallel?: boolean;
}): Promise<{
  batchId: string;
  totalConversations: number;
  executedConversations: number;
  avgSimilarityScore: number | null;
}> {
  const { data } = await api.post(`/test-suite/conversations/batch/${params.batchId}/execute`, {
    forceRerun: params.forceRerun,
    parallel: params.parallel,
  });
  return data.data;
}

/**
 * 更新轮次评审
 */
export async function updateTurnReview(params: {
  executionId: string;
  reviewStatus: 'passed' | 'failed' | 'skipped';
  reviewComment?: string;
}): Promise<ConversationTurnExecution> {
  const { data } = await api.patch(`/test-suite/conversations/turns/${params.executionId}/review`, {
    reviewStatus: params.reviewStatus,
    reviewComment: params.reviewComment,
  });
  return data.data;
}

export default api;
