import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

const COMBINATION_SCHEDULE_QUERY_PATTERN = /组合(?:排班|班次)/u;
const COMBINATION_SCHEDULE_QUESTION_PATTERN =
  /(?:什么(?:意思)?|啥意思|怎么(?:理解|排)|如何安排|是不是|是否|代表|意味着|指的是|每天|早中晚|都要上|[？?])/u;
const WEEKLY_FREQUENCY_PATTERN = /(?:每周|一周|周频|周出勤|出勤天数)/u;
const WEEKLY_FLOOR_PATTERN =
  /(?:有[^，,；;。！？!?:：\n]{0,16}(?:底线|最低要求)|(?:至少|起码|最低)(?:每周|一周)?|(?:每周|一周|周出勤|出勤天数)[^，,；;。！？!?:：\n]{0,16}(?:必须|需要)(?:至少|达到|保证|出勤|上(?:满|够)?|工作))/u;
const WEEKLY_MISMATCH_PATTERN =
  /(?:很难|难以|不太|基本不|通常不|肯定不|一定不|无法)(?:直接)?(?:匹配|适合|兼顾)|不(?:匹配|适合)/u;
const GENERIC_COMBINATION_SCOPE_PATTERN =
  /(?:组合(?:排班|班次)|这类(?:排班|班次|岗位)|这种(?:排班|班次|岗位)|此类(?:排班|班次|岗位)|通常|一般(?:都|会)|普遍)/u;
const SPECIFIC_JOB_SCOPE_PATTERN =
  /(?:(?:这个|该|当前|本|这份|上述|以下|查到的|查询到的|本次查询的|这批)(?:组合排班)?(?:岗位|职位|门店)|具体岗位|岗位(?:详情|信息|页面|明确要求)|招聘信息)/u;
const SAFE_WEEKLY_SEPARATION_PATTERN =
  /(?:不代表|不等于|不意味着|不能据此|无法据此|没有(?:固定|统一)?(?:的)?(?:周频|周出勤|出勤天数|最低要求|底线)|不决定|相互独立|独立的周频|(?:要|需)?(?:另|具体|实际)?看(?:下)?(?:具体|实际)?岗位|取决于(?:具体|实际)?岗位|以(?:具体|实际)?岗位[^。！？\n]{0,16}(?:为准|要求)|(?:如果|若)(?:具体|实际)?岗位)/u;
const CLAIM_CLAUSE_SEPARATOR_PATTERN = /[，,；;：:\n]+|(?<!不)(?:但是|但|不过|然而|可是|却)/u;

const GENERAL_HEALTH_QUERY_SCOPE_PATTERN =
  /(?:一般情况|一般来说|所有|全部|任何|每个|普遍|不同(?:岗位|品牌|门店)|要求(?:会不会|是否)[^。！？\n]{0,12}(?:不同|一样)|是不是[^。！？\n]{0,16}都|是否[^。！？\n]{0,16}都|餐饮(?:类)?岗位[^。！？\n]{0,16}(?:都|必须|需要))/u;
const HEALTH_STAGE_PROPORTION_PATTERN =
  /(?:(?:大部分|大多数|多数|绝大多数|少数|极少数|极少部分|普遍)(?:的)?(?:岗位|门店|品牌)?|(?:餐饮(?:类)?(?:岗位|行业)|岗位|门店|品牌)(?:通常|一般)|(?:通常|一般)(?:都|会|是|要求|需要|得))[^。！？\n]{0,56}(?:面试前|入职前|录用前|录用后|入职后|先面试|先办(?:理)?|再办(?:理)?|办(?:理)?(?:食品)?健康证|持证|有证)/gu;
const CLAIM_NEGATION_PREFIX_PATTERN =
  /(?:不是|并非|并不是|不一定|未必|不能说|不可认为|不代表|没有依据(?:说|认为))[^，,；;。！？\n]{0,24}$/u;
const CLAIM_INTERNAL_NEGATION_PATTERN =
  /(?:(?:并不|不都|不是|未必|不一定)[^，,；;。！？\n]{0,16}(?:需要|必须|要求)|(?:不需要|无需|不用)(?:办理|持有|有)?(?:食品)?健康证)/u;
