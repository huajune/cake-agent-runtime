import {
  extractMessageText,
  isVisualDescriptionText,
  isVisualSourcePart,
  stripMessageDecorations,
  stripTimeContext,
} from './markers';
import { isSelfReportedVisualMessage, type FinalizedVisualFactSheet } from './visual';

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

/**
 * claim quote 复算与 admission 共用的唯一候选人自陈语料选择器。
 *
 * 自有材料判定当前只有文本兜底（isResumeImageDescription/简历附件行）：会话消息
 * 对象上从没有人挂 sheet，此前按 `record.visualFactSheet` 的读法是死分支
 * （PR #1000 评审 #2 关联项，已删）。若未来消息窗口开始携带 sheet，应经
 * isSelfReportedVisualMessage 的 sheet 优先通道重新接入。
 */
export function extractCandidateTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    const parts = Array.isArray(record.content) ? record.content : [record.content];
    const selected = parts
      .map(extractMessageText)
      .filter((text) => text && (!isVisualSourcePart(text) || isSelfReportedVisualMessage(text)));
    const cleaned = stripMessageDecorations(selected.join(' ').trim());
    if (cleaned) texts.push(cleaned);
  }
  return texts;
}
