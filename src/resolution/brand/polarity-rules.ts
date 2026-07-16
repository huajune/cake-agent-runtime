/**
 * 极性确定性规则轨（§6.3.1）—— 模式清单集中在此，一处维护。
 *
 * 覆盖的高置信模式（有限清单）：
 * - "品牌不限 / 什么品牌都行 / 品牌随便"        → browse_all
 * - "换个品牌 / 换一家 / 换个牌子"              → 品牌为空的 negative（指向当前主品牌，§9.3）
 * - 指示代词排斥 "这个不考虑 / 不要这个 / 这家算了" → 品牌为空的 negative
 * - "不要X / 除了X（都行/都可以）/ X不要 / X算了"  → 对已命中品牌 X 的 negative
 *
 * 其余表达变体与指代链接由 LLM 事实提取轨承担（extract_facts 扩展极性输出）；
 * 两轨对同一品牌冲突时显式否定规则优先。
 */

import type { BrandIntentPolarity } from './brand-resolution.types';

/** 全局品牌控制命中（不指向具体品牌）。 */
export interface GlobalBrandControl {
  polarity: Extract<BrandIntentPolarity, 'negative' | 'browse_all'>;
  matchedText: string;
}

/** browse_all：候选人明确取消品牌限制。裸"都行/随便"歧义太大，一律要求带"品牌/牌子"语境。 */
const BROWSE_ALL_PATTERNS: RegExp[] = [
  /品牌不限|不限品牌|不挑品牌|品牌都(?:行|可以|好|能)|品牌(?:随便|无所谓|没要求|不限制)/,
  /(?:什么|啥|哪个|随便什么)(?:品牌|牌子)都(?:行|可以|好|能)/,
];

/** 品牌为空的 negative："换个品牌"语义上就是排斥当前主品牌（§6.3 设计取舍）。 */
const SWITCH_BRAND_PATTERNS: RegExp[] = [/换个品牌|换一家|换个牌子|换别的品牌|换家品牌/];

/**
 * 指示代词排斥（§6.3.1 规则轨新增）：输出品牌为空的 negative。
 * 按 §9.3 执行顺序，同轮图片 positive 先立主品牌、空品牌 negative 再把它移入排斥，
 * "发截图 + 配文这个不考虑"这一最常见组合无需 LLM 轨即得到正确终态。
 */
const DEMONSTRATIVE_REJECTION_PATTERNS: RegExp[] = [
  /(?:这个|那个|这家|那家)(?:就|我)?(?:不考虑|不要了?|不去了?|不行|算了|就算了)/,
  /不要(?:这个|那个|这家|那家)/,
];

/** 检测整句中的全局品牌控制表达（browse_all / 品牌为空的 negative）。 */
export function detectGlobalBrandControls(text: string): GlobalBrandControl[] {
  const controls: GlobalBrandControl[] = [];
  for (const pattern of BROWSE_ALL_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      controls.push({ polarity: 'browse_all', matchedText: match[0] });
      break;
    }
  }
  for (const pattern of [...SWITCH_BRAND_PATTERNS, ...DEMONSTRATIVE_REJECTION_PATTERNS]) {
    const match = pattern.exec(text);
    if (match) {
      controls.push({ polarity: 'negative', matchedText: match[0] });
      break;
    }
  }
  return controls;
}

// ==================== 面向已命中品牌的否定判定 ====================

/**
 * 品牌前置否定词（作用于归一化子句里品牌片段之前的窗口）。
 * "要不要/去不去/想不想"是疑问式（查询即意向，positive），须先排除。
 */
const PRECEDING_NEGATION_TAIL = /(?:不要|不想去|不去|别推|排除|除了|不考虑)$/;
const PRECEDING_INTERROGATIVE_TAIL = /(?:要不要|去不去|想不想|做不做|干不干)$/;

/** 品牌后置否定头（作用于品牌片段之后的窗口）。 */
const FOLLOWING_NEGATION_HEAD = /^(?:就|也|都|我)?(?:不要了?|不去了?|不考虑|不行|算了|就算了)/;

/** “品牌不要人嘛 / 不招人吗”是在问招聘状态，不是表达品牌排斥。 */
const FOLLOWING_HIRING_QUESTION_HEAD =
  /^(?:(?:还)?要不要|(?:还)?要|不要|招不招|招|不招)(?:人|兼职|员工|店员|服务员|小时工)(?:吗|嘛|么|啊|呀|呢)?/;

/** 否定判定的观察窗口（归一化字符数）。 */
const NEGATION_WINDOW = 8;

/**
 * 判断归一化子句中 [spanStart, spanStart+spanLength) 的品牌片段是否处于否定语境。
 *
 * 子句必须已按标点切分（调用方职责），否则"肯德基不要，麦当劳可以"里前一子句的
 * "不要"会误伤后一品牌。
 */
export function isBrandSpanNegated(
  normalizedClause: string,
  spanStart: number,
  spanLength: number,
): boolean {
  const before = normalizedClause.slice(Math.max(0, spanStart - NEGATION_WINDOW), spanStart);
  if (PRECEDING_NEGATION_TAIL.test(before) && !PRECEDING_INTERROGATIVE_TAIL.test(before)) {
    return true;
  }
  const after = normalizedClause.slice(
    spanStart + spanLength,
    spanStart + spanLength + NEGATION_WINDOW,
  );
  if (FOLLOWING_HIRING_QUESTION_HEAD.test(after)) return false;
  return FOLLOWING_NEGATION_HEAD.test(after);
}

/**
 * 匹配前剥离极性控制词，让短别名的全等 token 匹配在否定句里也能露出品牌本体
 * （"不要全家" → "全家"）。只服务匹配通道，极性判定仍在原子句上进行。
 */
const POLARITY_CONTROL_STRIP_REGEX =
  /不要|不想去|不去|别推|排除|除了|不考虑|不行|就算了|算了|都可以|都行|都能/g;

export function stripPolarityControlWords(normalizedText: string): string {
  return normalizedText.replace(POLARITY_CONTROL_STRIP_REGEX, '');
}

/**
 * 子句切分：按中英文句读标点与换行切分，切出的每段是独立的极性判定单元。
 * 刻意不按空格与点号切——"M Stand" / "M.A.C" 这类品牌名会被拆散。
 */
export function splitClauses(text: string): string[] {
  return text
    .split(/[，。！？；;,!?\n\r、]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}
