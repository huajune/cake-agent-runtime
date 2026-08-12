/**
 * 生产形态消息 fixture（PR #1000 评审工作约定）。
 *
 * 多数字段解析回归的共因是「单测喂干净文本、生产喂脏文本」：生产链路的 user 消息
 * 带短期记忆注入的 `\n[消息发送时间：…]` 后缀、debounce 合并的多消息 `\n` 拼接、
 * vision 回写的 `[图片消息]` 占位/描述、企微引用气泡渲染的 `[引用 …：…]` 块。
 * 所有对字段解析器/规则轨的回归测试都应优先用这组 builder 构造输入，而不是干净文本。
 */

export const PROD_TIME_SUFFIX = '[消息发送时间：2026-08-12 14:30 星期三]';

/** 单条消息的生产形态：正文 + 换行 + 时间后缀（MessageParser.injectTimeContext 口径）。 */
export function withTimeSuffix(text: string, suffix: string = PROD_TIME_SUFFIX): string {
  return `${text}\n${suffix}`;
}

/** debounce 合并批：多条带时间后缀的消息以 `\n` 拼接成单串（trailingUserContent 口径）。 */
export function debounceJoin(...texts: string[]): string {
  return texts.map((text) => withTimeSuffix(text)).join('\n');
}

/** 企微引用气泡的渲染形态：`[引用 <被引用方>：<对方原话>]`（单行，管线已折叠空白）。 */
export function quotedBlock(speaker: string, snippet: string): string {
  return `[引用 ${speaker}：${snippet}]`;
}

/** vision 描述回写前的图片占位消息。 */
export const IMAGE_PLACEHOLDER = '[图片消息]';

/** vision 描述回写后的图片消息（updateMessageContent 整条替换后的内容）。 */
export function imageDescription(description: string): string {
  return `${IMAGE_PLACEHOLDER} ${description}`;
}

/** 会话消息对象（规则轨/识别器/闸门的 messages 入参形态）。 */
export function userMsg(content: string): { role: 'user'; content: string } {
  return { role: 'user', content };
}

export function assistantMsg(content: string): { role: 'assistant'; content: string } {
  return { role: 'assistant', content };
}
