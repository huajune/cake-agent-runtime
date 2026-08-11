import {
  extractMessageText,
  extractQuotedSpeakers as extractQuotedSpeakersFromText,
  isVisualDescriptionText,
  isVisualSourcePart,
  stripQuotedBlocks,
  stripTimeContext,
} from '@infra/utils/message-markup.util';
import {
  isSelfReportedVisualMessage,
  parseStoredVisualFactSheet,
  type FinalizedVisualFactSheet,
} from '@resolution/visual';
import { stripMessageDecorations } from '@resolution/candidate/student-identity';

export interface CandidateCorpusOptions {
  visualSheetsByContent?: ReadonlyMap<string, FinalizedVisualFactSheet>;
}

function sheetFor(
  message: string,
  options?: CandidateCorpusOptions,
): FinalizedVisualFactSheet | undefined {
  return options?.visualSheetsByContent?.get(stripTimeContext(message).trim());
}

/** D1：sheet 优先识别简历/证件自陈材料，旧文本标记只作兜底。 */
export function isSelfReportedCandidateMessage(
  message: string,
  sheet?: FinalizedVisualFactSheet | null,
): boolean {
  return !isVisualDescriptionText(message) || isSelfReportedVisualMessage(message, sheet);
}

export function keepSelfReportedMessages(
  messages: readonly string[],
  options?: CandidateCorpusOptions,
): string[] {
  return messages.filter((message) =>
    isSelfReportedCandidateMessage(message, sheetFor(message, options)),
  );
}

export function hasSelfReportedPhoneProvenance(
  phone: string | null | undefined,
  messages: readonly string[],
  options?: CandidateCorpusOptions & { prefiltered?: boolean },
): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return true;
  const corpus = options?.prefiltered ? messages : keepSelfReportedMessages(messages, options);
  return corpus.some((message) => message.replace(/\D/g, '').includes(digits));
}

/** claim quote 复算与 admission 共用的唯一候选人自陈语料选择器。 */
export function extractCandidateTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    const storedSheet = parseStoredVisualFactSheet(record.visualFactSheet);
    const parts = Array.isArray(record.content) ? record.content : [record.content];
    const selected = parts
      .map(extractMessageText)
      .filter(
        (text) =>
          text && (!isVisualSourcePart(text) || isSelfReportedVisualMessage(text, storedSheet)),
      );
    const cleaned = stripMessageDecorations(selected.join(' ').trim());
    if (cleaned) texts.push(cleaned);
  }
  return texts;
}

// ── 消息数组语料原语（原 tools/shared/precheck-core，随 name-qa 拆分归位） ─────

/** 从归一化消息（ModelMessage 形态）里抽出全部 user 文本。 */
export function extractUserTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user') continue;
    const text = extractMessageText(msg.content);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 按原始顺序抽出 user/assistant 双角色文本（确认问答对识别需要 assistant 上下文）。 */
export function extractDialogueTurns(messages: readonly unknown[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = extractMessageText(msg.content);
    if (text.trim().length > 0) turns.push({ role: msg.role, text });
  }
  return turns;
}

/**
 * 剥掉引用块，只留候选人自己敲的文字（留空格占位以维持词边界）。
 * 引用块是被引用方（多为招募经理）说的话，不能作为候选人任何字段的出处。
 */
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
 * 纯肯定答复（对确认问句的整句应答）。
 * badcase 6a609570（张杰案）补充："是我本名/就是本名/是真名"类本名直答——原词表只有
 * 纯确认词，候选人换个说法确认就漏。
 */
const AFFIRMATIVE_ANSWER_RE =
  /^(是|是的|是滴|是啊|是呀|对|对的|对啊|对呀|嗯|嗯嗯|没错|确认|正确|(?:就?是)?我?的?(?:本名|真名|真实姓名))$/u;

/** 入参须先过 normalizeShortAnswer。 */
export function isAffirmativeAnswer(shortAnswer: string): boolean {
  return AFFIRMATIVE_ANSWER_RE.test(shortAnswer);
}
