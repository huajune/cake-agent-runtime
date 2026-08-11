import {
  isIdentityAskMessage,
  stripMessageDecorations,
} from '@resolution/candidate/student-identity';
import {
  isPlaceholderPhone as isCandidatePlaceholderPhone,
  isStorableCandidatePhone as isCandidatePhoneStorable,
} from '@resolution/candidate/phone';
import { hasHealthCertificateTopic } from '@resolution/candidate/health-cert';

/**
 * 占位身份识别 — 提示词示例值回声（example echo）防线。
 *
 * 背景（badcase 2026-07-22，chat 6a50a075… / 6a60806d… 等 4 例）：
 * 抽取角色被切到弱指令遵循模型后，把 session-extraction.prompt 字段定义里的
 * 示例值（"张三"/"13800138000"/"肯德基服务员4个多月"…）当默认值整套填进
 * 结构化输出；臆造档案经 [已确认事实] 增量机制轮轮延续，最终以假名假号
 * 成功提交了真实报名工单。
 *
 * 当前接入点：抽取出口（session.service callLLM 的 validateOutput）——输出命中
 * 回声特征即判本次生成失败，走重试/降级，臆造事实进不了记忆。
 * isPlaceholderPhone / isPromptExampleName 保持独立导出，供后续 booking 入口
 * 兜底占位身份时复用（尚未接入）。
 */

/** 提取提示词历史上出现过的示例姓名。真实重名存在，故仅作组合信号，不单独拦。 */
const PROMPT_EXAMPLE_NAMES = new Set(['张三', '李四', '王五']);

/** 提取提示词 experience 字段的示例原文。可能与真实经历撞车，仅作组合信号。 */
const PROMPT_EXAMPLE_EXPERIENCES = new Set(['肯德基服务员4个多月', '河南烤肉自助服务员3个月']);

/**
 * 是否占位手机号：已知清单 + 后 10 位全同数字（如 11111111111）。
 * 输入先归一化为纯数字，容忍空格/连字符等格式差异。
 */
export function isPlaceholderPhone(phone: string | null | undefined): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  return isCandidatePlaceholderPhone(digits) || /^1(\d)\1{9}$/.test(digits);
}

/** 是否提示词示例姓名（组合信号用，调用方不得据此单独拦截）。 */
export function isPromptExampleName(name: string | null | undefined): boolean {
  return PROMPT_EXAMPLE_NAMES.has((name ?? '').trim());
}

/**
 * 抽取 LLM 输出的示例回声校验，挂 generateStructured 的 validateOutput 钩子。
 * 抛错 = 本次生成失败，执行器按 API 错误同策略重试/降级到备用模型；
 * 全链失败时抽取降级为空（本轮丢新事实，旧值不受影响），远优于假事实入库。
 *
 * 判定规则：
 * - phone 为占位号 → 直接判回声（占位号不存在合法来源）
 * - name 与 experience 同时命中示例原文 → 判回声（单一命中可能是真实撞名/撞经历，放行）
 */
export function assertNoExtractionExampleEcho(output: unknown): void {
  const info = (output as { interview_info?: Record<string, unknown> } | null)?.interview_info;
  if (!info) return;

  const phone = typeof info.phone === 'string' ? info.phone : null;
  if (phone && isPlaceholderPhone(phone)) {
    throw new Error(`提取输出命中占位手机号（疑似提示词示例回声）: phone=${phone}`);
  }

  const name = typeof info.name === 'string' ? info.name : null;
  const experience = typeof info.experience === 'string' ? info.experience.trim() : null;
  if (
    name &&
    isPromptExampleName(name) &&
    experience &&
    PROMPT_EXAMPLE_EXPERIENCES.has(experience)
  ) {
    throw new Error(
      `提取输出同时命中示例姓名与示例经历（疑似提示词示例回声）: name=${name}, experience=${experience}`,
    );
  }
}

/**
 * 身份字段出处校验（badcase 2026-07-24，chat 6a4f520a…）：
 *
 * 列表式回声防线只认已知示例值；弱模型换一套**新造**姓名/手机号（"赵堤/18833669895"）
 * 即穿透，臆造档案再经 [已确认事实] 增量机制以"沿用"名义轮轮延续，最终被预填进
 * 报名收资表发给候选人。
 *
 * 不变式：name / phone 属候选人自报身份，只可能来自提取 prompt 文本
 * （消息窗口原文、[已确认事实] 携带的旧值、或图片描述注入文本），
 * 不存在"凭空正确"的合法来源。输出值在 prompt 中找不到即判臆造，本次生成失败
 * 走重试/降级（降级=本轮丢新事实，旧值不受影响，远优于假身份入库）。
 *
 * 匹配口径：
 * - phone：prompt 与输出都压缩为纯数字流后做子串匹配，容忍"158 8726 5838"等分隔写法；
 * - name：prompt 去空白后做子串匹配（候选人姓名在中文语料中不会被空白拆散跨行）。
 */
