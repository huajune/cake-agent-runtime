/**
 * 消息标记协议（message markup）—— 送进模型的那段消息文本里，我们自己塞的标记。
 *
 * 这些标记不是候选人打的字，是消息管线为了让模型读懂上下文而加的注解：时间后缀、
 * 引用气泡渲染、图片描述回写前缀、多模态选图标签、简历附件行。写的人在
 * channels/tools，剥的人在 memory/tools/agent/guardrail——本文件是它们之间唯一的契约：
 * **每个标记一组「常量 + 写 + 剥/判定」，正则各一份。**
 *
 * 立此文件的直接原因（2026-08-07 全库清点）：时间后缀的剥离正则曾有 11 份实现、
 * 4 种形态，其中只有 4 份认全角 `【】/：`；引用块有 3 份，两种边界写法。两次事故
 * 同源——identity 锚定识别器整句匹配没先剥时间后缀（v10.13.0 修了也没生效）、引用
 * 前缀里招募经理的名字被当候选人姓名预填进报名。
 *
 * 标记的写入者与消费者横跨 channels/tools/memory/agent；协议本身归 resolution/signal，
 * 由所有调用方共享。新增标记请在此加一组，顺带回答“谁写、谁剥”。
 */

import type { LocationShareCoordinates } from './types';

// ── 时间上下文后缀 `[消息发送时间：2026-06-03 12:11 星期三]` ──────────────────

export const TIME_CONTEXT_LABEL = '消息发送时间';

/**
 * 括号形态的时间标记。`当前时间` 一档是历史防御面：该串本体由 prompt 的
 * datetime section 写出且**不带方括号**，这条规则实际只兜"prompt 文本混进被分析语料
 * 且恰好被加了括号"的情形——合并前有两处这么写，一并保留，删它要另证无害。
 */
const TIME_MARKER_RE = new RegExp(
  `\\s*(?:\\[|【)(?:${TIME_CONTEXT_LABEL}|当前时间)[:：][\\s\\S]*?(?:\\]|】|$)`,
  'g',
);

/**
 * 剥离时间标记。
 *
 * 口径取合并前最宽的一版：全角/半角括号与冒号都认、出现在任何位置都剥、未闭合
 * （被上游截断）则吃到串尾。写入侧只产出 `\n[消息发送时间：…]` 一种形态，宽口径
 * 对真实输入与窄口径等价，差异只在防御面。
 *
 * `replaceWith` 传 `'\n'` 可保留子句边界——debounce 合并的消息会内嵌多个标记，
 * 直接删会把前后两句粘成一句，破坏整句锚定类判据。
 */
export function stripTimeContext(content: string, replaceWith = ''): string {
  if (!content) return content;
  return content.replace(TIME_MARKER_RE, replaceWith);
}

/** 追加时间后缀。timeText 由调用方按业务时区格式化（见 date.util / MessageParser）。 */
export function appendTimeContext(content: string, timeText: string): string {
  return `${content}\n[${TIME_CONTEXT_LABEL}：${timeText}]`;
}

