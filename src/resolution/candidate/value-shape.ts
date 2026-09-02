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
import { normalizeGenderValue } from '@resolution/candidate/gender';
import { normalizeWeightToKg } from '@resolution/candidate/height-weight';
import { isPlaceholderPhone, isStorableCandidatePhone } from '@resolution/candidate/phone';
import { isPlausibleAgeValue } from '@resolution/candidate/age';
import { hasHonorificSuffix, isDigitsOnlyName } from '@resolution/candidate/name';
import type { CandidateFactField } from './types';
import { normalizeCandidateFieldValue } from './value-equivalence';

/**
 * 候选人字段归一化器（方案 §5.2「可安全归一化字段」+ §12 条目 4）。
 *
 * 两类职责：
 * 1. `deriveFieldValueFromQuote`：从候选人原话片段确定性取值，**producer 侧**用
 *    （字段提案、session 的出处声明升级）。在键值对解析之上补充口语化
 *    表达（"一米六三""九十二斤""03年的"）的白名单换算。
 *    ⚠️ 它**不再是裁决器的验证器**：公证器不复算值（宪法 P11，见 ./notary.ts）；
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
 * "03年的"/"95年"/"1993年" → 年龄（按当前年份推算周岁近似值）。
 * 出生年表达是年龄的白名单语义映射（方案 §1："我 03 年的"不是 3 岁）。
 *
 * 裸年份（无 `的/生/出生` 后缀）必须收：候选人常直接报「93年」。但它与**时长**同形
 * （「做了10年」「12年经验」），带时长语境时一律不认。封闭词表拦的是已知会撞车的形状，
 * 不是定义"什么算年龄"——收窄用词表安全，放宽用词表危险。
 */
const BIRTH_YEAR_DURATION_BEFORE = /(?:干|做|工作|从业|待|呆|上班|满|近|约|大概)\s*了?\s*$/u;
const BIRTH_YEAR_DURATION_AFTER = /^\s*(?:经验|工龄|以上|左右|多)/u;

export function parseBirthYearAge(text: string, now: Date): number | null {
  for (const match of text.matchAll(/((?:19|20)?\d{2})\s*年(的|生|出生)?/gu)) {
    const [whole, digits, suffix] = match;
    const start = match.index ?? 0;
    // 前一个字符是数字说明这是更长数字串的尾巴（如手机号里截出的两位），不是年份。
    if (start > 0 && /\d/u.test(text[start - 1])) continue;
    if (!suffix) {
      const before = text.slice(Math.max(0, start - 6), start);
      const after = text.slice(start + whole.length, start + whole.length + 4);
      if (BIRTH_YEAR_DURATION_BEFORE.test(before) || BIRTH_YEAR_DURATION_AFTER.test(after)) {
        continue;
      }
    }
    let year = Number(digits);
    if (year < 100) year += year <= now.getFullYear() % 100 ? 2000 : 1900;
    const age = now.getFullYear() - year;
    if (age >= 14 && age <= 70) return age;
  }
  return null;
}

// ==================== 字段级推导（quote → 值） ====================

/**
 * 从候选人原话片段确定性取值。返回 null = 这段话取不出该字段。
 * 严格身份字段（name/phone）只走结构化解析，不提供口语化兜底。
 */
export function deriveFieldValueFromQuote(
  field: CandidateFactField,
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

/**
 * 数值类字段的落库规范形（封闭形态换算，不含任何"这段话在说什么"的语言判断）：
 * - age：去"岁/周岁"，必须是 14–70 的整数；"75年""差不多50"这类不是年龄形态 → null；
 * - height：去 cm/厘米/公分，或"1米75"口语，100–250；
 * - weight：去 kg/公斤/千克；带"斤"或裸数 ≥100 按斤减半（口径见 normalizeWeightToKg），30–200；
 * - 其余字段：去首尾空白原样返回；空串 → null。
 *
 * 返回 null 表示该值没有合法形态，调用方按"形态非法"处理；表单写槽与长期档案读边界
 * 共用本函数，保证同一个值在两处落成同一个形。
 */
export function canonicalizeCandidateFieldValue(
  field: CandidateFactField,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const compact = text.replace(/\s+/g, '').toLowerCase();
  switch (field) {
    case 'age': {
      const digits = compact.replace(/周?岁$/u, '');
      return /^\d{1,2}$/.test(digits) && isPlausibleAgeValue(digits)
        ? String(Number(digits))
        : null;
    }
    case 'height': {
      const m = /^(\d{2,3}(?:\.\d+)?)(?:cm|厘米|公分)?$/u.exec(compact);
      const cm = m ? Math.round(Number(m[1])) : parseSpokenHeightCm(compact);
      return cm !== null && cm >= 100 && cm <= 250 ? String(cm) : null;
    }
    case 'weight': {
      const m = /^(\d{2,3}(?:\.\d+)?)(kg|公斤|千克|斤)?$/u.exec(compact);
      const kg = m
        ? normalizeWeightToKg(Math.round(Number(m[1])), m[2])
        : parseSpokenWeightKg(compact);
      return kg !== null && kg >= 30 && kg <= 200 ? String(kg) : null;
    }
    default:
      return text;
  }
}

/**
 * 值形状合法性——公证第二问的唯一判据。判的是值本身的形态（可枚举、不随语言分布
 * 漂移），这是解析器转岗后保留下来的合法权力。
 *
 * 纪律：只准加**封闭形态**判据。"这段话像不像在说这个值"属开放语言裁决，宪法 P11
 * 明令确定性代码在裁决点无此权力（review 直接打回）。
 */
export function isValidCandidateFieldShape(field: CandidateFactField, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  switch (field) {
    case 'phone':
      // 占位号族（11111111111 / 13800138000）形态合规但一定不是真号，进真实工单
      // 前的最后一道形态检查（gu2kra6p 族）。
      return isStorableCandidatePhone(text) && !isPlaceholderPhone(text);
    case 'age':
    case 'height':
    case 'weight':
      return canonicalizeCandidateFieldValue(field, value) !== null;
    case 'gender':
      // 性别只有男/女两个合法形态（含 1/2、male/female、"女生"类写法）；其余一律非法。
      return normalizeGenderValue(text) !== null;
    case 'name':
      // 纯数字姓名（手机号错填）与称谓后缀都与长度/标点判据同族，统一收在这里。
      return (
        text.length >= 2 &&
        text.length <= 6 &&
        !/[\d\s。，,？?！!]/.test(text) &&
        !isDigitsOnlyName(text) &&
        !hasHonorificSuffix(text)
      );
    case 'isStudent':
      return (
        normalizeCandidateFieldValue(field, value) === 'true' ||
        normalizeCandidateFieldValue(field, value) === 'false'
      );
    default:
      return text.length <= 30;
  }
}
