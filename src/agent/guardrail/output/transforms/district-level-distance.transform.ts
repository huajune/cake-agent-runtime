import type { OutputRuleTransform } from './output-transform.types';

const PRECISE_DISTANCE_PATTERN = /(\d+(?:\.\d+)?)\s*(?:km|公里|千米)/gi;

export const districtLevelDistanceTransform: OutputRuleTransform = {
  ruleId: 'district_level_distance_claim',
  apply(text: string): string | null {
    PRECISE_DISTANCE_PATTERN.lastIndex = 0;
    if (!PRECISE_DISTANCE_PATTERN.test(text)) return null;
    PRECISE_DISTANCE_PATTERN.lastIndex = 0;
    return text.replace(PRECISE_DISTANCE_PATTERN, (_match, value: string) => {
      const distance = Number.parseFloat(value);
      if (!Number.isFinite(distance)) return _match as string;
      return `约${Math.round(distance)}公里（按区域位置大概估算的）`;
    });
  },
};