/** 解析时间后缀为毫秒时间戳；标记里的时间恒为北京时间。无标记/不可解析返回 null。 */
export function parseTimeContextAt(content: string): number | null {
  const match = new RegExp(
    `(?:\\[|【)${TIME_CONTEXT_LABEL}[:：]\\s*(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})`,
  ).exec(content ?? '');
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── 引用气泡 `[引用 <speaker>：<snippet>]` ───────────────────────────────────

/**
 * 企微引用气泡被消息管线渲染成的单行前缀（写入侧 `MessageParser.formatQuoteMessage`：
 * 已折叠空白、截断 120 字，故块内不含换行）。speaker 是**被引用方**（候选人引用岗位卡
 * 时即招募经理）的显示名，snippet 是对方原话——整块都不是候选人自陈。
 */
const QUOTE_BLOCK_RE = /\[引用[^\]]*\]/g;
/** 行首形态：管线降级路径下引用会以 `引用 XXX：…` 整行出现，不带方括号。 */
const QUOTE_LINE_RE = /^引用\s+[^：]+：.*$/gm;
const QUOTE_SPEAKER_RE = /\[引用\s*([^：\n]{1,40})：/g;

/**
 * 剥掉引用块，只留候选人自己敲的文字。
 *
 * `replaceWith` 决定留不留占位空格：默认 `''` 用于提取前的清洗（结果会 trim），
 * 需要保留词边界、防止前后文粘连成新词时传 `' '`。
 */
export function stripQuotedBlocks(text: string, replaceWith = ''): string {
  return text.replace(QUOTE_BLOCK_RE, replaceWith).replace(QUOTE_LINE_RE, replaceWith).trim();
}

/**
 * 剥离引用块与时间戳装饰。候选人自陈类匹配统一先过这一步。
 *
 * 时间标记用 `\n` 替换而非删除：debounce 合并消息可能内嵌多个标记，直接删会把
 * 前后两句粘成一句，破坏整句锚定判据。
 */
export function stripMessageDecorations(text: string): string {
  return stripTimeContext(stripQuotedBlocks(text), '\n').trim();
}

/** 文本里所有引用前缀的发言人（被引用方显示名，多为招募经理）。 */
export function extractQuotedSpeakers(text: string): string[] {
  const speakers = new Set<string>();
  for (const match of (text ?? '').matchAll(QUOTE_SPEAKER_RE)) {
    const speaker = match[1]?.trim();
    if (speaker) speakers.add(speaker);
  }
  return [...speakers];
}

// ── 视觉描述回写前缀 `[图片消息]` / `[表情消息]` ──────────────────────────────

export const IMAGE_MESSAGE_PREFIX = '[图片消息]';
export const EMOTION_MESSAGE_PREFIX = '[表情消息]';

/**
 * 整条消息是否为 vision 描述回写产物。
 *
 * 判据是消息级而非行级：`updateMessageContent` 按 messageId 整条替换，图片描述独占
 * 一条 chat_messages 行，不会与候选人手打文本混在同一条消息里。
 */
export function isVisualDescriptionText(message: string | null | undefined): boolean {
  const trimmed = (message ?? '').trim();
  return trimmed.startsWith(IMAGE_MESSAGE_PREFIX) || trimmed.startsWith(EMOTION_MESSAGE_PREFIX);
}

/** 剥掉视觉前缀，得到描述本体。 */
export function stripVisualPrefix(content: string): string {
  return content.replace(/^\s*\[(?:图片|表情)消息\]\s*/u, '');
}

/**
 * 多图占位（`[图片消息 3 张]`）。单图退回裸前缀，两种形态都以 `[图片消息` 起头，
 * `isVisualDescriptionText` 的 startsWith 判据同样命中。
 */
export function formatImageCountPlaceholder(count: number): string {
  return count <= 1 ? IMAGE_MESSAGE_PREFIX : `[图片消息 ${count} 张]`;
}

// ── 多模态选图标签 `[图片 messageId=…]` / `[表情 messageId=…]` ────────────────

/**
 * 多 part 消息扁平化后，描述文本前面还会挂着这个标签（生产实例 chat 6a714c00 的
 * content 数组是 `[图片 messageId=…]` + image + `[图片消息] 描述`），消息级
 * startsWith 判据会因此落空，故需要逐 part 判定。
 */
const VISUAL_PLACEHOLDER_TAG_RE = /^\s*\[(?:图片|表情)\s+messageId=[^\]]*\]\s*$/u;

/** 单个内容 part 是否属于视觉来源（描述回写产物 或 选图占位标签）。 */
export function isVisualSourcePart(part: string | null | undefined): boolean {
  const trimmed = (part ?? '').trim();
  if (!trimmed) return false;
  return isVisualDescriptionText(trimmed) || VISUAL_PLACEHOLDER_TAG_RE.test(trimmed);
}