export function assertExtractionIdentityProvenance(output: unknown, promptText: string): void {
  const info = (output as { interview_info?: Record<string, unknown> } | null)?.interview_info;
  if (!info) return;

  const phone = typeof info.phone === 'string' ? info.phone.trim() : '';
  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length >= 7) {
    const promptDigits = promptText.replace(/\D/g, '');
    if (!promptDigits.includes(phoneDigits)) {
      throw new Error(`提取输出的手机号在提取上下文中无出处（疑似臆造身份）: phone=${phone}`);
    }
  }

  const name = typeof info.name === 'string' ? info.name.trim() : '';
  if (name.length >= 2) {
    const promptCondensed = promptText.replace(/\s/g, '');
    if (!promptCondensed.includes(name)) {
      throw new Error(`提取输出的姓名在提取上下文中无出处（疑似臆造身份）: name=${name}`);
    }
  }
}

// —— 手机号形态门（badcase 2026-07-29，chat 6a69674e… / 6a69790b…）————————————

/**
 * 抽取输出的手机号形态校验。
 *
 * `assertExtractionIdentityProvenance` 的出处门只在数字流 ≥7 位时生效——短垃圾值
 * （昵称"18"、"100％"）位数不够，直接绕过出处校验落库，随后经 [已确认事实] 逐轮沿用，
 * 并被预填进收资表发给候选人。
 *
 * 不变式：interview_info.phone 只有一种合法形态——11 位中国大陆手机号；任何其它形态
 * 对下游（precheck/booking/预填）都无用且有害，字段级丢弃不损失任何真实信息。
 */
export function isStorableCandidatePhone(phone: string | null | undefined): boolean {
  return isCandidatePhoneStorable(phone);
}

// —— 明示型字段窗口出处门（badcase 2026-07-29，同上两 chat）————————————————

/** 出处比对归一化：去空白与常见分隔/括号，容忍"M Stand（大运天地店）"式包装差异。 */
function normalizeForProvenance(text: string): string {
  return text.replace(/[\s()（）【】\[\]{}·・\-—－_、,，。.]/gu, '');
}

/**
 * 字段值在本轮抽取上下文（候选人原文 + 助手原文 + 旧值）中是否有出处。
 *
 * 适用范围严格限定于**字段定义本身已声明"只能来自明示"**的字段：
 * - applied_store：候选人自述或助手推荐过的门店名，必是对话文本里出现过的串；
 * - household_register_province：字段规则明写"只在候选人主动透露时提取，不得据现居地推断"。
 *
 * 刻意不覆盖可合法推断的字段（education 由"读大三"推出"本科在读"、height 由
 * "一米七五"推出"175"），避免出处门错杀真实提取。
 */
export function hasFieldProvenanceInWindow(
  value: string | null | undefined,
  contextTexts: readonly string[],
): boolean {
  const normalizedValue = normalizeForProvenance((value ?? '').trim());
  if (normalizedValue.length < 2) return true;
  return contextTexts.some((text) => normalizeForProvenance(text).includes(normalizedValue));
}

// —— 健康证首写证据门（badcase 2026-07-29，同上两 chat）——————————————————

/**
 * 健康证话题词。与 is_student 证据门同一取向：宽松，只拦"零语境凭空发明"。
 * 口语简称（"有证的吧""还没办证""要带证吗"）一并收进来——宁可放过含糊语境，
 * 不可错杀真实提取。
 */
/**
 * 会话段内是否谈过健康证。
 *
 * 背景：两例 chat 的抽取输出在全程没出现过"健康证"三个字的会话里写下
 * has_health_certificate="有"。该值会直接放行 booking 的有证 gate，是本组臆造字段里
 * 后果最重的一个（无证候选人被约到要求持证的岗位）。值域只有"有/无/愿意办理"等短词，
 * 无法做子串出处校验，改用与 is_student 同构的话题词证据门，由调用方限定首写时生效。
 */
