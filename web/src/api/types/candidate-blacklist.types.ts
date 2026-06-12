/**
 * 候选人黑名单类型（独立业务表 candidate_blacklist，与 system_config 黑名单无关）
 */

/**
 * 候选人黑名单记录（对应后端 candidate_blacklist 表，字段为 snake_case）
 */
export interface CandidateBlacklistItem {
  id: string;
  /** 候选人标识：chatId / imContactId / externalUserId 任一 */
  target_id: string;
  reason: string;
  operator: string | null;
  /** 拉黑时的会话快照 */
  chat_id: string | null;
  im_contact_id: string | null;
  contact_name: string | null;
  /** 拉黑时快照：该候选人最近聊过的托管账号（wxid + 招募经理姓名） */
  im_bot_id: string | null;
  bot_name: string | null;
  source: string;
  /** 命中回溯 */
  hit_count: number;
  last_hit_at: string | null;
  last_hit_chat_id: string | null;
  last_hit_bot_id: string | null;
  last_hit_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddCandidateBlacklistParams {
  /** 候选人标识：chatId / imContactId / externalUserId 任一 */
  targetId: string;
  /** 拉黑理由（必填，命中告警中展示） */
  reason: string;
  operator?: string;
  /** 拉黑时的会话快照（可选，供回溯） */
  chatId?: string;
  imContactId?: string;
  contactName?: string;
}
