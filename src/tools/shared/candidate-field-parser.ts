/**
 * HC-2：候选人原文确定性解析（user_text provenance）。
 *
 * 把候选人**本轮原文**里能确定性抽取的字段（真名/手机/年龄/性别/户籍/健康证/学历/身高体重）
 * 解析成带 provenance 的权威字段，供 BookingGuard 准入判定。准入白名单只认 `user_text`
 * 与 `booking_writeback`——模型工具参数（model_arg）/ LLM 抽取（llm_extract）仅作草稿，
 * 不据此放行 booking（见 [agent-reliability-hc-runtime-mechanisms.md] §HC-2）。
 *
 * 设计原则：
 * - 只做**确定性**解析（regex/枚举词典），判不出就不写，绝不猜。
 * - 复用现成 name-guard 的真名校验（排昵称/"我是X"打招呼语）。
 * - normalizer 对齐 Sponge 契约（性别 1/2、健康证 1/2/3、户籍/学历数字 ID），
 *   保证 booking `allow` 分支能据此构造真实 payload。
 */

import { extractAutoGreetingName, isStrictRealChineseName } from '@memory/facts/name-guard';
import type {
  CandidateFieldKey,
  CollectedField,
  FieldProvenance,
} from '@memory/types/authoritative-session-state.types';
import {
  findSpongeEducationIdByLabel,
  findSpongeProvinceIdByName,
  SPONGE_HEALTH_CERTIFICATE_MAPPING,
} from '@sponge/sponge.enums';

/** booking 准入白名单：只有这些来源的字段才算"候选人已提供"。 */
export const AUTHORITATIVE_PROVENANCE: ReadonlySet<FieldProvenance> = new Set<FieldProvenance>([
  'user_text',
  'booking_writeback',
]);

export function isFieldAuthoritative(field?: CollectedField): boolean {
  return !!field && AUTHORITATIVE_PROVENANCE.has(field.provenance);
}

/** 剥离短期记忆注入的时间后缀（与 name-guard 保持一致）。 */
const TIME_CONTEXT_SUFFIX_REGEX = /\n\[消息发送时间：[^\]]*\]\s*$/u;

function clean(message: string): string {
  return message.replace(TIME_CONTEXT_SUFFIX_REGEX, '');
}

// ==================== 单字段解析（返回归一值或 null） ====================

/** 11 位手机号（国内号段）。取首个匹配。 */
export function parsePhone(text: string): string | null {
  const match = /(?<!\d)(1[3-9]\d{9})(?!\d)/.exec(text);
  return match ? match[1] : null;
}

/**
 * 年龄：优先 "年龄[：:] N" 键值对，其次 "N 岁"。14-70 合理区间外丢弃。
 */
export function parseAge(text: string): number | null {
  const keyed = /年龄\s*[：:]?\s*(\d{1,2})/.exec(text);
  const aged = /(\d{1,2})\s*岁/.exec(text);
  const raw = keyed?.[1] ?? aged?.[1];
  if (!raw) return null;
  const age = Number(raw);
  if (!Number.isFinite(age) || age < 14 || age > 70) return null;
  return age;
}

/**
 * 性别：只从明确表述抽取（性别键值对 / "我是男/女(的)" / "(男/女)生"），
 * 避免误抓"男装/女装门店"等无关词。
 */
export function parseGender(text: string): '男' | '女' | null {
  const m =
    /性别\s*[：:]?\s*(男|女)/.exec(text) ??
    /我是(男|女)(?:生|的)?/.exec(text) ??
    /(男|女)(?:生|士)/.exec(text);
  return (m?.[1] as '男' | '女' | undefined) ?? null;
}

/**
 * 户籍省：需 户籍/籍贯/老家 上下文锚点，再用 Sponge 省名词典匹配后续文本。
 * 返回标准省名（normalizer 再转 ID），匹配不到返回 null。
 */
export function parseHouseholdProvince(text: string): string | null {
  const m = /(?:户籍|籍贯|老家|户口)\s*(?:是|在|为|地?[：:])?\s*([一-龥]{2,8})/.exec(text);
  if (!m) return null;
  // 取锚点后最长可命中的省名（findSpongeProvinceIdByName 内部做后缀归一）
  const tail = m[1];
  for (let len = Math.min(tail.length, 8); len >= 2; len -= 1) {
    const candidate = tail.slice(0, len);
    if (findSpongeProvinceIdByName(candidate) != null) return candidate;
  }
  return null;
}

/**
 * 健康证：映射到 Sponge 1/2/3。
 * - 有/已办 → 1
 * - 无/没有 + 愿意/可以办 → 2
 * - 无/没有 + 不办/不愿意 → 3
 * - 仅"没有/无"（未表态办理）→ 2（默认接受办理，保守取可推进档）
 */