export function hasHealthCertificateTopicEvidence(
  userTexts: readonly string[],
  assistantTexts: readonly string[],
): boolean {
  const hit = (text: string): boolean => hasHealthCertificateTopic(stripMessageDecorations(text));
  return userTexts.some(hit) || assistantTexts.some(hit);
}

// —— is_student 首写证据门（badcase 2026-07-28，chat 6a673402…）——————————————

// 候选人侧身份词汇。宽松取向：门的职责是拦"零身份语境凭空发明布尔值"，不是精确
// 判定身份——宁可放过含糊语境，不可错杀合法提取（错杀会重蹈 6a448d09 追问死锁）。
const IS_STUDENT_TOPIC_RE =
  /学生|社会人士|社会人|在读|在校|上学|读书|学信网|毕业|退休|宝妈|应届|大一|大二|大三|大四|研究生|高中生|本科|大专|上班族|已经工作|工作了|在上班|暑假|暑期|寒假/u;

/**
 * 会话段内是否存在 is_student 的可辩护提取语境：
 * - 候选人消息（剥引用块/时间戳后）含身份词汇；或
 * - 助手发过身份追问/确认/二选一问句（isIdentityAskMessage）——覆盖
 *   "你是社会人士对吧？→ 是的"类确认式作答；表单模板行刻意不算
 *   （模板在场不代表候选人谈过身份）。
 *
 * 背景：chat 6a673402 抽取模型在候选人只说过"川沙"时输出 is_student=false，
 * evidence 原文自证"未提及，不填"仍照写，随后经 [已确认事实] 逐轮延续。布尔值
 * 无法像 name/phone 做 prompt 子串出处校验（assertExtractionIdentityProvenance），
 * 改用本词表证据门；由调用方限定"首写"（旧值为空）时生效，已确认值的沿用不受影响。
 */
export function hasIsStudentTopicEvidence(
  userTexts: readonly string[],
  assistantTexts: readonly string[],
): boolean {
  if (userTexts.some((text) => IS_STUDENT_TOPIC_RE.test(stripMessageDecorations(text)))) {
    return true;
  }
  return assistantTexts.some((text) => isIdentityAskMessage(text));
}
/**
 * 会话事实写入侧的确定性形状门（badcase 6a6c4c13，2026-07-31）。
 *
 * 该案候选人只说了"boss/做兼职/在长安/晚上才可以，有吗？"，一次抽取把整句
 * "晚上才可以，有吗？"同时写进 pref.city（还被归一化抬成 confidence=high/
 * evidence=explicit_city）、pref.salary、interview.age——标量扇出污染
 * （2026-08-03 抽样 12% 会话中招）。高置信垃圾城市还会压制后续确认问答裁决，
 * 让真实城市写不进去。
 *
 * 两类门都是纯函数，由 session.service extractFacts 的字段门族调用：
 * - 扇出熔断：同一非空字符串同轮写进 ≥3 个字段 → 该值所有字段整组丢弃；
 * - 形状门：city/age 的值必须长得像城市/年龄，否则字段级丢弃。
 */

/** 同一字符串值命中 ≥N 个字段视为扇出广播（判据来自污染实测：name=age=gender 同值）。 */
export const SCALAR_FANOUT_FIELD_THRESHOLD = 3;

/**
 * 检出被扇出广播的字符串值。
 *
 * 输入是"字段名 → 已解包值"的平面映射；仅统计 trim 后长度 ≥2 的字符串
 * （布尔/数字/数组不参与——它们的重复是正常业务形态，如多字段 false）。
 */
export function detectScalarFanoutValues(fields: Record<string, unknown>): Set<string> {
  const counts = new Map<string, number>();
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length < 2) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  const fanout = new Set<string>();
  for (const [value, count] of counts) {
    if (count >= SCALAR_FANOUT_FIELD_THRESHOLD) fanout.add(value);
  }
  return fanout;
}

/**
 * 城市值门：值必须能被行政区数据认领，否则字段级丢弃。
 *
 * 2026-08-06 生产观测推翻了原先"8 字内自由放行"的写法——该放行口对当期观测到的
 * 11 个垃圾城市只拦住 3 个（`00:30`/整句/带疑问尾词的），`hello`、`null`、
 * `只晚班`、`我是应聘的`、`平坊` 这些短串全部直通。短串靠形状分辨不出真假城市，
 * 判据只能是数据表认领（同一批值喂给行政区表：垃圾全否、真城市全是，含海南东方市）。
 */
export { isRecognizedCityName as isPlausibleCityValue } from '@resolution/geo';
export { isPlausibleAgeValue } from '@resolution/candidate/age';
