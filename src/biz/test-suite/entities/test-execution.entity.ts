import { ExecutionStatus, ReviewStatus } from '@test-suite/enums';

/**
 * 测试执行记录（数据库格式）
 * @table test_executions
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
