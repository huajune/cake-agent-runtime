import { sanitizeBrandName } from '@tools/utils/sanitize-brand-name.util';
import type { OutputRuleTransform } from './output-transform.types';

export const brandNameTransform: OutputRuleTransform = {
  ruleId: 'brand_name_violation',
  apply(text: string): string | null {
    const sanitized = sanitizeBrandName(text);
    return sanitized === text ? null : sanitized;
  },
};
