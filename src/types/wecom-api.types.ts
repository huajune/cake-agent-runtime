/** Frozen channel routing identity; shared by inbound, tools and reply recovery. */
export const WECOM_API_TYPE = { ENTERPRISE: 'enterprise', GROUP: 'group' } as const;
export type WecomApiType = (typeof WECOM_API_TYPE)[keyof typeof WECOM_API_TYPE];
