/**
 * 自然语言 → optionCode 的**确定性直配**（蓝图 §1）。
 *
 * 职责边界（刻意窄）：只回答"候选人这句话里有没有逐字点名某个契约选项"。点不出、
 * 或点出多个 → 返回 null，交模型作证选 optionCode，产物仍要过 `proposeValue` 的公证。
 * 「含糊 → null」不是能力不足，是分工：开放语言裁决属模型，确定性代码在裁决点无此权力
 * （宪法 P11）。
 *
 * **不做终答识别**（刻意缺席）：裸「是」「有」「可以」不在这里映射。它们能答健康证 /
 * 经验 / 时间 / 身份任意一问，脱离问句语境不指向任何字段——这正是公证短引文门
 * （`MIN_QUOTE_CONTEXT_CHARS`）在防的退化。要用终答绑定问句，走模型作证轨。
 *
 * 词表复用：本文件不新建任何业务词表，只做「契约给的 optionLabel」× 「候选人原话」的
 * 字符级比对；字段语义的词表全部留在既有解析器（`@resolution/candidate/*`）里，
 * 由 ./adapters/* 包装。
 */

import type { ContractFieldDef, ContractOption } from './form.types';

/** 否定前缀：紧邻选项标签之前出现即判该标签不成立（「我**没**有本地有效健康证」）。 */
const NEGATION_PREFIXES = ['不', '没', '无', '非', '未', '别'];

/** 疑问子句判据，与 `@resolution/candidate/gender` 同口径：问句不是回答。 */
const QUESTION_CLAUSE_RE = /[？?]\s*$|(?:吗|么|呢|吧)(?:[啊呀嘛])?(?:[！。])?\s*$/u;

const CLAUSE_SPLIT_RE = /(?<=[，,。;；！!？?\n\r])/u;

/** 选项标签里的分隔符（基线实测「中专\技校\职高」），比对前一律折掉。 */
const LABEL_SEPARATOR_RE = /[\\/、|]/gu;

export interface OptionMatch {
  option: ContractOption;
  /** 命中该选项的候选人原话子句——直接作为 `proposeValue` 的 sourceText。 */
  sourceText: string;
}

/**
 * 在候选人原话里直配契约选项。
 *
 * 判据链：
 * 1. 按子句切分，疑问子句整体不参与（「有本地健康证吗」不是"有证"）；连续的陈述子句
 *    **拼回原样再比对**——基线实测健康证三态标签自带逗号（「无本地有效健康证，接受办理」），
 *    只按子句比会把标签自己切两半，永远配不上；
 * 2. 在每段陈述里找**逐字出现**的 optionLabel（NFKC 折全半角、去空白、折 `\/、|` 分隔符）；
 * 3. 命中位置紧邻否定前缀的丢弃（「没有本地有效健康证」不是「有本地有效健康证」）；
 * 4. 长标签吃掉自己的子串标签（避免「无本地有效健康证，接受办理」被「本地有效健康证」截胡）；
 * 5. 最终仍剩多于一个不同选项 → null（歧义不猜）。
 */
export function matchOptionInText(field: ContractFieldDef, text: string): OptionMatch | null {
  const options = [...field.acceptedOptions, ...field.rejectedOptions];
  if (options.length === 0 || !text.trim()) return null;

  const hits = new Map<string, OptionMatch>();
  for (const segment of declarativeSegments(text)) {
    const normalizedSegment = normalizeForMatch(segment);
    for (const option of options) {
      const label = normalizeForMatch(option.optionLabel);
      if (!label) continue;
      if (!containsWithoutNegation(normalizedSegment, label)) continue;
      // 同 optionCode 多次命中只留第一段原话，sourceText 要短而准。
      if (!hits.has(option.optionCode)) {
        hits.set(option.optionCode, { option, sourceText: segment });
      }
    }
  }
  if (hits.size === 0) return null;

  const survivors = dropSubstringLabels([...hits.values()]);
  return survivors.length === 1 ? survivors[0] : null;
}

/**
 * 把原文切成"连续陈述段"：疑问子句作为分隔符把段落断开，段内子句原样拼回。
 * 拼回而不是逐子句比对，是因为选项标签自身可能含标点（基线实测健康证三态）。
 * 拼接用未 trim 的原始子句，保证结果仍是原文的连续子串——sourceText 要能过公证的
 * 逐字回查。
 */
function declarativeSegments(text: string): string[] {
  const segments: string[] = [];
  let buffer = '';
  const flush = (): void => {
    const segment = buffer.trim();
    if (segment) segments.push(segment);
    buffer = '';
  };
  for (const rawClause of text.split(CLAUSE_SPLIT_RE)) {
    if (QUESTION_CLAUSE_RE.test(rawClause.trim())) {
      flush();
      continue;
    }
    buffer += rawClause;
  }
  flush();
  return segments;
}

/** NFKC 折全半角 + 去空白 + 折标签分隔符；刻意不折标点（标点承载否定分界）。 */
function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').replace(LABEL_SEPARATOR_RE, '');
}

/** 标签在文本里至少出现一次且该次出现不紧跟否定前缀。 */
function containsWithoutNegation(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const preceding = index > 0 ? haystack[index - 1] : '';
    if (!NEGATION_PREFIXES.includes(preceding)) return true;
    from = index + 1;
  }
}

/** 丢掉"标签是另一命中标签真子串"的选项——长标签更具体，短标签只是它的碎片。 */
function dropSubstringLabels(matches: readonly OptionMatch[]): OptionMatch[] {
  return matches.filter((candidate) => {
    const label = normalizeForMatch(candidate.option.optionLabel);
    return !matches.some((other) => {
      if (other.option.optionCode === candidate.option.optionCode) return false;
      const otherLabel = normalizeForMatch(other.option.optionLabel);
      return otherLabel.length > label.length && otherLabel.includes(label);
    });
  });
}

/**
 * 按**语义**在契约选项里挑一个（D4：语义锚点，不认 optionCode 字面量）。
 *
 * 适配器把既有解析器的产物（如健康证三态、学历标准名）翻译成一个标签判据，由本函数
 * 在当岗契约的选项集里找唯一匹配。契约改了标签措辞就匹配不上——此时**退化成留空追问**，
 * 而不是按 ID 硬猜猜错人：这正是 D4「测试/生产环境 ID 可能不同」要防的事故。
 */
export function findOptionBySemantics(
  field: ContractFieldDef,
  matches: (normalizedLabel: string) => boolean,
): ContractOption | null {
  const options = [...field.acceptedOptions, ...field.rejectedOptions];
  const seen = new Map<string, ContractOption>();
  for (const option of options) {
    if (matches(normalizeForMatch(option.optionLabel))) seen.set(option.optionCode, option);
  }
  return seen.size === 1 ? [...seen.values()][0] : null;
}
