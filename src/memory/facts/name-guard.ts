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
 * 业务背景：badcase 簇 `booking_real_name_required`（5 条）—— Agent 在候选人只给了
 * 微信昵称（如 "执子之魂"、"💰余᭄苼囿財࿐"、"小晴早点睡"）的情况下仍调用预约接口。
 * `sanitizeInterviewName` 只对"我是XX"自动打招呼场景兜底，其他来源（候选人手动
 * 回复名字时贴了昵称）漏网。预约工具的 `name` 字段是直接进 sponge 的，必须在
 * 工具入参侧硬卡。
 *
 * 校验规则（保守起见，只拦明显不是真名的情况）：
 * - 长度 2-8 个汉字（汉族姓名通常 2-4 字；少数民族真名常 5-7 字，如"布买日也木"，
 *   历史 badcase uw8ow1xw / slg3jqi9：原 {2,4} 上限把少数民族真名一律拒，Agent 反复
 *   要求候选人改名最终用"小布"代替）
 * - 仅含 CJK 统一汉字，不含拉丁/数字/emoji/装饰符号/中文标点（昵称多含 emoji / 拼音 / 标点）
 * - 不以"测试 / 用户 / 昵称 / 游客 / 匿名"等占位前缀开头（避免 fixture 风格的
 *   "测试姓名" 通过校验——P2 批次 SCN-P2-20260429-004 实测漏网）
 *
 * 已知漏网：4 字成语式昵称（如 "执子之魂"），目前拦不住，依赖 Agent 在收名时按
 * prompt 重问；若漏网 case 攒多了再加字典或上 LLM 判断。
 */
const REAL_NAME_REGEX = /^[一-鿿]{2,8}$/u;
const PLACEHOLDER_PREFIX_BLACKLIST = ['测试', '用户', '昵称', '游客', '匿名', '无名', '客户'];

/**
 * 5+ 字纯汉字串中的"昵称提示字"——含这些字几乎都是昵称/口语短句而非真名。
 *
 * 设计思路：5+ 字真名（多见于少数民族，如"布买日也木"/"阿不力克木"）每字独立、无语义动词；
 * 5+ 字昵称（如"小晴早点睡"/"加油宝贝吖"）通常含动词、情绪词或常见叠词。
 *
 * 不做"白名单"（覆盖不全），只在 5+ 字时做"含昵称提示字 → 拒"的负判断。
 */
const NICKNAME_HINT_CHARS = new Set([
  // 动词
  '睡',
  '吃',
  '玩',
  '笑',
  '哭',
  '爱',
  '恨',
  '想',
  '念',
  '走',
  '跑',
  '飞',
  '跳',
  '叫',
  '听',
  '看',
  '说',
  '问',
  '答',
  // 情绪/形容
  '困',
  '累',
  '快',
  '慢',
  '甜',
  '苦',
  '萌',
  '帅',
  '美',
  '丑',
  '好',
  '坏',
  '乖',
  '皮',
  // 常见昵称语气/句末
  '吖',
  '呀',
  '哒',
  '哦',
  '呢',
  '哈',
  '嘛',
  '呐',
  '吗',
  '咯',
  '嘞',
  '哟',
  // 鼓励语
  '加',
  '油',
  '冲',
  '稳',
  '赢',
  '胜',
  // 网名常见装饰词
  '点',
  '宝',
  '贝',
  '酱',
  '崽',
  '仔',
]);

function looksLikeLongChineseNickname(value: string): boolean {
  if (value.length <= 4) return false;
  for (const ch of value) {
    if (NICKNAME_HINT_CHARS.has(ch)) return true;
  }
  return false;
}

export function isLikelyRealChineseName(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!REAL_NAME_REGEX.test(trimmed)) return false;
  for (const prefix of PLACEHOLDER_PREFIX_BLACKLIST) {
    if (trimmed.startsWith(prefix)) return false;
  }
  // 5-8 字纯汉字含昵称提示字 → 拒；典型场景：'小晴早点睡' / '加油宝贝吖' / '小可爱'
  if (looksLikeLongChineseNickname(trimmed)) return false;
  return true;
}
