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

/**
 * 存储态视觉事实 → `visualSheetsByContent` 索引。键必须与 `sheetFor` 同源（剥时间后缀后
 * 的裸内容）：库里的 content 无后缀，而生产窗口消息带 `injectTimeContext` 注入的后缀，
 * 键不同源则查表恒 miss、sheet 授权域静默失效（rule-track 曾因此被评审阻断）。
 *
 * 入参形状即 `ChatSessionService.getVisualFacts` 的返回行，解析失败/降级的行直接跳过——
 * 降级不是失败，是回落到无 sheet 的文本兜底行为。
 */
export function buildVisualSheetIndex(
  rows: ReadonlyArray<{ content: string; visualFacts: unknown }>,
): ReadonlyMap<string, FinalizedVisualFactSheet> {
  const index = new Map<string, FinalizedVisualFactSheet>();
  for (const row of rows) {
    const key = stripTimeContext(row.content ?? '').trim();
    if (!key) continue;
    const sheet = parseStoredVisualFactSheet(row.visualFacts);
    if (!sheet || sheet.degraded) continue;
    index.set(key, sheet);
  }
  return index;
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
 * 自有材料判定 sheet 优先、文本兜底：`options.visualSheetsByContent` 命中时按 sheet kind
 * 判（resume/certificate 即自陈材料），缺 sheet 才回落 isResumeImageDescription/简历附件行。
 * 文本兜底只认「简历/履历」开头，**证件类描述以证件自身抬头起头、没有可靠文本标记**——
 * 不喂 sheet 就等于把候选人本人的健康证/学生证逐字原话排除在出处池外，
 * 模型引用它填姓名/性别/年龄会被公证判 `source_text_not_found`（见
 * visual-fact-pipeline.md 附录 A：出处门语料 = 手打 + 简历/证件 sheet 消息）。
 */
export function extractCandidateTexts(
  messages: readonly unknown[],
  options?: CandidateCorpusOptions,
): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    const parts = Array.isArray(record.content) ? record.content : [record.content];
    const selected = parts
      .map(extractMessageText)
      .filter(
        (text) =>
          text &&
          (!isVisualSourcePart(text) || isSelfReportedVisualMessage(text, sheetFor(text, options))),
      );
    const cleaned = stripMessageDecorations(selected.join(' ').trim());
    if (cleaned) texts.push(cleaned);
  }
  return texts;
}

/**
 * 结构化语料版候选人自陈选择器：先按封闭标签只取 evidence/user，之后复用既有的
 * 引用块、时间后缀与视觉来源清洗。teaching/tool_result 永不进入候选人出处池。
 */
export function extractCandidateTextsFromCorpus(
  blocks: readonly CorpusBlock[],
  options?: CandidateCorpusOptions,
): string[] {
  return extractCandidateTexts(
    selectCorpusMessages(blocks, { domains: ['evidence'], roles: ['user'] }),
    options,
  );
}
