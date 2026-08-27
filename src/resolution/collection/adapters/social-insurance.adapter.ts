/**
 * 社保缴纳情况槽位写入适配器。
 *
 * 包装 `classifySocialInsuranceAnswerText`——它只识别否定档（未缴纳）：候选人答
 * 「无」「没有」「没交过社保」时，把它翻译成契约里唯一的否定选项（如
 * 「无公司在缴社保流水」「无社保」，措辞随岗配置漂移）。「有」「在缴」不产提案：
 * 缴纳方与参保地共同决定筛选方向，留空由模板强制枚举追问。
 *
 * 映射按**选项标签语义**匹配而非 optionCode 字面量（D4）：否定档要求标签同时携带
 * 否定词（无/未/没）与社保语素（社保/流水/缴）。命中多个或零个即留空追问，不猜。
 */

import { classifySocialInsuranceAnswerText } from '@resolution/candidate/social-insurance';
import { findOptionBySemantics } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

export function proposeSocialInsurance(input: AdapterInput): SlotProposal | null {
  const { field, candidateText } = input;
  const evidence = classifySocialInsuranceAnswerText(candidateText, {
    answerBound: input.answerBound,
  });
  if (!evidence) return null;

  const option = findOptionBySemantics(
    field,
    (label) => /无|未|没/u.test(label) && /社保|流水|缴/u.test(label),
  );
  if (!option) return null;

  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: evidence.excerpt,
    producer: 'candidate_quote',
  };
}