// ── 简历附件行 `简历附件：<URL>` ─────────────────────────────────────────────

export const RESUME_ATTACHMENT_LABEL = '简历附件';

const RESUME_ATTACHMENT_LINE_RE = /(?:^|\n)\s*简历附件\s*[：:]/;

/** 消息是否携带简历附件标注行。 */
export function hasResumeAttachmentLine(message: string | null | undefined): boolean {
  return RESUME_ATTACHMENT_LINE_RE.test(message ?? '');
}

/** 剥离描述中已存在的简历附件行（回写前去重，避免同条消息出现两行）。 */
export function stripResumeAttachmentLines(description: string): string {
  return description
    .split('\n')
    .filter((line) => !/^\s*简历附件\s*[：:]/.test(line))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 追加唯一一行简历附件标注（先剥后加，写入侧唯一出口）。 */
export function appendResumeAttachmentLine(description: string, url: string): string {
  return `${stripResumeAttachmentLines(description)}\n${RESUME_ATTACHMENT_LABEL}：${url}`;
}

// ── 位置分享 `[位置分享] … [经纬度:lat,lng]` ────────────────────────────────

export const LOCATION_SHARE_PREFIX = '[位置分享]';
export const LOCATION_COORDINATES_LABEL = '经纬度';
export const LOCATION_SHARE_MARKER_RE = /\[位置分享\]|\[经纬度:/u;

const LOCATION_SHARE_BLOCK_RE = /\[位置分享\](?:(?!\[经纬度:)[^\n])*(?:\[经纬度:[^\]]+\])?/gu;
const LOCATION_COORDS_RE = /\[经纬度:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/gu;

export interface LocationSharePayload {
  name?: string;
  address?: string;
  latitude?: number | string;
  longitude?: number | string;
}

export function formatLocationShare(payload: LocationSharePayload): string {
  const location =
    payload.name && payload.address && payload.name !== payload.address
      ? `${payload.name}（${payload.address}）`
      : payload.address || payload.name || '未知位置';
  const coordinates =
    payload.latitude !== undefined && payload.longitude !== undefined
      ? ` [${LOCATION_COORDINATES_LABEL}:${payload.latitude},${payload.longitude}]`
      : '';
  return `${LOCATION_SHARE_PREFIX} ${location}${coordinates}`;
}

export function parseLocationShareCoordinates(
  texts: readonly string[],
): LocationShareCoordinates | null {
  let result: LocationShareCoordinates | null = null;
  for (const raw of texts) {
    const value = stripQuotedBlocks(stripTimeContext(raw ?? ''));
    if (!value.includes(LOCATION_SHARE_PREFIX)) continue;
    for (const match of value.matchAll(LOCATION_COORDS_RE)) {
      const latitude = Number(match[1]);
      const longitude = Number(match[2]);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        result = { latitude, longitude };
      }
    }
  }
  return result;
}

export function extractLocationShareLabels(text: string): string[] {
  const value = stripQuotedBlocks(stripTimeContext(text ?? ''));
  if (!value.includes(LOCATION_SHARE_PREFIX)) return [];
  const labels: string[] = [];
  const title = /\[位置分享\]\s*([^（\[]+)/u.exec(value)?.[1]?.trim();
  const address = /（([^）]+)）/u.exec(value)?.[1]?.trim();
  if (title) labels.push(title);
  if (address) labels.push(address);
  return Array.from(new Set(labels));
}

export function stripLocationShareMarkup(text: string, replaceWith = ''): string {
  return text.replace(LOCATION_SHARE_BLOCK_RE, replaceWith).trim();
}

export function containsLocationShareMarkup(text: string | null | undefined): boolean {
  return LOCATION_SHARE_MARKER_RE.test(text ?? '');
}

// ── 多模态文本扁平化 ────────────────────────────────────────────────────────

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractMessageText).filter(Boolean).join(' ').trim();
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}
