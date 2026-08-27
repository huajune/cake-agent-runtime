/**
 * 收资表单的直接身份归属闸门。
 *
 * 确认式作证由 collection claim 的 agentQuestionQuote 主通道承担；该通道仍须在真实
 * 消息序列里找到对应 assistant 问句 + 紧随其后的候选人肯定应答，不能信任模型自报。
 * 直接提供值时则检查引用污染、昵称和手机号出处。
 */

import { isFromAutoGreeting, parseName } from '@resolution/candidate';
import { isPlaceholderPhone, isStorableCandidatePhone } from '@resolution/candidate/phone';
import {
  extractDialogueTurns,
  extractQuotedSpeakers,
  extractUserTexts,
  isAffirmativeAnswer,
  normalizeShortAnswer,
  stripQuoteBlocks,
} from '@resolution/signal/dialogue';
import { extractCandidateTexts } from '@resolution/signal/self-report';
import type { NameGateVerdict } from './claim.types';
import { normalizedIncludes } from './normalize';

const CONFIRMATION_QUESTION_RE = /(?:对吧|对吗|对么|对不对|是吗|是么|是吧|确认|核对|[吗么？?])/u;

/**
 * 验证模型提交的确认式证词确实绑定到真实问答对。
 *
 * 三条同时满足：问句逐字存在于 assistant 历史、问句具备求证语气、紧随其后的第一条
 * user 消息既包含该候选人 quote 又是闭集肯定短答。这样既保留「对/确认」作证通道，
 * 又挡住模型凭空填写 agentQuestionQuote 后自证身份值的路径。
 */
export function isAgentQuestionConfirmedInDialogue(
  agentQuestionQuote: string,
  candidateAnswerQuote: string,
  messages: readonly unknown[],
): boolean {
  const question = agentQuestionQuote.trim();
  const answer = candidateAnswerQuote.trim();
  if (!question || !answer || !CONFIRMATION_QUESTION_RE.test(question)) return false;

  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].role !== 'assistant' || !normalizedIncludes(turns[i].text, question)) continue;
    for (let j = i + 1; j < turns.length; j += 1) {
      if (turns[j].role !== 'user') continue;
      if (
        normalizedIncludes(turns[j].text, answer) &&
        isAffirmativeAnswer(normalizeShortAnswer(turns[j].text))
      ) {
        return true;
      }
      break;
    }
  }
  return false;
}

export function isNameOnlyQuotedSpeaker(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target || target.length < 2) return false;
  const speakers = extractQuotedSpeakers(messages);
  if (!speakers.some((speaker) => speaker === target || speaker.includes(target))) return false;
  return !extractUserTexts(messages).some((text) => stripQuoteBlocks(text).includes(target));
}

export function isNameAuthoritative(name: string, messages: readonly unknown[]): boolean {
  const target = name?.trim();
  if (!target) return false;
  return extractUserTexts(messages).some(
    (text) => parseName(stripQuoteBlocks(text))?.value === target,
  );
}

export function evaluateBookingNameGate(
  name: string,
  messages: readonly unknown[],
): NameGateVerdict {
  const target = name?.trim();
  if (!target || isNameAuthoritative(target, messages)) return { decision: 'allow' };
  if (isNameOnlyQuotedSpeaker(target, messages)) {
    return {
      decision: 'reject_collect',
      reason: '提交姓名只出现在引用前缀中，不是候选人直接提供的姓名',
    };
  }
  if (isFromAutoGreeting(target, extractUserTexts(messages))) {
    return {
      decision: 'reject_collect',
      reason: '提交姓名只以自动打招呼昵称出现，需候选人提供真实姓名',
    };
  }
  return { decision: 'allow' };
}

export function isPhoneAuthoritative(phone: string, messages: readonly unknown[]): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!isStorableCandidatePhone(digits) || isPlaceholderPhone(digits)) return false;
  return extractCandidateTexts(messages).some((text) => text.replace(/\D/g, '').includes(digits));
}

export function evaluateBookingPhoneGate(
  phone: string,
  messages: readonly unknown[],
): NameGateVerdict {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return { decision: 'allow' };
  if (isPhoneAuthoritative(phone, messages)) return { decision: 'allow' };
  return {
    decision: 'reject_collect',
    reason: '提交手机号在候选人直接提供的原文中不存在，必须重新索要联系方式',
  };
}
