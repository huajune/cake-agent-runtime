/** 岗位福利档位的跨域契约；tools 负责计算，memory 只存同一枚举。 */
export const WELFARE_KINDS = ['company', 'allowance', 'self_or_none', 'unspecified'] as const;
export type WelfareKind = (typeof WELFARE_KINDS)[number];
