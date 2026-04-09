import { api, unwrapResponse } from '../client';
import type {
  TestChatRequest,
  TestChatResponse,
  TestBatch,
  TestExecution,
  BatchStats,
  CategoryStats,
  FailureReasonStats,
  UpdateReviewRequest,
  StreamCallbacks,
  ImportFromFeishuRequest,
  ImportResult,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  BatchListResponse,
  TestType,
  QuickCreateBatchRequest,
  WriteBackFeishuRequest,
  WriteBackResult,
  ResetChatSessionResponse,
  BatchWriteBackResult,
  ConversationSnapshotStatus,
  ConversationSnapshotListResponse,
  TurnListResponse,
  ConversationTurnExecution,
} from '../types/agent-test.types';

// Re-export all types for consumers
export type {
  SimpleMessage,
  TestChatRequest,
  TokenUsage,
  TestChatResponse,
  TestBatch,
  TestExecution,
  BatchStats,
  CategoryStats,
  FailureReasonStats,
  UpdateReviewRequest,
  StreamEventType,
  StreamEvent,
  StreamCallbacks,
  ImportFromFeishuRequest,
  ImportResult,
  FeedbackType,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  BatchListResponse,
  TestType,
  QuickCreateBatchRequest,
  WriteBackFeishuRequest,
  WriteBackResult,
  ResetChatSessionResponse,
  BatchWriteBackResult,
  ConversationSnapshotStatus,
  ParsedMessage,
  ConversationSnapshot,
  ConversationTurnExecution,
  TurnListResponse,
  ConversationSnapshotListResponse,
} from '../types/agent-test.types';

/** Agent 测试请求超时时间（测试可能需要较长时间） */
const AGENT_TEST_TIMEOUT = 120000;

// ==================== API 函数 ====================

export async function executeTest(request: TestChatRequest): Promise<TestChatResponse> {
  const { data } = await api.post('/test-suite/chat', request, { timeout: AGENT_TEST_TIMEOUT });
  return unwrapResponse<TestChatResponse>(data);
}

export async function resetChatSessionMemory(params: {
  userId: string;
  corpId?: string;
}): Promise<ResetChatSessionResponse> {
  const { data } = await api.post('/test-suite/chat/reset-session', params, {
    timeout: AGENT_TEST_TIMEOUT,
  });
  return unwrapResponse<ResetChatSessionResponse>(data);
}

export function executeTestStream(
  request: TestChatRequest,
  callbacks: StreamCallbacks,
): AbortController {
  const controller = new AbortController();

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const token = import.meta.env.API_GUARD_TOKEN;
  if (token) {
    fetchHeaders['Authorization'] = `Bearer ${token}`;
  }

  fetch('/test-suite/chat/stream', {
    method: 'POST',
    headers: fetchHeaders,
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

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const eventStr of events) {
          if (!eventStr.trim()) continue;

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
  }, { timeout: AGENT_TEST_TIMEOUT });
  return unwrapResponse<{
    batchId: string;
    totalCases: number;
    successCount: number;
    failureCount: number;
    results: TestChatResponse[];
  }>(data);
}

export async function createBatch(request: {
  name: string;
  source?: 'manual' | 'feishu';
  feishuAppToken?: string;
  feishuTableId?: string;
}): Promise<TestBatch> {
  const { data } = await api.post('/test-suite/batches', request);
  return unwrapResponse<TestBatch>(data);
}

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

export async function getBatch(id: string): Promise<TestBatch> {
  const { data } = await api.get(`/test-suite/batches/${id}`);
  return unwrapResponse<TestBatch>(data);
}

export async function getBatchStats(id: string): Promise<BatchStats> {
  const { data } = await api.get(`/test-suite/batches/${id}/stats`);
  return unwrapResponse<BatchStats>(data);
}

export async function getCategoryStats(id: string): Promise<CategoryStats[]> {
  const { data } = await api.get(`/test-suite/batches/${id}/category-stats`);
  return unwrapResponse<CategoryStats[]>(data);
}

