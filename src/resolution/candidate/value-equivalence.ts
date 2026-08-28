import type { CandidateFactField } from './types';

const HEALTH_CERT_LABELS: Record<number, string> = {
  1: '有',
  2: '无但接受办理健康证',
  3: '无且不接受办理健康证',
};

/** 把候选人字段值折叠为跨表示形态可比较的文本。 */
export function normalizeCandidateFieldValue(field: CandidateFactField, value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim().toLowerCase().replace(/\s+/g, '');
  switch (field) {
    case 'phone':
      return text.replace(/\D/g, '');
    case 'height':
      return text.replace(/cm|厘米/g, '').replace(/\.0+$/, '');
    case 'weight':
      return text.replace(/kg|公斤|千克/g, '').replace(/\.0+$/, '');
    case 'householdProvince':
      return text.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省$|市$/g, '');
    case 'education':
      return /中专|技校|职高/.test(text) ? '中专技校职高' : text;
    case 'age':
      return text.replace(/岁$/, '');
    case 'gender': {
      if (text === '1' || /^男/.test(text)) return '男';
      if (text === '2' || /^女/.test(text)) return '女';
      return text;
    }
    case 'healthCertificate': {
      const asNumber = Number(text);
      if (HEALTH_CERT_LABELS[asNumber]) return HEALTH_CERT_LABELS[asNumber];
      if (/无.*不接受|不办|不接受办理/.test(text)) return HEALTH_CERT_LABELS[3];
      if (/无.*接受|可以办|愿意办|没有但/.test(text)) return HEALTH_CERT_LABELS[2];
      if (/^有|办了|办好/.test(text)) return HEALTH_CERT_LABELS[1];
      return text;
    }
    case 'isStudent':
      if (/^(true|是|学生|1)$/.test(text)) return 'true';
      if (/^(false|否|社会人士|社会人|不是学生|0)$/.test(text)) return 'false';
      return text;
    case 'name':
      return text;
  }
}

/** 同字段两值是否等价（"163cm"≡163、"安徽省"≡"安徽"、2≡"女"）。 */
export function candidateValuesEquivalent(
  field: CandidateFactField,
  a: unknown,
  b: unknown,
): boolean {
  const left = normalizeCandidateFieldValue(field, a);
  const right = normalizeCandidateFieldValue(field, b);
  return left !== '' && left === right;
}
