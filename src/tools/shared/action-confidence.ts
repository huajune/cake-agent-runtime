import { factConfidenceRank } from '@memory/confidence-rank';
import type { SessionFactConfidence } from '@memory/short-term/short-term.types';

/** ④使用层唯一的置信消费权限表：哪个动作要求档案值至少什么档。加动作必须在此表态。 */
export const ACTION_MIN_CONFIDENCE = {
  /** 拉群门读 sessionCity（invite-to-group）。 */
  invite_city: 'high',
  /** 发门店定位时采信 geocode 候选（send-store-location；precision 条件留调用点，非置信语义）。 */
  store_location_geocode: 'high',
} as const satisfies Record<string, SessionFactConfidence>;

export type ConfidenceGatedAction = keyof typeof ACTION_MIN_CONFIDENCE;

/** 当前事实是否达到指定动作的最低置信档。 */
export function canUseFactForAction(action: ConfidenceGatedAction, confidence: string): boolean {
  return factConfidenceRank(confidence) >= factConfidenceRank(ACTION_MIN_CONFIDENCE[action]);
}
