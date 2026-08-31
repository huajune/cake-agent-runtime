/**
 * 籍贯 / 户籍槽位写入适配器。
 *
 * 契约把这一格配成**省级**选项集（「江苏省」「上海市」「广西壮族自治区」…），
 * 而候选人按自然语言作答时省略行政后缀是常态：问籍贯答「上海」、问户籍答「江苏」。
 * 逐字直配（通用道 `matchOptionInText`）判不出——「上海」不含「上海市」这个子串。
 *
 * 生产实证（2026-08-31）：labelId 3 两个会话各撞一次。「上海」纯粹差一个「市」字，
 * 候选人答的完全正确却入不了账；配合当时的跨轮重复拒收，一个会话直接烧到熔断转人工。
 *
 * 判据链（**只放宽行政后缀，不放宽别的**）：
 * 1. 先走逐字直配——它给出的 sourceText 是精确命中子句，最适合公证回查，行为与改造前一致；
 * 2. 直配不中且值已绑定到本槽位（`answerBound`：表单行回填 / 字段值提案 / 档案预填）时，
 *    剥掉两边的行政后缀再比一次。**绑定关系就是语境**：这一格问的就是省份，
 *    「上海」在这里不可能是别的意思。
 *
 * 刻意**不做**市→省推导（「南京」→「江苏省」）：那需要一张全国市级→省级映射表，
 * 落点应在 `resolution/geo`（行政区层级的唯一真相源）而非本适配器。当前 geo 只有
 * 县级市→地级市，没有到省这一层。缺这一层不再致命——跨轮重复拒收修好之后，
 * 模型的自然纠正话术（「籍贯改成省级，写江苏省就行」）有机会送达并生效。
 *
 * 未绑定的自由语料（轮末安全网扫描）一律只走第 1 级：在长句里裸扫省名会把
 * 「我在浙江打过工」当成籍贯，那是历史/地点语境，不是这一格的答案。
 */

import { findOptionBySemantics, matchOptionInText } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

/**
 * 行政区划后缀。含具体自治区全称是因为它们**不是**「XX自治区」的简单后缀：
 * 「广西壮族自治区」剥到「广西」才等于候选人说的那两个字。长后缀必须排在短后缀前，
 * 否则「壮族自治区」会被「自治区」先吃掉、剩下「广西壮族」配不上。
 */
const ADMINISTRATIVE_SUFFIX_RE =
  /(?:维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|自治州|省|市)$/u;

export function proposeHouseholdRegister(input: AdapterInput): SlotProposal | null {
  const { field, candidateText } = input;
  if (!candidateText.trim()) return null;

  // ① 逐字直配：sourceText 精确到命中子句，优先级最高。
  const literal = matchOptionInText(field, candidateText);
  if (literal) {
    return {
      labelId: field.labelId,
      value: literal.option.optionLabel,
      optionCodes: [literal.option.optionCode],
      sourceText: literal.sourceText,
      producer: 'candidate_quote',
    };
  }

  // ② 行政后缀容差：只在值已绑定到本槽位时开放（绑定关系即语境）。
  if (!input.answerBound) return null;
  const answer = stripAdministrativeSuffix(candidateText);
  if (!answer) return null;

  const option = findOptionBySemantics(
    field,
    (label) => stripAdministrativeSuffix(label) === answer,
  );
  // 契约没有这一档 → 留空追问；不塞近似值（宁可多问一句，不可报错籍贯）。
  if (!option) return null;

  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    // 出处仍是候选人原话本身——它就是这一格的完整作答。
    sourceText: candidateText.trim(),
    producer: 'candidate_quote',
  };
}

/** NFKC + 去空白 + 剥一层行政后缀。剥到空串返回空（「市」这种单字后缀不成答案）。 */
function stripAdministrativeSuffix(text: string): string {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '').trim();
  if (!normalized) return '';
  const stripped = normalized.replace(ADMINISTRATIVE_SUFFIX_RE, '');
  return stripped || normalized;
}
