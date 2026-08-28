/**
 * 姓名字段唯一解析器（形态判定 + 单条文本提取）。
 *
 * booking 直接出处闸门在 candidate/identity-attribution；确认式作证由 collection 字段提案的
 * agentQuestionQuote 主通道承担。本文件只回答"这段文本里是不是一个姓名、像不像真名"。
 * 注释里的 badcase 是各判据的裁决记录，改口径前先读它们（原居所 memory/facts/name-guard
 * 与 tools/shared/candidate-field-parser 两轨，2026-08 合一于此）。
 */

import { stripTimeContext } from '@resolution/signal/markers';
import type { CandidateParseResult } from './types';

/**
 * 微信加好友自动打招呼语「（你好，）我是XX」的昵称提取。XX 通常是微信昵称而非真名——
 * 直接当姓名会导致收资表被昵称预填、临约面才补问真名。
 * 包含其他内容的消息（"我是张三，想了解下岗位"）放过；只拦纯打招呼句式。
 *
 * 匹配前必须剥时间后缀：短期记忆给每条消息追加 `[消息发送时间：…]`，
 * badcase `batch_69e9bba2536c9654026522da_*` 中 `$` 锚点被后缀击穿、昵称漏网。
 */
const AUTO_GREETING_REGEX =
  /^\s*(?:(?:你好|您好|hi|hello)[，,。！!\s]*)?我是([^\s。，,！!？?]+?)[。，,！!\s]*$/iu;

/**
 * 结构化收资表单回填「姓名：X」的键值对识别（行首锚定）。
 * badcase ci7iigv4 / 362ketwp：T1"我是赵堤"被判打招呼昵称后，候选人按模板回填
 * "姓名：赵堤"——结构化回填可信度远高于打招呼语，是昵称拦截的救援出口。
 */
const STRUCTURED_NAME_REGEX =
  /(?:^|[\n\r])\s*(?:姓名|名字)\s*[：:\s]\s*([^\n\r。，,！!？?]+?)(?=[\n\r]|$)/u;

/**
 * 自我介绍前缀（"我是/我叫"）。badcase chat 6a69674e：候选人昵称是"18"，打招呼语
 * 整条就是"我是18"，抽取模型把**带前缀的整句**"我是18"当 name 输出——与剥离后的
 * 昵称"18"不等，昵称判据失配漏网。真名不可能以"我是/我叫"开头，此前缀既用于比对前
 * 归一化，也单独作为丢弃信号。
 */
const SELF_INTRO_PREFIX_REGEX = /^\s*(?:(?:你好|您好|hi|hello)[，,。！!\s]*)?我(?:是|叫)\s*/iu;

/**
 * 称谓/商号后缀：以此结尾的不是姓名。badcase chat 6a1e42c5：「大门先生」（品牌
 * "大米先生"的错字）被抽成姓名并连带推出 gender=男，跨 3 轮未纠正。
 * 刻意不用品牌目录做判据——错字品牌不在目录里，目录门拦不住；称谓后缀才是稳定判据，
 * 且对目录内商号（"大米先生"）同样生效。中文人名不以这些词收尾，误伤面为零。
 * 统一收在 checkChineseName 里而非只在某个 sanitizer：真名索取问答逃生口整条绕过
 * sanitizer，而"大米先生"恰是 4 汉字能过严格档——只在一处设门会被架空
 * （「一处识别器、多处消费」纪律，9fdbf84c）。
 */
const HONORIFIC_SUFFIX_REGEX = /(?:先生|女士|小姐|夫人|太太|老师|师傅|老板)$/u;

/**
 * 中文真名形态：2-5 字纯 CJK（宽松档，5 字覆盖少数民族如"布买日也木"）/ 2-4 字（严格档）。
 * 6+ 字一刀切拒——微信昵称 6 字以上极常见（"小晴早点睡"），6 字真名在招聘场景几乎不存在。
 * 已知漏网：4 字成语式昵称（"执子之魂"），依赖 Agent 收名时重问。
 */
const REAL_NAME_REGEX = /^[一-鿿]{2,5}$/u;
const REAL_NAME_STRICT_REGEX = /^[一-鿿]{2,4}$/u;
const PLACEHOLDER_PREFIX_BLACKLIST = ['测试', '用户', '昵称', '游客', '匿名', '无名', '客户'];

/**
 * 整句锚定类识别器（打招呼语/确认句/肯定答复）匹配前必须先过这一层。
 * 时间后缀会让 `$` 失配，因此任何整条消息的锚定判断都必须先剥离它。
 */
