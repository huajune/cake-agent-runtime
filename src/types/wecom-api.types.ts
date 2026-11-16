/** Frozen channel routing identity; shared by inbound, tools and reply recovery. */
export const WECOM_API_TYPE = { ENTERPRISE: 'enterprise', GROUP: 'group' } as const;
export type WecomApiType = (typeof WECOM_API_TYPE)[keyof typeof WECOM_API_TYPE];

/** Stride /api/v1/bot/getGroupBots 的账号状态；未知值不得视为在线。 */
export const WECOM_BOT_STATUS = {
  OFFLINE: 1,
  ONLINE: 2,
  WRONG_ACCOUNT: 3,
  ERROR_LOGOUT: 4,
  NOT_TRUSTEESHIP: 5,
} as const;

/** Stride 发送接口明确拒收；其余业务错误不能据此推断可续发。 */
export const WECOM_SEND_ERROR_CODE = { HOSTING_UNAVAILABLE: 400101 } as const;
export const WECOM_SEND_FAILURE_REASON = { HOSTING_UNAVAILABLE: 'hosting_unavailable' } as const;
export type WecomSendFailureReason =
  (typeof WECOM_SEND_FAILURE_REASON)[keyof typeof WECOM_SEND_FAILURE_REASON];
