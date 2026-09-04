/**
 * 住宿需求槽位写入适配器。
 *
 * 生产契约常写「需要/不需要」或「是/否」，候选人会答「不用住宿」。这里只做肯否
 * 归一化；裸短答仅在值已绑定到住宿槽位时解释，自由语料必须显式带「住宿/宿舍」。
 */

import { findOptionBySemantics } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

type AccommodationAnswer = 'needed' | 'not_needed';

const QUESTION_RE = /[？?]|(?:吗|么|呢|吧)(?:[啊呀嘛])?(?:[！。])?$/u;
const BARE_NEGATIVE_RE = /^(?:不需要|不用|无需|不要|否|不住|没有|无)$/u;
const BARE_POSITIVE_RE = /^(?:需要|要|是|有|要住|需要住宿)$/u;
const CONTEXTUAL_NEGATIVE_RE = /(?:不需要|不用|无需|不要)住宿|没有住宿需求|不住宿|不住宿舍/u;
const CONTEXTUAL_POSITIVE_RE = /(?:需要|要)住宿|有住宿需求|要住宿舍/u;

function classifyAccommodation(input: AdapterInput): AccommodationAnswer | null {
  const text = input.candidateText.normalize('NFKC').replace(/\s+/gu, '').trim();
  if (!text || QUESTION_RE.test(text)) return null;
  if (input.answerBound && BARE_NEGATIVE_RE.test(text)) return 'not_needed';
  if (input.answerBound && BARE_POSITIVE_RE.test(text)) return 'needed';
  if (CONTEXTUAL_NEGATIVE_RE.test(text)) return 'not_needed';
  if (CONTEXTUAL_POSITIVE_RE.test(text)) return 'needed';
  return null;
}

function isNegativeOption(label: string): boolean {
  return /不需要|无需|不用|不要|不住|否|没有|无/u.test(label);
}

export function proposeAccommodation(input: AdapterInput): SlotProposal | null {
  const answer = classifyAccommodation(input);
  if (!answer) return null;

  const option = findOptionBySemantics(input.field, (label) =>
    answer === 'not_needed'
      ? isNegativeOption(label)
      : !isNegativeOption(label) && /需要|住宿|^是$|^有$/u.test(label),
  );
  if (!option) return null;

  return {
    labelId: input.field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: input.candidateText.trim(),
    producer: 'candidate_quote',
  };
}