export function parseHealthCert(text: string): 1 | 2 | 3 | null {
  if (!/健康证/.test(text)) return null;
  const hasPositive =
    /(有|办了|办好|办过|已办)[^，。,.!！?？\n]{0,4}健康证|健康证[^，。,.!！?？\n]{0,4}(有|办好|办了)/.test(
      text,
    );
  const hasNegative =
    /(没有|无|还没|未办|没办)[^，。,.!！?？\n]{0,4}健康证|健康证[^，。,.!！?？\n]{0,4}(没有|没办|未办)/.test(
      text,
    );
  if (hasNegative) {
    if (/不(愿意|想|办|考虑)/.test(text)) return 3;
    return 2;
  }
  if (hasPositive) return 1;
  return null;
}

const EDUCATION_KEYWORDS: Array<[RegExp, string]> = [
  [/博士/, '博士'],
  [/硕士|研究生/, '硕士'],
  [/本科|大学本科/, '本科'],
  [/大专|专科|高职/, '大专'],
  [/中专|技校|职高/, '中专技校职高'],
  [/高中/, '高中'],
  [/初中/, '初中'],
];

/** 学历：自由文本 → Sponge 标准学历标签（normalizer 再转 educationId）。 */
export function parseEducation(text: string): string | null {
  for (const [regex, label] of EDUCATION_KEYWORDS) {
    if (regex.test(text)) return label;
  }
  return null;
}

/**
 * 真名：结构化 "姓名[：:] X" 或 "我叫 X"，经严格中文真名校验，排昵称/打招呼语。
 */
export function parseName(text: string): string | null {
  const cleaned = clean(text);
  const structured = /(?:姓名|名字)\s*[：:\s]\s*([^\s。，,！!？?\n]+)/u.exec(cleaned);
  const declared = /我叫\s*([^\s。，,！!？?\n]+)/u.exec(cleaned);
  const candidate = (structured?.[1] ?? declared?.[1])?.trim();
  if (!candidate) return null;
  // "我是X" 打招呼语里的昵称不算真名
  if (extractAutoGreetingName(cleaned) === candidate) return null;
  if (!isStrictRealChineseName(candidate)) return null;
  return candidate;
}

export function parseHeight(text: string): number | null {
  const m = /身高\s*[：:]?\s*(\d{2,3})/.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 100 && v <= 250 ? v : null;
}

export function parseWeight(text: string): number | null {
  const m = /体重\s*[：:]?\s*(\d{2,3})/.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 30 && v <= 200 ? v : null;
}

// ==================== normalizer（值 → Sponge booking arg ID） ====================

export function normalizeGenderToId(value: string): 1 | 2 | null {
  if (value === '男') return 1;
  if (value === '女') return 2;
  return null;
}

export function normalizeHealthCertToId(value: string | number): 1 | 2 | 3 | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (num === 1 || num === 2 || num === 3) return num;
  // 文本兜底：直接对齐 Sponge 标签
  for (const [id, label] of Object.entries(SPONGE_HEALTH_CERTIFICATE_MAPPING)) {
    if (label === value) return Number(id) as 1 | 2 | 3;
  }
  return null;
}

export function normalizeProvinceToId(value: string): number | null {
  return findSpongeProvinceIdByName(value);
}

export function normalizeEducationToId(value: string): number | null {
  return findSpongeEducationIdByLabel(value);
}

// ==================== 聚合：原文 → 权威字段 ====================

/**
 * 把候选人本轮**全部原文**确定性解析成权威字段（provenance=user_text）。
 *
 * @param userMessages 本轮候选人原文（可多条，合并解析）
 * @param at 解析时间戳（毫秒）；调用方传入，便于测试与确定性
 */
export function parseCandidateFieldsFromText(
  userMessages: readonly string[],
  at: number,
): Partial<Record<CandidateFieldKey, CollectedField>> {
  const text = userMessages.map(clean).join('\n');
  const fields: Partial<Record<CandidateFieldKey, CollectedField>> = {};

  const put = <T>(key: CandidateFieldKey, value: T | null, evidence: string): void => {
    if (value === null || value === undefined) return;
    (fields as Record<string, CollectedField>)[key] = {
      value: value as never,
      provenance: 'user_text',
      evidence,
      at,
    };
  };

  put('name', parseName(text), '原文结构化姓名/我叫');
  put('phone', parsePhone(text), '11位手机号');
  put('age', parseAge(text), '年龄数字');
  put('gender', parseGender(text), '性别表述');
  put('householdProvince', parseHouseholdProvince(text), '户籍省名');
  put('healthCert', parseHealthCert(text), '健康证表述');
  put('education', parseEducation(text), '学历关键词');
  put('height', parseHeight(text), '身高');
  put('weight', parseWeight(text), '体重');

  return fields;
}
