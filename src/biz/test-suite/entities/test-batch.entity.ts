import { BatchStatus, BatchSource, TestType } from '../enums/test.enum';

/**
 * 测试批次（数据库格式）
 * @table test_batches
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
