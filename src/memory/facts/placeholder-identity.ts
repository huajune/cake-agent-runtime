import {
  isIdentityAskMessage,
  stripMessageDecorations,
} from '@tools/shared/identity-statement.util';

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

/** 已知占位/示例手机号（演示号段、测试脱敏值、顺序数字）。 */
const PLACEHOLDER_PHONES = new Set([
  '13800138000', // 移动演示号，也是历史提取提示词里的 phone 示例值
  '13800000000', // 测试资产脱敏统一值
  '13900139000',
  '12345678901',
]);

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
  if (digits.length !== 11) return false;
  if (PLACEHOLDER_PHONES.has(digits)) return true;
  return /^1(\d)\1{9}$/.test(digits);
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
