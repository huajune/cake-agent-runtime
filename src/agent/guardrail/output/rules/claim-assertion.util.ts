/**
 * 句粒度"声称"判定共享原语。
 *
 * 背景：值级对账规则（job-fact-value-mismatch）从上线起就有"疑问句/否定句不算声称"
 * 的句粒度豁免，但承诺类规则（precheck 可约口径、工具失败成功口径）一直是全文正则
 * 裸匹配。生产假阳（2026-07-06 守卫档案 id=51/104）："**没法**帮你登记报名"被当成
 * 声称可约、诚实修复版"暂时**没能**提交成功"被当成声称成功——完美的拒绝/纠错话术
 * 因为否定盲区被整轮拦掉。
 *
 * 这里把切句、否定、疑问判定收敛成一处，供各规则共用，避免同一豁免逻辑在文件间漂移。
 */

/**
 * 否定语境词。命中即认为该句不构成对 pattern 的"声称"。
 * 注意"不要"：既是否定（"不要早班"是候选人需求复述，不是把岗位说成早班），
 * 也几乎不会出现在真实的成功宣称句里，收进来是安全的。
 */
export const CLAIM_NEGATION_PATTERN =
  /不是|不算|没有|没能|没法|无法|未能|不能|不用|不要|无需|不需要|并非|别的|错/;

/** 疑问语境：问句是征询不是声称。句尾 吗/呢/么 兜底（？被切句保留）。 */
export const CLAIM_QUESTION_PATTERN = /[？?]|[吗呢么]\s*[。！~]*\s*$/;

/** 切句：疑问/否定判定按句子粒度做，避免整段误杀。疑问句被 ？切开后靠句尾语气词兜底识别。 */
export function splitClaimSentences(text: string): string[] {
  return text
    .split(/(?<=[？?])|[。！!\n；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 切小句：否定豁免的判定粒度。只切逗号——顿号是并列不是转折，句号级切分在
 * splitClaimSentences 已完成。
 */
function splitClaimClauses(sentence: string): string[] {
  return sentence
    .split(/[，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 该句是否构成对 pattern 的"声称"（非疑问、非否定）。
 *
 * 疑问豁免保持句粒度：句尾语气词（吗/呢/么）作用于整句。
 * 否定豁免收敛到小句（逗号）粒度：否定词必须与声称词落在同一小句才豁免。
 * 生产反例（2026-07-06 review）：booking 失败后"不用担心，已经帮你报名成功了"——
 * 前小句的"不用"曾把后小句的成功宣称整句洗白，P0 假成功口径因此漏拦；
 * "暂时没能提交成功""没法帮你登记报名"否定与声称同小句，豁免不受影响。
 */
export function assertsClaim(sentence: string, pattern: RegExp): boolean {
  if (!pattern.test(sentence)) return false;
  if (CLAIM_QUESTION_PATTERN.test(sentence)) return false;
  return splitClaimClauses(sentence).some(
    (clause) => pattern.test(clause) && !CLAIM_NEGATION_PATTERN.test(clause),
  );
}

/** 全文任一句构成声称即为 true。 */
export function textAssertsClaim(text: string, pattern: RegExp): boolean {
  return splitClaimSentences(text).some((sentence) => assertsClaim(sentence, pattern));
}
