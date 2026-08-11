import {
  extractMessageText,
  isVisualDescriptionText,
  isVisualSourcePart,
  stripMessageDecorations,
  stripTimeContext,
} from './markers';
import {
  isSelfReportedVisualMessage,
  parseStoredVisualFactSheet,
  type FinalizedVisualFactSheet,
} from './visual';

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
