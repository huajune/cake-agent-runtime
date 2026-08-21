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

/**
 * 肯定应答词表——**全库唯一居所**（§7：四份肯定词表分叉收拢至此，禁止另立副本）。
 *
 * 收词纪律（§11 词表禁判语义的边界）：只收**教科书短答**——整句就是一个肯定表态、
 * 脱离上下文也不会有第二种读法的说法。口语长尾（"刚拿到手""健康正式"这类需要理解
 * 语境才知道在肯定什么的）一律不进，交主聊模型作证。
 *
 * 2026-08-20 补 `确定`/`好的`/`没问题`（用户裁定"词表收"）：
 * 生产 0819 确认死循环实测语料里，候选人对复述清单回的正是「确定」，而词表当时只有
 * 「确认」——一字之差，85% 走裸字段通道的调用在复述确认这一步整个退化，
 * 再问一遍直到熔断。这三个与已在表里的「确认/对/嗯」是同一类，不是长尾。
 *
 * ⚠️ 本表**只在整句匹配**下使用（调用方须先过 normalizeShortAnswer），且所有消费方
 * 都额外要求"我方消息里出现过被确认的那个值"——单靠一句"好的"不构成任何事实入账。
 * 加词前先问：这个词单独成句时，还有别的读法吗？答得上来就别加。
 */
const AFFIRMATIVE_ANSWER_RE =
  /^(是|是的|是滴|是啊|是呀|对|对的|对啊|对呀|嗯|嗯嗯|没错|确认|确定|正确|好的|没问题|(?:就?是)?我?的?(?:本名|真名|真实姓名))$/u;

/** 入参须先过 normalizeShortAnswer。 */
export function isAffirmativeAnswer(shortAnswer: string): boolean {
  return AFFIRMATIVE_ANSWER_RE.test(shortAnswer);
}
