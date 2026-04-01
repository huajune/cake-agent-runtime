/** 用户身份信息 — 长期记忆 Profile，跨会话复用 */
export interface UserProfile {
  name: string | null;
  phone: string | null;
  gender: string | null;
  age: string | null;
  is_student: boolean | null;
  education: string | null;
  has_health_certificate: string | null;
}

/** 消息回调元数据 — 冗余到长期记忆中 */
export interface MessageMetadata {
  botId?: string;
  imBotId?: string;
  imContactId?: string;
  contactType?: number;
  contactName?: string;
  externalUserId?: string;
  avatar?: string;
}

/** 单条对话摘要 */
export interface SummaryEntry {
  summary: string;
  sessionId: string;
  startTime: string;
  endTime: string;
}

/** 对话摘要数据 — 分层压缩结构 */
export interface SummaryData {
  /** 最近 N 条详细摘要 */
  recent: SummaryEntry[];
  /** 更早的摘要被 LLM 压缩合并成的总结 */
  archive: string | null;
  /** 最近一次已沉淀到长期记忆的消息边界。 */
  lastSettledMessageAt: string | null;
}

/** agent_memories 行中的回调元信息。 */
export interface LongTermMemoryMetadata {
  createdAt: string;
  updatedAt: string;
  messageMetadata: MessageMetadata | null;
}

/** 长期记忆层在业务上的完整状态视图。 */
export interface LongTermMemoryState {
  profile: UserProfile | null;
  summary: SummaryData | null;
  metadata: LongTermMemoryMetadata | null;
}

/** agent_memories 表行类型（每用户一行，Profile 平铺 + summary_data jsonb + message_metadata jsonb）。 */
export interface AgentMemoryRow {
  id: string;
  corp_id: string;
  user_id: string;
  name?: string | null;
  phone?: string | null;
  gender?: string | null;
  age?: string | null;
  is_student?: boolean | null;
  education?: string | null;
  has_health_certificate?: string | null;
  summary_data?: SummaryData | null;
  message_metadata?: MessageMetadata | null;
  created_at: string;
  updated_at: string;
}

/** 长期记忆层的真实持久化结果。 */
export interface LongTermStorageResult {
  source: 'supabase';
  table: 'agent_memories';
  row: AgentMemoryRow | null;
}

/** 便于复用的长期记忆 upsert payload。 */
export type ProfileUpsertPayload = Partial<UserProfile>;

/** 最大保留的详细摘要条数 */
export const MAX_RECENT_SUMMARIES = 5;
