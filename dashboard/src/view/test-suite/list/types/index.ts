// 从 agent-test 服务导入并重新导出共享类型
export type {
  ConversationTurnExecution,
  TurnListResponse,
  ParsedMessage,
} from '@/api/services/agent-test.service';

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
 * 工具调用记录
 * 通用工具调用接口，支持多种命名约定
 */
export interface ToolCall {
  // 工具名称字段（支持多种命名）
  name?: string;
  toolName?: string;
  tool?: string;

  // 输入参数字段（支持多种命名）
  input?: unknown; // 后端回归验证返回的字段
  arguments?: unknown; // 用例测试返回的字段

  // 输出结果字段（支持多种命名）
  output?: unknown; // 后端回归验证返回的字段
  result?: unknown; // 用例测试返回的字段
}

/**
 * Token 使用量
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
