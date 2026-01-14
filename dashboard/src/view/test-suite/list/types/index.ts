/**
 * 测试类型
 */
export type TestType = 'scenario' | 'conversation';

/**
 * 对话源状态
 */
export type ConversationSourceStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * 相似度评级
 */
export type SimilarityRating = 'excellent' | 'good' | 'fair' | 'poor';

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
  expectedOutput: string | null;
  actualOutput: string | null;
  similarityScore: number | null;
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

/**
 * 对话执行结果
 */
export interface ConversationExecutionResult {
  sourceId: string;
  conversationId: string;
  totalTurns: number;
  executedTurns: number;
  avgSimilarityScore: number | null;
  minSimilarityScore: number | null;
  turns: Array<{
    turnNumber: number;
    similarityScore: number | null;
    rating: SimilarityRating | null;
    executionStatus: string;
  }>;
}
