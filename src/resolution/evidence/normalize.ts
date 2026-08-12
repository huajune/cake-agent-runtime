import {
  parseAge,
  parseEducation,
  parseGender,
  parseHealthCert,
  parseHeight,
  parseHouseholdProvince,
  parseName,
  parsePhone,
  parseWeight,
} from '@resolution/candidate';
import { classifyIdentityAnswerText } from '@resolution/candidate/student-identity';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import type { CandidateClaimField } from './claim.types';

/**
 * 证据包含匹配的字符级归一：NFKC 全半角折叠 + 去空白。
 *
 * 刻意**不折叠标点**（PR #1000 评审 P0-5）：标点承载否定分界——候选人说
 * 「不，是学生」，若折叠标点则伪造 quote「不是学生」也能命中原文，反臆造
 * 边界被击穿。标点容差只允许用于展示与同字段值等价比较（normalizeFieldText），
 * 不得用于 quote 收录判定。
 */
function normalizeEvidenceText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

export function normalizedIncludes(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeEvidenceText(needle);
  if (!normalizedNeedle) return false;
  return normalizeEvidenceText(haystack).includes(normalizedNeedle);
}

/**
 * experience 合成值的出处支持判定（PR #1000 评审 P0-3）。
 *
 * 抽取提示词要求模型把工作经历「合并为 公司+岗位+时长 短句」，合成值几乎不可能是
 * 单条消息的连续子串，逐字包含判据会把每一次首写都判无出处。这里改为确定性的
 * 字符二元组覆盖率：值的相邻字符对（去空白标点、NFKC 折叠后）须有 ≥60% 出现在
 * quote 中——重排/换连接词不影响命中，而与 quote 无关的臆造值覆盖率趋近 0。
 * 短值（<4 字符）二元组过少，退回逐字包含。
 */
export function experienceValueSupportedByQuote(quote: string, value: string): boolean {
  const foldNumerals = (text: string): string =>
    text.replace(/[一二两三四五六七八九]/gu, (ch) => String(CN_DIGIT[ch] ?? ch));
  const normalize = (text: string): string =>
    foldNumerals(text.normalize('NFKC').replace(/[\s\p{P}]+/gu, ''));
  const normalizedValue = normalize(value);
  const normalizedQuote = normalize(quote);
  if (!normalizedValue || !normalizedQuote) return false;
  if (normalizedQuote.includes(normalizedValue)) return true;
  if (normalizedValue.length < 4) return false;
  const bigrams = new Set<string>();
  for (let i = 0; i < normalizedValue.length - 1; i++) {
    bigrams.add(normalizedValue.slice(i, i + 2));
  }
  let matched = 0;
  for (const bigram of bigrams) {
    if (normalizedQuote.includes(bigram)) matched += 1;
  }
  return matched / bigrams.size >= 0.6;
}

/**
 * 候选人字段归一化器（方案 §5.2「可安全归一化字段」+ §12 条目 4）。
 *
 * 两类职责：
 * 1. `deriveFieldValueFromQuote`：从候选人原话片段确定性推导字段值——裁决器
 *    验证 claim 的核心（模型声明的值必须能被这段原话支持）。在
 *    candidate-field-parser 的键值对解析之上，补充口语化表达（"一米六三"
 *    "九十二斤""03年的"）的白名单换算，让模型的合理语义理解可以被确定性复核。
 * 2. `candidateValuesEquivalent`：跨表示形态的等价比较（"163cm"≡163、
 *    "安徽省"≡"安徽"），供裁决器判断规则/模型双 claim 是否同值、booking
 *    payload 是否偏离快照。口径对齐 booking 侧 normalizeBookingAuthorityValue，
 *    但实现放在 memory 层避免依赖工具内部函数。
 *
 * 纪律：全部纯函数、零 LLM；推导不出就返回 null，绝不猜。
 */

// ==================== 中文数字与口语化表达 ====================

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 解析 0-99 的中文数字（"六三"逐位、"六十三"进位、"十"系列）。 */
export function parseChineseNumberUnder100(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d{1,2}$/.test(trimmed)) return Number(trimmed);

  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(trimmed);
  if (tens) {
    const ten = tens[1] ? CN_DIGIT[tens[1]] : 1;
    const unit = tens[2] ? CN_DIGIT[tens[2]] : 0;
    return ten * 10 + unit;
  }

  // 逐位读法（"六三" → 63），常见于身高口语"一米六三"
  if (/^[零一二两三四五六七八九]{1,2}$/u.test(trimmed)) {
    let value = 0;
    for (const ch of trimmed) value = value * 10 + CN_DIGIT[ch];
    return value;
  }
  return null;
}

/** "一米六三"/"1米75"/"一米七" → 身高 cm；解析不出返回 null。 */
export function parseSpokenHeightCm(text: string): number | null {
  const m = /([一1])\s*米\s*([零一二两三四五六七八九\d]{1,2})/u.exec(text);
  if (!m) return null;
  const decimals = parseChineseNumberUnder100(m[2]);
  if (decimals === null) return null;
  // "一米七" → 170；"一米六三" → 163
  const cm = decimals < 10 ? 100 + decimals * 10 : 100 + decimals;
  return cm >= 100 && cm <= 250 ? cm : null;
}

