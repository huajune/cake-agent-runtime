import type { EntityExtractionResult } from '../types/session-facts.types';

/**
 * 拦截微信加好友自动打招呼语中的昵称，避免其被当作真实姓名写入 interview_info.name。
 *
 * 业务背景：badcase `batch_69e5e4759d6d3a463be0acd2_*` —— 微信加好友时系统自动发送
 * 的首条消息固定为"我是xx"句式，其中 xx 通常是用户的微信昵称而非真实姓名。LLM 提取器
 * 会把 xx 当作姓名提取，进而沉淀到 profile.name，后续登记表"姓名"字段被预填，模型不
 * 再向候选人索取真名，直到临约面前才临时补问。
 *
 * 匹配思路：只有当整条用户消息是"（你好，）我是XX（标点）"这种纯打招呼句式时才拦截。
 * - 包含其他内容的消息（"我是张三，想了解下岗位"）放过
 * - 以"我叫"开头的显式自我介绍（"我叫张三"）放过
 */
const AUTO_GREETING_REGEX =
  /^\s*(?:(?:你好|您好|hi|hello)[，,。！!\s]*)?我是([^\s。，,！!？?]+?)[。，,！!\s]*$/i;

export function extractAutoGreetingName(message: string): string | null {
  if (!message) return null;
  const match = AUTO_GREETING_REGEX.exec(message.trim());
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
