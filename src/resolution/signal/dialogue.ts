import {
  extractMessageText,
  extractQuotedSpeakers as extractQuotedSpeakersFromText,
  stripQuotedBlocks,
  stripTimeContext,
} from './markers';
import type { DialogueTurn } from './types';

/** 从归一化消息（ModelMessage 形态）里抽出全部 user 文本。 */
export function extractUserTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user') continue;
    const text = extractMessageText(record.content);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

/** 按原始顺序抽出 user/assistant 双角色文本（确认问答对识别需要 assistant 上下文）。 */
export function extractDialogueTurns(messages: readonly unknown[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    const text = extractMessageText(record.content);
    if (text.trim().length > 0) turns.push({ role: record.role, text });
  }
  return turns;
}

/** 剥掉引用块，只留候选人自己敲的文字（留空格占位以维持词边界）。 */
export function stripQuoteBlocks(text: string): string {
  return stripQuotedBlocks(text, ' ');
}

/** 候选人消息里全部引用前缀的发言人（被引用方显示名，多为招募经理）。 */
export function extractQuotedSpeakers(messages: readonly unknown[]): string[] {
  const speakers = new Set<string>();
  for (const text of extractUserTexts(messages)) {
    for (const speaker of extractQuotedSpeakersFromText(text)) speakers.add(speaker);
  }
  return [...speakers];
}

/** 剥时间后缀 + 引用块后，去掉空白与常见标点，用于短答复整句匹配。 */
export function normalizeShortAnswer(text: string): string {
  return stripQuoteBlocks(stripTimeContext(text)).replace(/[\s，。！？!?~～、.…；;：:]/gu, '');
}

const AFFIRMATIVE_ANSWER_RE =
  /^(是|是的|是滴|是啊|是呀|对|对的|对啊|对呀|嗯|嗯嗯|没错|确认|正确|(?:就?是)?我?的?(?:本名|真名|真实姓名))$/u;

/** 入参须先过 normalizeShortAnswer。 */
export function isAffirmativeAnswer(shortAnswer: string): boolean {
  return AFFIRMATIVE_ANSWER_RE.test(shortAnswer);
}
