import {
  extractMessageText,
  isVisualDescriptionText,
  isVisualSourcePart,
  stripMessageDecorations,
  stripTimeContext,
} from './markers';
import { isSelfReportedVisualMessage, type FinalizedVisualFactSheet } from './visual';
import type { CorpusBlock } from '@shared-types/corpus.types';
import { selectCorpusMessages } from './corpus';

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
 * 候选人**自陈**原文的唯一语料选择器（user 角色，剥引用块/时间后缀/视觉描述），
 * 保持会话顺序。claim 的 quote 验证与 admission 准入共用它。
 *
 * 必须剔除视觉来源：`save_image_description` 把 vision 描述回写进 user 消息，第三方截图里
 * 的手机号、年龄门槛会与候选人手打文本并列——不剔除等于把"截图里出现过"当成"候选人说过"。
 * 逐 part 判定而非整条：多模态 content 扁平化后描述前挂着 `[图片 messageId=…]` 占位标签，
 * 消息级 startsWith 判据会落空。候选人自己的简历图片是自陈材料，按既有裁定保留。
 *
 * 自有材料判定当前只有文本兜底（isResumeImageDescription/简历附件行）：会话消息对象上
 * 没有人挂 sheet。若未来消息窗口开始携带 sheet，应经 isSelfReportedVisualMessage 的
 * sheet 优先通道接入。
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

/**
 * 结构化语料版候选人自陈选择器：先按封闭标签只取 evidence/user，之后复用既有的
 * 引用块、时间后缀与视觉来源清洗。teaching/tool_result 永不进入候选人出处池。
 */
export function extractCandidateTextsFromCorpus(blocks: readonly CorpusBlock[]): string[] {
  return extractCandidateTexts(
    selectCorpusMessages(blocks, { domains: ['evidence'], roles: ['user'] }),
  );
}
