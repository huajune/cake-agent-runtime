/**
 * 收资表单的直接身份归属闸门。
 *
 * 确认式作证由 collection claim 的 agentQuestionQuote 主通道承担；这里不再扫描跨轮
 * 问答或正则确认，只检查候选人直接提供值时的引用污染、昵称和手机号出处。
 */

import { isFromAutoGreeting, parseName } from '@resolution/candidate';
import { isPlaceholderPhone, isStorableCandidatePhone } from '@resolution/candidate/phone';
import {
  extractQuotedSpeakers,
  extractUserTexts,
  stripQuoteBlocks,
} from '@resolution/signal/dialogue';
import { extractCandidateTexts } from '@resolution/signal/self-report';
import type { NameGateVerdict } from './claim.types';

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
