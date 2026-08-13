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
 * 候选人**自陈**原文的唯一语料选择器（user 角色，剥引用块/时间后缀/视觉描述），
 * 保持会话顺序。claim 的 quote 验证与 admission 准入共用它。
 *
 * 视觉来源剔除（生产实测 2026-08-06，chat 6a714c00）：`save_image_description` 把
 * vision 描述回写进 user 消息，第三方截图里的招聘者手机号、岗位门槛年龄因此与候选人
 * 手打文本并列。不剔除等于把"截图里出现过"当成"候选人说过"（与
 * [[project_badcase_image_identity_hijack]] / PR #870 同族，那次收窄的是抽取侧）。
 * 逐 part 判定而非整条：多模态 content 扁平化后描述前面还挂着 `[图片 messageId=…]`
 * 占位标签，消息级 startsWith 判据会落空。候选人自己的简历图片是自陈材料，按既有裁定保留。
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