export async function getFailureReasonStats(id: string): Promise<FailureReasonStats[]> {
  const { data } = await api.get(`/test-suite/batches/${id}/failure-stats`);
  return unwrapResponse<FailureReasonStats[]>(data);
}

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
  return unwrapResponse<TestExecution[]>(data);
}

export async function getExecutions(limit = 50, offset = 0): Promise<TestExecution[]> {
  const { data } = await api.get('/test-suite/executions', {
    params: { limit, offset },
  });
  return unwrapResponse<TestExecution[]>(data);
}

export async function getExecution(id: string): Promise<TestExecution> {
  const { data } = await api.get(`/test-suite/executions/${id}`);
  return unwrapResponse<TestExecution>(data);
}

export async function updateReview(
  executionId: string,
  review: UpdateReviewRequest,
): Promise<TestExecution> {
  const { data } = await api.patch(`/test-suite/executions/${executionId}/review`, review);
  return unwrapResponse<TestExecution>(data);
}

export async function batchUpdateReview(
  executionIds: string[],
  review: UpdateReviewRequest,
): Promise<{ updatedCount: number }> {
  const { data } = await api.patch('/test-suite/executions/batch-review', {
    executionIds,
    review,
  });
  return unwrapResponse<{ updatedCount: number }>(data);
}

export async function importFromFeishu(request: ImportFromFeishuRequest): Promise<ImportResult> {
  const { data } = await api.post('/test-suite/batches/import-from-feishu', request);
  return unwrapResponse<ImportResult>(data);
}

export async function submitFeedback(request: SubmitFeedbackRequest): Promise<SubmitFeedbackResponse> {
  const { data } = await api.post('/test-suite/feedback', request);
  return unwrapResponse<SubmitFeedbackResponse>(data);
}

// ==================== 一键测试 & 飞书回写 ====================

export async function quickCreateBatch(request?: QuickCreateBatchRequest): Promise<ImportResult> {
  const { data } = await api.post('/test-suite/batches/quick-create', request || {}, { timeout: AGENT_TEST_TIMEOUT });
  return unwrapResponse<ImportResult>(data);
}

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
  return unwrapResponse<WriteBackResult>(data);
}

export async function batchWriteBackToFeishu(
  items: WriteBackFeishuRequest[],
): Promise<BatchWriteBackResult> {
  const { data } = await api.post('/test-suite/executions/batch-write-back', { items });
  return unwrapResponse<BatchWriteBackResult>(data);
}

// ==================== 回归验证 API ====================

export async function getConversationSnapshots(params: {
  batchId: string;
  page?: number;
  pageSize?: number;
  status?: ConversationSnapshotStatus;
}): Promise<ConversationSnapshotListResponse> {
  const { data } = await api.get('/test-suite/conversations', { params });
  return unwrapResponse<ConversationSnapshotListResponse>(data);
}

export async function getConversationTurns(sourceId: string): Promise<TurnListResponse> {
  const { data } = await api.get(`/test-suite/conversations/${sourceId}/turns`);
  return unwrapResponse<TurnListResponse>(data);
}

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
  }, { timeout: AGENT_TEST_TIMEOUT });
  return unwrapResponse<{
    sourceId: string;
    conversationId: string;
    totalTurns: number;
    executedTurns: number;
    avgSimilarityScore: number | null;
    minSimilarityScore: number | null;
  }>(data);
}

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
  }, { timeout: AGENT_TEST_TIMEOUT });
  return unwrapResponse<{
    batchId: string;
    totalConversations: number;
    executedConversations: number;
    avgSimilarityScore: number | null;
  }>(data);
}

export async function updateTurnReview(params: {
  executionId: string;
  reviewStatus: 'passed' | 'failed' | 'skipped';
  reviewComment?: string;
}): Promise<ConversationTurnExecution> {
  const { data } = await api.patch(`/test-suite/conversations/turns/${params.executionId}/review`, {
    reviewStatus: params.reviewStatus,
    reviewComment: params.reviewComment,
  });
  return unwrapResponse<ConversationTurnExecution>(data);
}
