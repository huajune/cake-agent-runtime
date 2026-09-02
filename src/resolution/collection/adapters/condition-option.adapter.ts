/**
 * 条件型单选项写入适配器（`isConditionField`）：唯一选项是"必须接受的条件"，不是让候选人
 * 填自己的值。运营 2026-09-02 裁定：不接受就别报名；改自由文本就失去筛选意义。
 *
 * 只认两种接受：
 * ① 原样抄回条件字面（「09:30-22:30」）——任何语境都认，回答自带信息；
 * ② 绑定到本槽位的整句肯定短答（表单行「每天可工作时间段：可以」拆行后）——
 *    `answerBound` 才认，闲聊里的一句"可以"没法知道在答哪一行。
 * 不接受、答子区间、其它一律 null：不填不判，合不合适交模型与候选人对话决定。
 */

import { isConditionField } from '../form.types';
import { matchOptionInText } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

/** 整句肯定短答。只收脱离上下文也只有一种读法的说法；「可以什么」由绑定关系回答。 */
const ACCEPT_ANSWER_RE =
  /^(?:可以|可以的|可以接受|能|能的|能接受|行|行的|好的|好|ok|okay|没问题|接受|愿意|都可以|都行|没意见|听安排|听门店安排|门店安排|门店排|按门店排|服从安排|随便|是|是的|对|嗯|嗯嗯)[。！!~～]?$/iu;

/**
 * 候选人回显我们的条件提示「（要求 09:30-22:30 内都能排班，接受请填 09:30-22:30）」时，
 * 括号里的字面是我们印的不是他答的——先剥掉再找字面，照抄模板不等于接受。
 */
const ECHOED_HINT_RE = /[（(][^（）()]*(?:要求|请填)[^（）()]*[）)]/gu;

export function proposeConditionOption(input: AdapterInput): SlotProposal | null {
  const { field, candidateText, answerBound } = input;
  if (!isConditionField(field)) return null;
  const option = field.acceptedOptions[0];

  const literal = matchOptionInText(field, candidateText.replace(ECHOED_HINT_RE, ''));
  if (literal) {
    return {
      labelId: field.labelId,
      value: option.optionLabel,
      optionCodes: [option.optionCode],
      sourceText: literal.sourceText,
      producer: 'candidate_quote',
    };
  }

  if (!answerBound) return null;
  if (!ACCEPT_ANSWER_RE.test(candidateText.normalize('NFKC').trim())) return null;
  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: candidateText.trim(),
    producer: 'candidate_quote',
  };
}