export function stripTimeContextSuffix(message: string): string {
  return stripTimeContext(message);
}

export function extractAutoGreetingName(message: string): string | null {
  if (!message) return null;
  return AUTO_GREETING_REGEX.exec(stripTimeContext(message).trim())?.[1] ?? null;
}

export function isFromAutoGreeting(name: string, userMessages: readonly string[]): boolean {
  return userMessages.some((message) => extractAutoGreetingName(message) === name);
}

export function hasStructuredNameSubmission(
  name: string,
  userMessages: readonly string[],
): boolean {
  const target = name.trim();
  if (!target) return false;
  return userMessages.some((message) => {
    const match = STRUCTURED_NAME_REGEX.exec(stripTimeContext(message ?? ''));
    return match?.[1]?.trim() === target;
  });
}

/** 剥离 name 值上的自我介绍前缀；无前缀时原样返回。 */
export function stripSelfIntroPrefix(name: string): string {
  return name.replace(SELF_INTRO_PREFIX_REGEX, '').trim();
}

export function hasHonorificSuffix(name: string): boolean {
  return HONORIFIC_SUFFIX_REGEX.test(name.trim());
}

function checkChineseName(value: string | null | undefined, regex: RegExp): boolean {
  const trimmed = value?.trim() ?? '';
  if (!regex.test(trimmed)) return false;
  if (PLACEHOLDER_PREFIX_BLACKLIST.some((prefix) => trimmed.startsWith(prefix))) return false;
  return !hasHonorificSuffix(trimmed);
}

/** 规则提取使用的宽松档（2-5 字），允许少数民族 5 字真名通过。 */
export function isLikelyRealChineseName(value: string | null | undefined): boolean {
  return checkChineseName(value, REAL_NAME_REGEX);
}

/**
 * booking/precheck 硬 guard 使用的严格档（2-4 字）。
 * 5 字纯 CJK 有较高概率是昵称，不直接进预约接口；5 字真名走转人工补录。
 */
export function isStrictRealChineseName(value: string | null | undefined): boolean {
  return checkChineseName(value, REAL_NAME_STRICT_REGEX);
}

export function extractStructuredName(message: string): string | null {
  const candidate = STRUCTURED_NAME_REGEX.exec(stripTimeContext(message))?.[1]?.trim();
  return isLikelyRealChineseName(candidate) ? candidate! : null;
}

/** 结构化姓名解析及其原文片段，供候选事实生产链复用同一证据。 */
export function extractStructuredNameMatch(message: string): CandidateParseResult<string> | null {
  const cleaned = stripTimeContext(message);
  const match = STRUCTURED_NAME_REGEX.exec(cleaned);
  const value = match?.[1]?.trim();
  return isLikelyRealChineseName(value) ? { value: value!, excerpt: match![0].trim() } : null;
}

/**
 * user_text 权威出处解析（booking 姓名闸门的取证函数）：只认结构化"姓名：X"与
 * 自述"我叫X"，经严格真名校验、排打招呼语昵称。产物按 candidate_quote 消费，
 * 判不出就返回 null，绝不猜。
 */
export function parseName(text: string): CandidateParseResult<string> | null {
  const cleaned = stripTimeContext(text);
  const structured = STRUCTURED_NAME_REGEX.exec(cleaned);
  const inlineStructured = /(?:姓名|名字)\s*[：:\s]\s*([^\s。，,！!？?\n]+)/u.exec(cleaned);
  const declared = /我叫\s*([^\s。，,！!？?\n]+)/u.exec(cleaned);
  const match = [structured, inlineStructured, declared].find((item) =>
    isStrictRealChineseName(item?.[1]?.trim()),
  );
  const candidate = match?.[1]?.trim();
  if (!candidate || extractAutoGreetingName(cleaned) === candidate) return null;
  return { value: candidate, excerpt: match![0].trim() };
}

/**
 * 姓名形态门：纯数字（含手机号）不可能是姓名。
 * badcase：LLM 把手机号写进 interview_info.name（evidence 原文
 * "**name / phone**：沿用已确认事实 13788930869"），打招呼语 sanitizer 只拦昵称，
 * 纯数字值直接穿透。口径：去掉分隔符（空格/连字符/加号/括号）后不含任何非数字字符
 * 才判纯数字——"+8613812345678"、"138(1234)5678" 都要拦，含数字的真实昵称不误伤。
 */
export function isDigitsOnlyName(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return false;
  return /^[\d\s\-+()（）]+$/u.test(trimmed) && /\d/.test(trimmed);
}