/** "九十二斤"/"92斤" → 体重 kg（斤→kg 减半，四舍五入）；"60公斤/60kg" 直读。 */
export function parseSpokenWeightKg(text: string): number | null {
  const jin = /([零一二两三四五六七八九十\d]{1,3})\s*斤/u.exec(text);
  if (jin) {
    const raw = /^\d+$/.test(jin[1]) ? Number(jin[1]) : parseChineseNumberUnder100(jin[1]);
    if (raw === null) return null;
    const kg = Math.round(raw / 2);
    return kg >= 30 && kg <= 200 ? kg : null;
  }
  const kgMatch = /(\d{2,3})\s*(?:kg|公斤|千克)/iu.exec(text);
  if (kgMatch) {
    const kg = Number(kgMatch[1]);
    return kg >= 30 && kg <= 200 ? kg : null;
  }
  return null;
}

/**
 * "03年的"/"95年" → 年龄（按当前年份推算周岁近似值）。
 * 出生年表达是年龄的白名单语义映射（方案 §1："我 03 年的"不是 3 岁）。
 */
export function parseBirthYearAge(text: string, now: Date): number | null {
  const m = /(?:^|[^\d])((?:19|20)?\d{2})\s*年(?:的|生|出生)/u.exec(text);
  if (!m) return null;
  let year = Number(m[1]);
  if (year < 100) year += year <= now.getFullYear() % 100 ? 2000 : 1900;
  const age = now.getFullYear() - year;
  return age >= 14 && age <= 70 ? age : null;
}

// ==================== 字段级推导（quote → 值） ====================

/**
 * 从候选人原话片段确定性推导字段值。返回 null = 这段话推不出该字段。
 *
 * 严格身份字段（name/phone）只走结构化解析——"自由推导"被字段策略层拒绝，
 * 这里不为它们提供口语化兜底。
 */
export function deriveFieldValueFromQuote(
  field: CandidateClaimField,
  quote: string,
  now: Date = new Date(),
): string | number | boolean | null {
  const text = quote.trim();
  if (!text) return null;
  switch (field) {
    case 'name':
      return parseName(text)?.value ?? null;
    case 'phone':
      return parsePhone(text)?.value ?? null;
    case 'gender':
      return parseGender(text)?.value ?? null;
    case 'age':
      return parseAge(text)?.value ?? parseBirthYearAge(text, now);
    case 'isStudent': {
      const identity = classifyIdentityAnswerText(text);
      return identity === null ? null : identity === '学生';
    }
    case 'education':
      return parseEducation(text)?.value ?? null;
    case 'healthCertificate':
      return parseHealthCert(text)?.value ?? null;
    case 'height':
      return parseHeight(text)?.value ?? parseSpokenHeightCm(text);
    case 'weight':
      return parseWeight(text)?.value ?? parseSpokenWeightKg(text);
    case 'householdProvince':
      return parseHouseholdProvince(text)?.value ?? null;
  }
}

// ==================== 等价比较（跨表示形态） ====================

const HEALTH_CERT_LABELS: Record<number, string> = {
  1: '有',
  2: '无但接受办理健康证',
  3: '无且不接受办理健康证',
};

function normalizeFieldText(field: CandidateClaimField, value: unknown): string {
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
    case 'isStudent': {
      if (/^(true|是|学生|1)$/.test(text)) return 'true';
      if (/^(false|否|社会人士|社会人|不是学生|0)$/.test(text)) return 'false';
      return text;
    }
    case 'name':
      return text;
  }
}

/** 同字段两值是否等价（"163cm"≡163、"安徽省"≡"安徽"、2≡"女"）。 */
export function candidateValuesEquivalent(
  field: CandidateClaimField,
  a: unknown,
  b: unknown,
): boolean {
  const left = normalizeFieldText(field, a);
  const right = normalizeFieldText(field, b);
  return left !== '' && left === right;
}

/** 值形状合法性（裁决前的最后防线，防"整句话当值"类污染）。 */
export function isValidCandidateFieldShape(field: CandidateClaimField, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  switch (field) {
    case 'phone':
      return isStorableCandidatePhone(text);
    case 'age': {
      const age = Number(text.replace(/岁$/, ''));
      return Number.isInteger(age) && age >= 14 && age <= 70;
    }
    case 'height': {
      const height = Number(normalizeFieldText(field, value));
      return Number.isFinite(height) && height >= 100 && height <= 250;
    }
    case 'weight': {
      const weight = Number(normalizeFieldText(field, value));
      return Number.isFinite(weight) && weight >= 30 && weight <= 200;
    }
    case 'name':
      return text.length >= 2 && text.length <= 6 && !/[\d\s。，,？?！!]/.test(text);
    case 'isStudent':
      return (
        normalizeFieldText(field, value) === 'true' || normalizeFieldText(field, value) === 'false'
      );
    default:
      return text.length <= 30;
  }
}
