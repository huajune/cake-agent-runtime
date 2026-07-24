/**
 * 确定性 repair 回归检测（纯函数，零 LLM）。
 *
 * 背景（2026-07-24 守卫审计）：二审只判「修复版是否违规」，不比较「相对首版是否退步」，
 * 导致两类已实际投递的坏修复：
 * - 结构压扁：首版逐行报名表/岗位详情被 repair 压成一句话流水账
 *   （trace batch_6a609570…、batch_6a606a01…）；
 * - 结论极性反转：首版给出具体岗位，修复版断言"附近没找到在招的岗位"
 *   （trace batch_6a606ac5…，同条消息内自相矛盾）。
 *
 * 命中任一形态即判定 repair 回归，runner 应弃用修复版、回退首版
 * （reason_code=repair_regression_reverted:<形态>）。检测刻意保守：宁可漏判
 * 交给二审，不误伤正常的精简改写。
 */

export type RepairRegressionKind = 'structure_collapsed' | 'polarity_reversed';

/** 表单字段行：`姓名：` / `联系电话：13xxx` / `面试时间（…）：` 等短标签开头的行。 */
const FORM_FIELD_LINE_PATTERN = /^[-•\s]*[^：:\n]{1,14}[：:]/u;

/**
 * 岗位事实行：含距离/时薪/班次时段等硬数据的行。首版出现多行即认为在向候选人
 * 展示具体岗位内容。
 */
const JOB_FACT_PATTERN =
  /\d+(?:\.\d+)?\s*(?:公里|km|KM)|\d+\s*元\/(?:小?时|天|月)|\d{1,2}[:：]\d{2}\s*[-—~至]\s*\d{1,2}[:：]\d{2}/u;

/** 无岗断言：修复版声称附近/该区域没有（在招）岗位。 */
const NO_JOB_CLAIM_PATTERN =
  /(?:没找到|没查到|未找到|找不到|暂时?没有|暂无)[^。！？!?\n]{0,12}(?:岗位|工作|在招)|(?:岗位|工作)[^。！？!?\n]{0,8}(?:没有|暂无|没找到|没查到)/u;

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function countStructuredLines(text: string): number {
  return splitLines(text).filter(
    (line) => FORM_FIELD_LINE_PATTERN.test(line) || JOB_FACT_PATTERN.test(line),
  ).length;
}

function countJobFactLines(text: string): number {
  return splitLines(text).filter((line) => JOB_FACT_PATTERN.test(line)).length;
}

/**
 * 检测修复版相对首版是否发生回归。返回回归形态；未检出返回 null。
 *
 * - structure_collapsed：首版含 ≥3 行结构化内容（表单字段/岗位事实），修复版结构化行数
 *   掉到首版 1/3 以下且总长缩水到 60% 以下。单独的长度缩水不算——精简是合法修复。
 * - polarity_reversed：首版含 ≥2 行岗位事实（正在展示具体岗位）且自身没有无岗断言，
 *   修复版新增了"附近没有岗位"类断言。首版本来就说无岗时不判（无极性变化）。
 */
export function detectRepairRegression(
  firstText: string,
  revisedText: string,
): RepairRegressionKind | null {
  const first = firstText.trim();
  const revised = revisedText.trim();
  if (!first || !revised || first === revised) return null;

  const firstStructured = countStructuredLines(first);
  if (firstStructured >= 3) {
    const revisedStructured = countStructuredLines(revised);
    const collapsed =
      revisedStructured * 3 < firstStructured && revised.length < first.length * 0.6;
    if (collapsed) return 'structure_collapsed';
  }

  if (
    countJobFactLines(first) >= 2 &&
    !NO_JOB_CLAIM_PATTERN.test(first) &&
    NO_JOB_CLAIM_PATTERN.test(revised)
  ) {
    return 'polarity_reversed';
  }

  return null;
}
