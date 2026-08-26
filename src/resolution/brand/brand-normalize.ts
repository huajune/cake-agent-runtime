/**
 * 品牌文本归一化原语 —— 全库唯一实现（§1 单一居所）。
 *
 * 迁移自旧规则轨（行为一致）：
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
 * 阿拉伯数字 → 汉字数词的逐位折叠表。
 *
 * 0 映射到「零」而非「〇」：〇(U+3007) 不在归一化白名单的 一-龥(U+4E00-U+9FA5) 区间内，
 * 用它会被 strip 直接删掉，反而制造新的词形塌缩。
 *
 * ⚠️ **不得并入 normalizeForBrandMatch**：全局折叠会让手机号、时间段和门牌号
 * 绕过数字上下文拦截，误命中纯数字品牌别名。只允许在**两侧都已是品牌名**
 * 的比较点上按需折叠。
 */
export const DIGIT_TO_CJK_NUMERAL: Record<string, string> = {
  '0': '零',
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '七',
  '8': '八',
  '9': '九',
};

/**
 * 归一化：全半角折叠（NFKC）→ 小写 → 去掉非中英数字符。
 *
 * NFKC 折叠用于全半角统一。否则全角数字会被白名单过滤删除，
 * 使「６姐」之类别名塌缩成高假阳的超短词形。
 *
 * 刻意**不做**数字↔汉字数词折叠，原因见 DIGIT_TO_CJK_NUMERAL 的注释。
 */
export function normalizeForBrandMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]/g, '');
}

/**
 * 品牌名之间比对专用的数字折叠：在 normalizeForBrandMatch 之上再把阿拉伯数字
 * 逐位折成汉字数词，用于**两侧都已确定是品牌名**的等值/包含比较。
 *
 * 例如工具事实为「成都你六姐」、回复为「你6姐」时，该折叠可避免
 * 品牌目录对账把数字写法差异误判为不同品牌。
 *
 * 逐位折叠（6→六）而非按数值折叠（10→十）：逐位 1:1 保持长度，不影响短别名门槛；
 * 按数值折叠会引入 10→十/一零 的歧义并可能错误并档。宁可漏合（「10足」匹配不上
 * 「十足」）也不错合。
 *
 * ⚠️ 只能用在品牌名对品牌名的比较上。用在候选人自由文本上会击穿数字上下文拦截器
 * （手机号 / 时间段 / 门牌号），详见 DIGIT_TO_CJK_NUMERAL 注释。
 */
export function normalizeBrandNameForComparison(value: string | null | undefined): string {
  return normalizeForBrandMatch(value).replace(
    /[0-9]/g,
    (digit) => DIGIT_TO_CJK_NUMERAL[digit] ?? digit,
  );
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
