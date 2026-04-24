import type { EntityExtractionResult } from '../types/session-facts.types';

/**
 * 拦截微信加好友自动打招呼语中的昵称，避免其被当作真实姓名写入 interview_info.name。
 *
 * 业务背景：微信加好友时系统自动发送的首条消息固定为"我是xx"句式，其中 xx 通常是用户的
 * 微信昵称而非真实姓名。LLM 提取器会把 xx 当作姓名提取，进而沉淀到 profile.name，后续
 * 登记表"姓名"字段被预填，模型不再向候选人索取真名，直到临约面前才临时补问。
 *
 * 匹配思路：整条用户消息是"（你好，）我是XX（标点）"这种纯打招呼句式时拦截。
 * - 包含其他内容的消息（"我是张三，想了解下岗位"）放过
 * - 以"我叫"开头的显式自我介绍（"我叫张三"）放过
 *
 * 兼容性：短期记忆通过 `MessageParser.injectTimeContext` 给每条消息追加时间后缀，
 * badcase `batch_69e9bba2536c9654026522da_*` 中 sanitizer 因此被绕过。匹配前必须
 * 先剥离时间后缀，否则锚点会失效导致昵称漏网。
 */
const AUTO_GREETING_REGEX =
  /^\s*(?:(?:你好|您好|hi|hello)[，,。！!\s]*)?我是([^\s。，,！!？?]+?)[。，,！!\s]*$/i;

/**
 * 剥离短期记忆注入的时间后缀 `\n[消息发送时间：...]`。
 *
 * 与 `MessageParser.stripTimeContext` 保持一致，但 memory 层不直接依赖 channels 层，
 * 避免分层逆向；若格式后续调整，两处需同步。
 */
const TIME_CONTEXT_SUFFIX_REGEX = /\n\[消息发送时间：[^\]]*\]\s*$/u;

export function extractAutoGreetingName(message: string): string | null {
  if (!message) return null;
  const stripped = message.replace(TIME_CONTEXT_SUFFIX_REGEX, '').trim();
  const match = AUTO_GREETING_REGEX.exec(stripped);
  return match ? match[1] : null;
}

export function isFromAutoGreeting(name: string, userMessages: readonly string[]): boolean {
  for (const message of userMessages) {
    const greetingName = extractAutoGreetingName(message);
    if (greetingName && greetingName === name) return true;
  }
  return false;
}

export interface SanitizeNameResult {
  sanitized: EntityExtractionResult;
  droppedName: string | null;
}

export function sanitizeInterviewName(
  facts: EntityExtractionResult,
  userMessages: readonly string[],
): SanitizeNameResult {
  const name = facts.interview_info?.name?.trim();
  if (!name) return { sanitized: facts, droppedName: null };
  if (!isFromAutoGreeting(name, userMessages)) {
    return { sanitized: facts, droppedName: null };
  }
  return {
    sanitized: {
      ...facts,
      interview_info: { ...facts.interview_info, name: null },
    },
    droppedName: name,
  };
}
