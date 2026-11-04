export const GROUP_INVITE_FAILURE_REASON = {
  ENTERPRISE_TOKEN_MISSING: 'enterprise_token_missing',
  MISSING_BOT_IDENTITY: 'missing_bot_identity',
  NO_GROUP_AVAILABLE: 'no_group_available',
  NO_GROUP_IN_CITY: 'no_group_in_city',
  GROUP_FULL: 'group_full',
  CANDIDATE_NOT_FRIEND: 'candidate_not_friend',
  API_REJECTED: 'api_rejected',
  API_FAILED: 'api_failed',
  RESULT_UNKNOWN: 'result_unknown',
} as const;
export type GroupInviteFailureReason =
  (typeof GROUP_INVITE_FAILURE_REASON)[keyof typeof GROUP_INVITE_FAILURE_REASON];

export const GROUP_INVITE_DELIVERY = {
  DIRECT_ADD: 'direct_add',
  INVITE_CARD: 'invite_card',
} as const;
export type GroupInviteDelivery =
  (typeof GROUP_INVITE_DELIVERY)[keyof typeof GROUP_INVITE_DELIVERY];
export const GROUP_INVITE_SELECTION = {
  LOWEST_MEMBER_COUNT: 'lowest_member_count',
  ONLY_OPTION: 'only_option',
} as const;
export type GroupInviteSelection =
  (typeof GROUP_INVITE_SELECTION)[keyof typeof GROUP_INVITE_SELECTION];
