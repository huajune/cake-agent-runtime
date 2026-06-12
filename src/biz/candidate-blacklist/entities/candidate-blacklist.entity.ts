/**
 * 候选人黑名单记录
 * @table candidate_blacklist
 */
export interface CandidateBlacklistRecord {
  id: string;
  /** 候选人标识：chatId / imContactId / externalUserId 任一均可 */
  target_id: string;
  /** 拉黑理由（命中告警与暂停记录中展示给运营） */
  reason: string;
  /** 操作人 */
  operator: string | null;
  /** 拉黑时的会话快照（回溯用） */
  chat_id: string | null;
  im_contact_id: string | null;
  contact_name: string | null;
  /** 来源：manual=运营手动 / api=外部系统 */
  source: string;
  /** 命中回溯：哪个托管号最近一次聊到该候选人 */
  hit_count: number;
  last_hit_at: string | null;
  last_hit_chat_id: string | null;
  last_hit_bot_id: string | null;
  last_hit_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 拉黑候选人的入参
 */
export interface AddCandidateBlacklistParams {
  targetId: string;
  reason: string;
  operator?: string;
  /** 拉黑时的会话快照（可选，便于回溯） */
  chatId?: string;
  imContactId?: string;
  contactName?: string;
  source?: string;
}

/**
 * 命中回溯信息
 */
export interface CandidateBlacklistHit {
  chatId?: string;
  botId?: string;
  messageId?: string;
}
