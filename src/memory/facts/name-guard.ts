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

/**
 * 剥离短期记忆时间后缀，供整句锚定类识别器（打招呼语/确认句/肯定答复）在匹配前调用。
 * badcase 6a448d09（v10.13.0 修复被时间后缀击穿）的教训：任何对"整条消息"做
 * 锚定判断的正则，都必须先过这一层，否则后缀会让 `$` 锚点永远失配。
 */
export function stripTimeContextSuffix(message: string): string {
  return message.replace(TIME_CONTEXT_SUFFIX_REGEX, '');
}

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

/**
 * 结构化收资表单回填中的"姓名：xxx"键值对识别。
 *
 * 业务背景：badcase ci7iigv4 / 362ketwp —— 候选人 T1 说"我是赵堤"（被 sanitizer 视为
 * 打招呼语），随后 Agent 发收资 checklist，候选人按模板回填"姓名：赵堤 / 联系电话:... /
 * 年龄:..."。这种结构化回填可信度远高于打招呼语，应允许 LLM 抽出的 name 通过。
 *
 * 匹配规则：消息中包含 `姓名` / `名字` 后接冒号(中英文)/空格再跟同名字符串，且 name 出现
 * 在合理位置（行首或行内键值对位置），不要误匹配普通陈述句"我姓名叫不告诉你"等。
 */
const STRUCTURED_NAME_KEY_REGEX =
  /(?:^|[\n\r])\s*(?:姓名|名字)\s*[：:\s]\s*([^\n\r。，,！!？?]+?)(?=[\n\r]|$)/u;

export function hasStructuredNameSubmission(
  name: string,
  userMessages: readonly string[],
): boolean {
  if (!name) return false;
  const target = name.trim();
  if (!target) return false;
  for (const message of userMessages) {
    if (!message) continue;
    const normalized = message.replace(TIME_CONTEXT_SUFFIX_REGEX, '');
    const match = STRUCTURED_NAME_KEY_REGEX.exec(normalized);
    if (match && match[1].trim() === target) return true;
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
  // 即使 name 来自"我是xx"打招呼语，只要候选人后续按结构化模板回填"姓名：xx"，就视为可信，
  // 不再 drop。badcase ci7iigv4 / 362ketwp：T1 打招呼"我是赵堤"，T9 按 booking checklist
  // 填"姓名：赵堤"，原 sanitizer 仍按 T1 一刀切丢弃，导致 booking 缺真名。
  if (hasStructuredNameSubmission(name, userMessages)) {
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

/**
 * 中文姓名正向校验。
 *
 * 校验规则：
 * - 长度 2-5 个 CJK 汉字（汉族 2-4 字覆盖 99%+，少数民族最长 5 字如"布买日也木"）
 * - 仅含 CJK 统一汉字，不含拉丁/数字/emoji/装饰符号
 * - 不以"测试/用户/昵称/游客/匿名"等占位前缀开头
 *
 * 6+ 字纯汉字一律拒——微信昵称 6 字以上极其常见（"小晴早点睡"/"加油宝贝吖"），
 * 而 6 字真名在招聘场景几乎不存在，用枚举 hint char 去拦截是打地鼠，不如一刀切。
 * 已知漏网：4 字成语式昵称（"执子之魂"），依赖 Agent prompt 收名时重问。
 */
const REAL_NAME_REGEX = /^[一-鿿]{2,5}$/u;
const REAL_NAME_STRICT_REGEX = /^[一-鿿]{2,4}$/u;
const PLACEHOLDER_PREFIX_BLACKLIST = ['测试', '用户', '昵称', '游客', '匿名', '无名', '客户'];

function checkChineseName(value: string | null | undefined, regex: RegExp): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!regex.test(trimmed)) return false;
  for (const prefix of PLACEHOLDER_PREFIX_BLACKLIST) {
    if (trimmed.startsWith(prefix)) return false;
  }
  return true;
}

/** 宽松版（2-5 字）：用于规则提取层，允许 5 字少数民族真名通过。 */
export function isLikelyRealChineseName(value: string | null | undefined): boolean {
  return checkChineseName(value, REAL_NAME_REGEX);
}

/**
 * 严格版（2-4 字）：用于 booking/precheck 硬 guard。
 * 5 字纯 CJK 有较高概率是昵称（"小晴早点睡"），不应直接进预约接口。
 * 5 字真名（少数民族）走 precheck 的 mustHandoff 转人工补录。
 */
export function isStrictRealChineseName(value: string | null | undefined): boolean {
  return checkChineseName(value, REAL_NAME_STRICT_REGEX);
}
