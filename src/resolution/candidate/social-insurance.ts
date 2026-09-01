/**
 * 候选人「社保缴纳情况」自陈的唯一识别器。
 *
 * 契约选项是「本人缴纳本地社保 / 无公司在缴社保流水 / 公司缴纳外地社保…」这类系统措辞，
 * 而候选人的自然答案是「无」「没有」「没交过」——optionLabel 逐字直配配不上，槽位收不到值，
 * 两问配额烧完即熔断转人工。
 *
 * 判定边界（刻意窄）：
 * - **只识别否定档**（未缴纳）。「有」「在缴」不识别——缴纳方（本人/公司）与参保地
 *   （本地/外地）共同决定筛选方向，猜错即错筛；留空让模板强制枚举追问是唯一安全出口。
 * - 疑问句不是答案（与 gender / option-matching 同口径）。
 * - 岗位咨询语境不解释（「有没有不用交社保的工作」说的是岗位诉求，不是本人现状）。
 */

export type SocialInsuranceAnswer = 'none';

export interface SocialInsuranceEvidence {
  answer: SocialInsuranceAnswer;
  /** 命中的候选人原话逐字片段（NFKC 归一后），作提案 sourceText 的回查基准。 */
  excerpt: string;
}

const CLAUSE_SPLIT_RE = /(?<=[，,。;；！!？?\n\r])/u;

const QUESTION_CLAUSE_RE = /[？?]\s*$|(?:吗|么|呢|吧)(?:[啊呀嘛])?(?:[！。])?\s*$/u;

/** 岗位咨询/要求语境守卫：句子在谈岗位而非本人现状时不解释。 */
const JOB_TALK_GUARD_RE = /岗位|工作|招|要求|哪(?:个|些|里)|什么样/u;

/**
 * 显式语境档：句内同时点名社保与否定。可在自由语料（轮末安全网扫描）里识别，
 * 因为「社保」锚点把这句话绑定到了字段本身。
 */
const CONTEXTUAL_NONE_RE =
  /(?:无|没有?|未|不)\s*(?:交|缴|买|办)?\s*(?:过|纳)?\s*社保|社保\s*(?:没有?(?:交|缴|买)?过?|无|未\s*缴纳?|不\s*[交缴])/u;

/**
 * 裸短答档：整段文本就是一个否定词。脱离语境的裸否定能回答任何一问（见
 * option-matching「不做终答识别」），故**只有值已绑定到社保槽位时**（表单行回填 /
 * fieldValueProposals 定位后的规范值）才允许按本档解释——绑定关系由调用方以 answerBound 声明。
 */
const BARE_NONE_RE = /^(?:无|没有|没|没交过?|没缴过?|没买过?|未缴纳?|不交)$/u;

export function classifySocialInsuranceAnswerText(
  value: string,
  options?: { answerBound?: boolean },
): SocialInsuranceEvidence | null {
  const text = value.normalize('NFKC').trim();
  if (!text) return null;

  if (options?.answerBound === true && BARE_NONE_RE.test(text)) {
    return { answer: 'none', excerpt: text };
  }

  for (const rawClause of text.split(CLAUSE_SPLIT_RE)) {
    const clause = rawClause.trim();
    if (!clause) continue;
    if (QUESTION_CLAUSE_RE.test(clause)) continue;
    if (JOB_TALK_GUARD_RE.test(clause)) continue;
    if (CONTEXTUAL_NONE_RE.test(clause)) {
      return { answer: 'none', excerpt: clause };
    }
  }
  return null;
}
