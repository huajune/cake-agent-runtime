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
