/**
 * 籍贯 / 户籍槽位写入适配器：契约配省级选项集（「江苏省」「上海市」），而候选人
 * 惯常省略行政后缀（答「上海」），逐字直配判不出。
 *
 * 判据链**只放宽行政后缀**：
 * 1. 先逐字直配，其 sourceText 是精确命中子句，最适合公证回查；
 * 2. 直配不中且值已绑定本槽位（`answerBound`）时剥后缀再比——绑定关系即语境。
 *
 * 未绑定的自由语料只走第 1 级：长句裸扫省名会把「我在浙江打过工」当籍贯。
 * 刻意不做市→省推导，那需要全国市级→省级映射，落点在 `resolution/geo`（当前只到地级市）。
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
