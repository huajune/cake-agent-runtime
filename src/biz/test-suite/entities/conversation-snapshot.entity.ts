import { ConversationSourceStatus } from '../enums/test.enum';

/**
 * 对话快照记录（数据库格式）
 * @table test_conversation_snapshots
 */
export interface ConversationSnapshotRecord {
  id: string;
  batch_id: string;
  feishu_record_id: string;
  conversation_id: string;
  validation_title: string | null;
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
