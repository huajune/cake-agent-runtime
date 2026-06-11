/**
 * 候选人黑名单项
 * @table system_config (JSON value of 'candidate_blacklist' key)
 */
export interface CandidateBlacklistItem {
  /** 候选人标识：chatId / imContactId / externalUserId 任一均可 */
  target_id: string;
  /** 拉黑理由（命中告警与暂停记录中展示给运营） */
  reason: string;
  /** 操作人 */
  operator?: string;
  added_at: number;
}
