/**
 * LLM 品牌意图轨的确定性输入闸。
 *
 * extract_facts 的 brand_intents 契约要求 `brand` 字段是品牌名，但弱模型会把
 * 对话上下文里的整句话塞进来。整句经 resolveBrands 的包含匹配仍能过目录验证，
 * 造成两类"说话人不对"的状态污染（守卫式回声回路）：
 *
 * 1. **助手话术回声**：Agent 自己的找店话术被 LLM 当作候选人意向输出。
 * 2. **系统文本回流**：守卫 repair 反馈（"- [brand_alias_fuzzy_match_ignored] 问题：
 *    工具实际应用品牌为…"）被当候选人原话解析，形成"守卫抱怨品牌 → 品牌被重新
 *    种进状态"的自我强化回路。
 *
 * 两个判定都是纯函数：`produceValidatedBrandIntents` 持有对话上下文，命中即整条
 * 丢弃并由 memory 记录日志。裸品牌名/短指代不在拦截范围——指代链接
 * （"你刚才说的那家"→ 品牌名）是 LLM 轨的本职，不能因 Agent 提过该品牌就拦。
 */

/**
 * 整句形态门槛：brand 字段归一化后比命中词条长出这么多字符，才视为"整句"而非品牌名。
 * 裸品牌名与其命中词条等长（margin 0），带少量语气助词的短表达也远小于此值。
 */
const ECHO_SENTENCE_MARGIN = 4;

/**
 * 助手话术回声判定：brand 字段呈整句形态，且逐字出现在近程助手消息里。
 *
 * 两个条件缺一不可：只查子串会误伤指代链接产出的裸品牌名（Agent 推荐过的品牌
 * 必然出现在助手消息里）；只查长度会误伤候选人自己的长表达。
 */
export function isAssistantEchoUtterance(params: {
  /** LLM brand 字段的归一化形态（normalizeForBrandMatch）。 */
  normalizedBrandField: string;
  /** 该字段经目录解析后各命中词条的归一化形态。 */
  normalizedMatchedTexts: string[];
  /** 近程助手消息的归一化形态列表。 */
  normalizedAssistantTexts: string[];
}): boolean {
  const field = params.normalizedBrandField;
  if (!field) return false;
  const longestMatch = Math.max(0, ...params.normalizedMatchedTexts.map((t) => t.length));
  if (field.length < longestMatch + ECHO_SENTENCE_MARGIN) return false;
  return params.normalizedAssistantTexts.some((text) => text.includes(field));
}

/**
 * 系统文本回流特征（有限清单，对原始 brand 字段判定）：
 * 守卫档案条目前缀 / 规则 ID / 守卫反馈措辞。品牌名字段出现任何一种即非用户表达。
 */
const SYSTEM_TEXT_REFLOW_PATTERNS: RegExp[] = [
  /-\s*\[[a-z0-9_]+\]/i,
  /规则\s*id/i,
  /(?:问题|修复建议|工具实际应用品牌)\s*[：:]/,
];

/** 判定 LLM brand 字段是否为守卫/系统文本回流（说话人是系统，不是候选人）。 */
export function isSystemTextReflow(rawBrandField: string): boolean {
  return SYSTEM_TEXT_REFLOW_PATTERNS.some((pattern) => pattern.test(rawBrandField));
}
