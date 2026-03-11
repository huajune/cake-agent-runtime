/**
 * 小组黑名单项
 * @table system_config (JSON value of 'group_blacklist' key)
 */
export interface GroupBlacklistItem {
  groupId: string;
  reason?: string;
  addedAt: number;
}
