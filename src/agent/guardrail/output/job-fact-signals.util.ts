/**
 * 岗位硬事实信号（纯正则，零 LLM）。
 *
 * "距离 / 时薪 / 发薪日 / 班次时段"这类量化数据只可能来自岗位工具证据——模型无法从
 * 通识推出某门店离候选人 0.5km、时薪 22 元、每月 15 号发薪。因此它们既是
 * "回复正在展示具体岗位内容"的判据（repair 回归闸），也是"零证据回合仍在编造岗位"
 * 的判据（语义 shadow 门控）。两处共用一份定义，避免口径漂移。
 */

/** 岗位硬事实：距离（km/公里）、单位薪资（元/时·天·月）、班次时段（HH:MM-HH:MM）。 */
export const QUANTIFIED_JOB_FACT_PATTERN =
  /\d+(?:\.\d+)?\s*(?:公里|km|KM)|\d+\s*元\/(?:小?时|天|月)|\d{1,2}[:：]\d{2}\s*[-—~至]\s*\d{1,2}[:：]\d{2}/u;

/** 发薪日：`每月15号发薪` / `15 号发薪` / `20号发工资`。 */
const PAY_DAY_PATTERN = /\d{1,2}\s*号\s*(?:发薪|发工资|结算)/u;

/**
 * 文本是否含只能由岗位工具证据支撑的量化事实。
 *
 * 比 {@link QUANTIFIED_JOB_FACT_PATTERN} 多覆盖发薪日——发薪时点是 2026-07-29
 * chat 6a68392b 整单编造的核心伤害字段（"每月15号发薪"全属虚构），
 * 但它不属于 repair 回归闸的"结构化行"判据，故只在本谓词内叠加。
 */
export function hasQuantifiedJobFact(text: string): boolean {
  return QUANTIFIED_JOB_FACT_PATTERN.test(text) || PAY_DAY_PATTERN.test(text);
}
