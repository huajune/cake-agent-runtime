import { ConversationSourceStatus } from '@test-suite/enums';

/**
 * 对话源记录（数据库格式）
 * @table conversation_test_sources
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
