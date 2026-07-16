/**
 * 品牌文本归一化原语 —— 全库唯一实现（§5.1 单一居所）。
 *
 * 迁移自 memory/facts/high-confidence-facts.ts（行为一致）：
 * - normalizeForBrandMatch：大小写/全半角/分隔符清洗（只为对比用，展示仍保留原文）
 * - BRAND_NOISE_PATTERNS + stripBrandNoisePatterns：剥离求职意图词与语气词
 * - buildExactMatchTokens：短别名全等匹配用的 token 集
 *
 * 任何模块不得再私有实现 normalize / includes 匹配；只允许 import 本文件。
 */

/**
 * 品牌匹配降噪词表：仅用于 buildExactMatchTokens 内的 stripBrandNoisePatterns，
 * 目的是从候选人消息中剥离求职意图词和语气词，留下纯品牌名。
 * 注意：其中也包含用工形式词，但不冲突——labor_form 意向解析跑在原始消息上，
 * 此清洗只在品牌匹配通道内生效。
 */
export const BRAND_NOISE_PATTERNS = [
  '我想找',
  '想找',
  '我想看',
  '想看',
  '我想问',
  '想问',
  '问下',
  '看下',
  '看看',
  '了解下',
  '咨询下',
  '求职',
  '找工作',
  '兼职',
  '全职',
  '小时工',
  '寒假工',
  '暑假工',
  '临时工',
  '岗位',
  '工作',
  '品牌',
  '门店',
  '店里',
  '店',
  '有没有',
  '有吗',
  '在招吗',
  '招吗',
  '吗',
  '呀',
  '呢',
  '哈',
  '哦',
  '啊',
] as const;

export const CONJUNCTION_SPLIT_REGEX = /(?:或者|和|跟|或|and|or)/;

/**
 * 归一化：全半角折叠（NFKC）→ 小写 → 去掉非中英数字符。
 *
 * NFKC 折叠是 §7.1「全半角统一」的实现——不做折叠时全角字符（"６姐"的"６"、
 * "７-１１"）会被白名单过滤直接删除，别名塌缩成超短词形：生产事故 2026-07-16
 * "６姐"塌缩成单字"姐"，候选人喊"姐，…"被批量误判成品牌意向（42+ 会话状态污染）。
 */
export function normalizeForBrandMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]/g, '');
}

export function stripBrandNoisePatterns(normalizedText: string): string {
  let output = normalizedText;
  for (const pattern of BRAND_NOISE_PATTERNS) {
    output = output.replace(new RegExp(pattern, 'g'), '');
  }
  return output;
}

/** 短别名全等匹配用的 token 集：整句归一化 + 降噪后残句 + 连词切分片段。 */
export function buildExactMatchTokens(message: string): string[] {
  const normalized = normalizeForBrandMatch(message);
  if (!normalized) return [];

  const stripped = stripBrandNoisePatterns(normalized);
  const tokens = new Set<string>();

  if (normalized) tokens.add(normalized);
  if (stripped) tokens.add(stripped);

  for (const token of stripped.split(CONJUNCTION_SPLIT_REGEX)) {
    if (token) tokens.add(token);
  }

  return Array.from(tokens).filter(Boolean);
}
