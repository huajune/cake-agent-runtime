export const PERMITTED_ACTION = { REPLY: 'reply', PROACTIVE: 'proactive', TOOL: 'tool' } as const;
export type PermittedAction = (typeof PERMITTED_ACTION)[keyof typeof PERMITTED_ACTION];

export const ACTION_DENIAL_REASON = {
  GLOBAL_DISABLED: 'global_disabled',
  HOSTING_PAUSED: 'hosting_paused',
  CANDIDATE_BLACKLISTED: 'candidate_blacklisted',
  GROUP_BLACKLISTED: 'group_blacklisted',
  RECEIVING_BOT_NOT_HOSTED: 'receiving_bot_not_hosted',
  PERMIT_UNAVAILABLE: 'permit_unavailable',
} as const;
export type ActionDenialReason = (typeof ACTION_DENIAL_REASON)[keyof typeof ACTION_DENIAL_REASON];
