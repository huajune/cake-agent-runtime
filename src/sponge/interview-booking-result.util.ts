import type { DuplicateSignupReason } from './sponge.types';
import { DUPLICATE_SIGNUP_REASON } from '@sponge/sponge.types';

/** 仅识别已核实的海绵业务原文；未知文案仍按原失败路径处理。 */
export function classifyDuplicateSignup(
  message: string | undefined,
): DuplicateSignupReason | undefined {
  switch (message?.trim()) {
    case '用户已报名该岗位或品牌':
      return DUPLICATE_SIGNUP_REASON.ALREADY_REGISTERED;
    case '用户已报名该品牌！请联系独立日工作人员，确定候选人归属':
      return DUPLICATE_SIGNUP_REASON.OWNERSHIP_REVIEW;
    default:
      return undefined;
  }
}