const CLAIM_QUESTION_PATTERN = /(?:是否|是不是|会不会|要不要|需不需要|吗|么)/u;
const CLAIM_DENIAL_SUFFIX_PATTERN =
  /^[\s"'“”‘’「」『』（）()，,；;：:、-]{0,8}(?:(?:(?:这|该|上述)(?:个)?说法|这种说法|该结论)(?:并不|不)(?:准确|正确|成立|严谨|可信)|(?:(?:这|该|上述)(?:个)?说法|这种说法|该结论)(?:是)?(?:错误的?|有误)|不能一概而论|并非如此|没有依据|不成立)/u;

function isCombinationScheduleQuestion(userMessage?: string): boolean {
  const message = userMessage ?? '';
  return (
    COMBINATION_SCHEDULE_QUERY_PATTERN.test(message) &&
    COMBINATION_SCHEDULE_QUESTION_PATTERN.test(message)
  );
}

function isGeneralHealthCertificateQuestion(userMessage?: string): boolean {
  const message = userMessage ?? '';
  return /健康证/u.test(message) && GENERAL_HEALTH_QUERY_SCOPE_PATTERN.test(message);
}

function isNegatedClaim(sentence: string, index: number, matchedText: string): boolean {
  const prefix = sentence.slice(Math.max(0, index - 32), index);
  const suffix = sentence.slice(index + matchedText.length, index + matchedText.length + 40);
  return (
    CLAIM_NEGATION_PREFIX_PATTERN.test(prefix) ||
    CLAIM_INTERNAL_NEGATION_PATTERN.test(matchedText) ||
    CLAIM_QUESTION_PATTERN.test(matchedText) ||
    CLAIM_DENIAL_SUFFIX_PATTERN.test(suffix)
  );
}

function containsAffirmativeHealthStageProportion(sentence: string): boolean {
  for (const match of sentence.matchAll(HEALTH_STAGE_PROPORTION_PATTERN)) {
    if (!isNegatedClaim(sentence, match.index ?? 0, match[0])) return true;
  }
  return false;
}

/**
 * “组合排班”只描述日内班次组合/轮换，本身不能推出任何周频底线。
 * 仅在候选人当前正询问该标签、且回复作出泛化断言时启用；明确归属于某个具体岗位
 * 或本次查询结果的周出勤陈述不在本规则范围内。
 */
export function detectCombinationScheduleWeeklyGeneralization(
  replyText: string,
  _toolCalls: AgentToolCall[],
  userMessage?: string,
): RuleContradiction | null {
  if (!isCombinationScheduleQuestion(userMessage)) return null;

  const sentences = replyText
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (!GENERIC_COMBINATION_SCOPE_PATTERN.test(sentence)) continue;

    const clauses = sentence
      .split(CLAIM_CLAUSE_SEPARATOR_PATTERN)
      .map((clause) => clause.trim())
      .filter(Boolean);

    const hasUnsafeGenericClaim = clauses.some((clause) => {
      if (SPECIFIC_JOB_SCOPE_PATTERN.test(clause)) return false;
      if (!WEEKLY_FREQUENCY_PATTERN.test(clause)) return false;
      if (SAFE_WEEKLY_SEPARATION_PATTERN.test(clause)) return false;
      return WEEKLY_FLOOR_PATTERN.test(clause) || WEEKLY_MISMATCH_PATTERN.test(clause);
    });
    if (!hasUnsafeGenericClaim) continue;

    return {
      ruleId: 'combination_schedule_weekly_generalization',
      label:
        '回复把“组合排班”标签本身泛化成周出勤底线或低周频难匹配；组合排班只描述班次组合/轮换，周频必须另看具体岗位',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  return null;
}

/**
 * 餐饮类工作一律需要健康证，这是已确认的业务口径，可以直接回答。
 * 本规则只禁止编造大部分/极少数岗位在哪个阶段办证的比例；办理阶段仍需看具体岗位。
 */
export function detectHealthCertificateGeneralization(
  replyText: string,
  _toolCalls: AgentToolCall[],
  userMessage?: string,
): RuleContradiction | null {
  if (!isGeneralHealthCertificateQuestion(userMessage)) return null;

  const sentences = replyText
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (containsAffirmativeHealthStageProportion(sentence)) {
      return {
        ruleId: 'health_certificate_generalization',
        label: '回复无依据编造大部分/极少数餐饮岗位在哪个阶段办理健康证的比例',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }

  return null;
}
