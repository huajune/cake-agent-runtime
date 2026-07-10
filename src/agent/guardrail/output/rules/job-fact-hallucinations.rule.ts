import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { extractSalaryFacts } from '@tools/duliday/job-list/salary-facts.util';
import { decideLaborFormIntent } from '@memory/facts/labor-form';
import {
  hasUsableJobListResult,
  readLatestJobListCall,
  readLatestUsableJobListCall,
} from './job-list-call.util';
import type { FactRule, RuleContradiction } from '../output-rule.types';

/**
 * 岗位事实幻觉规则。
 *
 * 职责：
 * - 管“回复里的岗位事实没有被本轮岗位工具结果接地”的问题；
 * - 这里的事实包括岗位推荐、薪资结构、工作内容、距离等候选人会据此决策的信息；
 * - 判断重点是“是否有外部工具返回支持”，而不是文案是否自然。
 *
 * 不负责：
 * - 不处理预约/报名/转人工等流程承诺，那些属于 booking-claim-errors 或 false-promises；
 * - 不处理品牌名对账，品牌虽然来自岗位数据，但有单独的 brand-name-errors；
 * - 不处理保险/社保政策，保险政策在业务上更敏感，单独成文件。
 *
 * 动作策略：
 * - 未接地却输出具体岗位推荐用 replan：当前回复不可发，但允许重新查岗后再生成；
 * - 薪资事实错报走 revise；距离完整性由岗位卡渲染器按构造保证，不在本层观察。
 */

// 结构化推荐常见字段。若同一回复出现多个字段，通常说明模型已经在输出具体岗位卡片。
const JOB_FACT_LABEL_PATTERN = /^\s*(?:距离|班次|薪资|要求|工作时间|地址)[：:]/gm;
const JOB_RECOMMENDATION_CONTEXT_PATTERN =
  /推荐|岗位|门店|在招|店员|咖啡师|服务员|全职|兼职|小时工|这家|这两家|附近|离你/;
const JOB_TEMPLATE_LEAK_PATTERN = /推荐对话用模板/;
// 薪资类幻觉只覆盖“岗位工具没有给字段但模型补了政策”的高风险说法。
const SALARY_FABRICATION_PATTERN =
  /节假日(工资|薪资|时薪)?双倍|节假日(工资|薪资|时薪)(不一样|更高|翻倍)|周末(加薪|双倍|涨)|工资(按表现|按业绩|按绩效)?浮动|薪资面议|薪资按.*面议/;
const JOB_RECOMMEND_OR_BOOKING_PATTERN =
  /(?:推荐|这家|这个岗位|门店)[^。！？\n]{0,24}(?:适合|可以|能做|在招|报名|预约|面试)|(?:可以|能|帮你|给你)[^。！？\n]{0,16}(?:约|预约|报名|安排面试)/;
// 合规口径除了“没有符合班次的岗/问放宽”外，还包括“透明披露班次不符 + 征询能否接受”：
// 生产偏严案例（2026-07-06 守卫档案 id=8）“只有白班……不是夜班……你看这个白班能做吗”
// 本质就是规则要求的放宽询问，只是带了具体岗位，不应拦。
// 注意：“只有/只剩/都是 + 班次”那一支已拆出去单独按极性判定（见
// SCHEDULE_ONLY_SHIFT_DECLARATION_PATTERN），不能留在无条件豁免里——它对班次
// 真值是盲的，“这几家都是夜班，我帮你报名？”曾靠它逃逸（2026-07-06 review）。
const SCHEDULE_NO_MATCH_COMPLIANT_PATTERN =
  /(?:暂时|目前)?(?:没有|没找到|暂无)[^。！？\n]{0,24}(?:符合|匹配)[^。！？\n]{0,24}(?:班次|时段|时间)|(?:放宽|调整)[^。！？\n]{0,12}(?:班次|时段|时间)|(?:不是|不算|并非)[^。！？\n]{0,8}(?:夜班|晚班|早班|白班)|(?:白班|早班|晚班|夜班|全天班?)[^。！？\n]{0,12}(?:能做吗|能接受吗|可以吗|行吗|接受吗|考虑吗|做得来吗)/;
// 岗位班次陈述句：“只有白班 / 都是夜班”。捕获陈述的班次词，与候选人所求班次对账：
// 极性不同是诚实披露（“你要夜班，这边只有白班”），极性相同则是把被班次过滤剔除的
// 岗位包装成候选人要的班次，恰是本规则要拦的编造。
const SCHEDULE_ONLY_SHIFT_DECLARATION_PATTERN =
  /(?:只有|只剩|都是)[^。！？\n]{0,10}(白班|早班|日班|晚班|夜班|全天)/;
// 需求复述（候选人口吻动词）：“只找白班”是转述候选人偏好，不是岗位班次陈述
// （与 job-fact-value-mismatch 的 SHIFT_REQUIREMENT_ECHO 同口径）。
const SCHEDULE_SHIFT_REQUIREMENT_ECHO_PATTERN =
  /(?:只找|只做|只考虑|只要|想找|想做|想要|倾向|偏好|接受)[^。！？\n]{0,6}(?:早班|白班|日班|晚班|夜班|通宵|全天)/;

// 暑假工是单向硬约束：删掉合法的“暑假工/暑期工”称呼后，剩余的兼职、小时工、
// 全职才是非暑假工替代项，避免把“暑假兼职”里的“兼职”误判成普通兼职。
const SUMMER_WORKER_ALIAS_PATTERN = /暑假工|暑期工|暑期工作|暑假兼职|暑期兼职/g;
const NON_SUMMER_LABOR_FORM_FRAGMENT = '(?:普通兼职|常规兼职|长期兼职|小时工|全职|兼职)';
const NON_SUMMER_FORWARD_OFFER_PATTERN = new RegExp(
  `${NON_SUMMER_LABOR_FORM_FRAGMENT}[^。！？\\n]{0,18}` +
    `(?:(?<!不)(?<!没)(?:可以|能)(?:做|考虑|接受|报名|约面|面试)|也行|` +
    `要不要|愿不愿意|(?<!不)适合你|(?<!不)(?<!不能)推荐给你|` +
    `帮你(?:报名|预约|约面|查|找|看)|安排面试|也有|还有|也可以(?:吗|么|[？?]|$)|可以吗|行吗|怎么样)`,
);
const NON_SUMMER_REVERSE_OFFER_PATTERN = new RegExp(
  `(?<!不)(?<!没)(?<!不能)(?:建议|推荐|考虑|接受|改做|转做|当作|按|看看|看下|找找|` +
    `报名|预约|约面|先做|做)[^。！？\\n]{0,18}${NON_SUMMER_LABOR_FORM_FRAGMENT}`,
);
const NON_SUMMER_NATURAL_SUGGESTION_PATTERN = new RegExp(
  `(?:要不|不如)[^。！？\\n]{0,6}(?:看看|看下|考虑|先做|做)[^。！？\\n]{0,12}` +
    `${NON_SUMMER_LABOR_FORM_FRAGMENT}|` +
    `(?:我)?(?:帮|给)你[^。！？\\n]{0,8}(?:查|找|看|推|发)[^。！？\\n]{0,10}` +
    `${NON_SUMMER_LABOR_FORM_FRAGMENT}|` +
    `(?:我)?(?:发|推|找|查|看)[^。！？\\n]{0,10}${NON_SUMMER_LABOR_FORM_FRAGMENT}` +
    `(?:岗位)?给你|` +
    `${NON_SUMMER_LABOR_FORM_FRAGMENT}[^。！？\\n]{0,18}` +
    `(?:(?:我)?(?:可以)?帮你(?:看|查|找|推)|(?:是否)?需要(?:我)?(?:给|帮)你(?:查|找|看))`,
);
const NON_SUMMER_CURRENT_JOB_CLAIM_PATTERN = new RegExp(
  `(?:这家|这个岗位|该岗位|当前岗位)[^。！？\\n]{0,12}` +
    `(?<!不)(?:是|属于|用工形式(?:是|为)?)[^。！？\\n]{0,6}${NON_SUMMER_LABOR_FORM_FRAGMENT}`,
);
const OTHER_LABOR_FORM_OFFER_PATTERN =
  /(?:愿意|是否|要不要|能不能|可以)[^。！？\n]{0,8}(?:考虑|接受)[^。！？\n]{0,6}(?:其他|别的)用工形式|(?:其他|别的)用工形式[^。！？\n]{0,8}(?:考虑|接受|可以吗|行吗)/;
const NON_SUMMER_NEGATIVE_ACTION_BEFORE_TERM_PATTERN = new RegExp(
  `(?:不会|不能|不要|别|不建议|不推荐|不考虑|不接受|不帮|没法|无法)` +
    `[^，,。！？\\n]{0,24}${NON_SUMMER_LABOR_FORM_FRAGMENT}`,
  'g',
);
const NON_SUMMER_NEGATIVE_ACTION_AFTER_TERM_PATTERN = new RegExp(
  `${NON_SUMMER_LABOR_FORM_FRAGMENT}[^，,。！？\\n]{0,20}` +
    `(?:不能|不会|不要|不建议|不推荐|不考虑|不接受|不适合|不符合|不匹配|没法|无法)` +
    `[^，,。！？\\n]{0,12}`,
  'g',
);
const NON_SUMMER_CROSS_CLAUSE_REJECTION_PATTERN = new RegExp(
  `${NON_SUMMER_LABOR_FORM_FRAGMENT}[，,]\\s*` + `(?:不符合|不匹配|不适合)[^，,。！？\\n]{0,18}`,
  'g',
);
const NON_SUMMER_NOT_SUMMER_REJECTION_PATTERN = new RegExp(
  `${NON_SUMMER_LABOR_FORM_FRAGMENT}[^。！？\\n]{0,20}` +
    `(?:不是|并非)(?:暑假工|暑期工|暑期工作|暑假兼职|暑期兼职)` +
    `[^。！？\\n]{0,16}(?:不推荐|不考虑|不适合|不匹配|不能|先不推|暂不推荐)`,
  'g',
);

export const JOB_FACT_HALLUCINATION_RULES: FactRule[] = [];

/**
 * 未接地岗位推荐检测。
 *
 * 判断逻辑故意偏保守：
 * - 如果本轮有可用 duliday_job_list 结果，认为岗位事实已接地，交给更细规则继续检查；
 * - 如果泄漏“推荐对话用模板”，直接 block，因为它同时说明未接地和内部模板外泄；
 * - 否则要求回复里至少出现两个结构化岗位字段，并且有推荐语境，避免把普通聊天误拦。
 */
export function detectUngroundedJobRecommendation(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (hasUsableJobListResult(toolCalls)) return null;

  if (JOB_TEMPLATE_LEAK_PATTERN.test(text)) {
    return {
      ruleId: 'ungrounded_job_recommendation',
      label: '回复泄漏”推荐对话用模板”并输出岗位推荐，但本轮没有可用的 duliday_job_list 结果接地',
      action: GUARDRAIL_ACTION.REPLAN,
    };
  }

  const factLabels = new Set<string>();
  for (const match of text.matchAll(JOB_FACT_LABEL_PATTERN)) {
    const label = match[0].replace(/[：:\s]/g, '');
    factLabels.add(label);
  }

  if (factLabels.size < 2) return null;
  if (!JOB_RECOMMENDATION_CONTEXT_PATTERN.test(text)) return null;

  return {
    ruleId: 'ungrounded_job_recommendation',
    label:
      '回复输出具体岗位事实（距离/班次/薪资/要求等），但本轮没有可用的 duliday_job_list 结果接地',
    action: GUARDRAIL_ACTION.REPLAN,
  };
}

/**
 * 薪资编造检测。
 *
 * 只在本轮实际调过 duliday_job_list 时检查，这是为了避免历史承接场景误伤；
 * 如果最后一次工具结果里的 jobSalary 能解析出 holidaySalary/overtimeSalary，就允许提节假日/加班薪资；
 * 否则把“节假日双倍、周末加薪、薪资面议、工资浮动”等当成无依据补充。
 */
export function detectSalaryFabrication(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!SALARY_FABRICATION_PATTERN.test(text)) return null;

  const jobListCall = readLatestUsableJobListCall(toolCalls);
  if (!jobListCall) return null;

  const hasHolidayOrOvertimeSalary = hasNonEmptyHolidayOrOvertimeSalary(jobListCall.result);
  if (hasHolidayOrOvertimeSalary) return null;

  return {
    ruleId: 'salary_fabrication',
    label:
      '回复声称节假日/周末薪资差异或工资浮动/面议，但本轮 duliday_job_list 返回的 jobSalary 里没有对应的 holidaySalary/overtimeSalary 字段（badcase aalxnd77 / zt98hgy3）',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectScheduleFilteredJobRecommended(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!JOB_RECOMMEND_OR_BOOKING_PATTERN.test(text)) return null;

  // 先对账工具事实（errorType），再谈豁免：豁免必须知道"候选人要的是什么班次"才能
  // 区分诚实披露和真值盲逃逸——原先豁免短路在事实检查之前，"这几家都是夜班，很适合
  // 你，我帮你报名？"在 schedule_filter_empty 后靠"都是夜班"字样整段放行
  // （2026-07-06 review）。
  const latestJobListCall = readLatestJobListCall(toolCalls);
  if (readErrorType(latestJobListCall?.result) !== 'job_list.schedule_filter_empty') return null;

  // 无条件合规口径：没有符合班次的岗 / 问放宽 / "不是夜班"披露 / "白班能做吗"征询。
  if (SCHEDULE_NO_MATCH_COMPLIANT_PATTERN.test(text)) return null;

  // "只有/只剩/都是 + 班次"陈述按极性判定，不再是无条件豁免。
  const declaredShift = SCHEDULE_ONLY_SHIFT_DECLARATION_PATTERN.exec(text)?.[1] ?? null;
  if (declaredShift) {
    // "只找白班"式需求复述不是岗位班次陈述，保持豁免。
    if (SCHEDULE_SHIFT_REQUIREMENT_ECHO_PATTERN.test(text)) return null;

    const declaredPolarity = readShiftPolarity(declaredShift);
    const requestedPolarity = readRequestedShiftPolarity(latestJobListCall?.args);
    // 陈述班次与候选人所求班次极性不同 = 诚实披露（"你要夜班，这边只有白班"），放行；
    // 极性相同（或全天等读不出极性）= 把被过滤剔除的岗位说成候选人要的班次，不豁免。
    // args 里读不出所求班次时同样不豁免：本函数入口已确认回复带推荐/催报名动作。
    if (
      requestedPolarity !== null &&
      declaredPolarity !== null &&
      declaredPolarity !== requestedPolarity
    ) {
      return null;
    }
  }

  return {
    ruleId: 'schedule_filtered_job_recommended',
    label:
      'duliday_job_list 返回 job_list.schedule_filter_empty（班次硬约束过滤后无匹配岗位），但回复仍推荐岗位或承诺可约',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

/**
 * 暑假工候选人不得被主动降级到普通兼职/小时工/全职。
 *
 * 外生信号有两类：
 * - 本轮 job_list 的 queryMeta 明确记录 candidateLaborForm=暑假工；
 * - 当前候选人消息明确说暑假工/暑期工（覆盖模型绕过 job_list 直接给替代建议）。
 *
 * 这里只拦“推荐/建议/继续推进”语义；如实说明“这些是普通兼职，不是暑假工，所以不推荐”
 * 不会命中。候选人后续主动改口时，当前消息不再是暑假工意向，新的 job_list metadata 也会
 * 按新 laborForm 生成，因此不妨碍重新查岗。
 */
export function detectSummerWorkerNonSummerRecommendation(
  text: string,
  toolCalls: AgentToolCall[],
  userMessage?: string,
  recentUserTexts?: string[],
): RuleContradiction | null {
  const latestExplicitIntent = readLatestExplicitSummerWorkerIntent([
    ...(recentUserTexts ?? []),
    ...(userMessage ? [userMessage] : []),
  ]);
  const hasSummerWorkerConstraint =
    latestExplicitIntent === 'summer_worker' ||
    (latestExplicitIntent === null &&
      toolCalls.some((call) => hasSummerWorkerLaborFormFilter(call)));
  if (!hasSummerWorkerConstraint) return null;

  // 先只遮蔽局部拒绝片段，再检查剩余内容。不能按整句豁免，否则
  // “普通兼职不能推荐，但要不看看小时工？”会把后半句真实降级建议一并洗掉。
  const withoutSummerWorkerAliases = maskNonSummerRejectionSpans(text).replace(
    SUMMER_WORKER_ALIAS_PATTERN,
    '',
  );
  const currentJobClaimsNonSummer = NON_SUMMER_CURRENT_JOB_CLAIM_PATTERN.test(
    withoutSummerWorkerAliases,
  );
  const offersNonSummerJob =
    NON_SUMMER_FORWARD_OFFER_PATTERN.test(withoutSummerWorkerAliases) ||
    NON_SUMMER_REVERSE_OFFER_PATTERN.test(withoutSummerWorkerAliases) ||
    NON_SUMMER_NATURAL_SUGGESTION_PATTERN.test(withoutSummerWorkerAliases) ||
    currentJobClaimsNonSummer ||
    OTHER_LABOR_FORM_OFFER_PATTERN.test(withoutSummerWorkerAliases);
  if (!offersNonSummerJob) return null;

  return {
    ruleId: 'summer_worker_non_summer_recommendation',
    label: '候选人已明确只要暑假工，但回复仍主动推荐/建议普通兼职、小时工、全职或其他用工形式',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

function hasSummerWorkerLaborFormFilter(call: AgentToolCall): boolean {
  if (call.toolName !== 'duliday_job_list' || !call.result || typeof call.result !== 'object') {
    return false;
  }
  const result = call.result as Record<string, unknown>;
  const directQueryMeta = asPlainRecord(result.queryMeta);
  const details = asPlainRecord(result.details);
  const nestedQueryMeta = asPlainRecord(details?.queryMeta);
  const queryMeta = directQueryMeta ?? nestedQueryMeta;
  const laborFormFilter = asPlainRecord(queryMeta?.laborFormFilter);
  return laborFormFilter?.candidateLaborForm === '暑假工' && laborFormFilter.applied !== false;
}

function readLatestExplicitSummerWorkerIntent(
  userTexts: string[],
): 'summer_worker' | 'other_labor_form' | null {
  for (let index = userTexts.length - 1; index >= 0; index -= 1) {
    const intent = readExplicitSummerWorkerIntent(userTexts[index]);
    if (intent) return intent;
  }
  return null;
}

function readExplicitSummerWorkerIntent(
  userMessage: string | undefined,
): 'summer_worker' | 'other_labor_form' | null {
  const intent = decideLaborFormIntent(userMessage);
  if (intent.kind === 'set') {
    return intent.value === '暑假工' ? 'summer_worker' : 'other_labor_form';
  }
  if (intent.kind === 'clear' && intent.clearedValues.includes('暑假工')) {
    return 'other_labor_form';
  }
  return null;
}

function maskNonSummerRejectionSpans(text: string): string {
  return [
    NON_SUMMER_NOT_SUMMER_REJECTION_PATTERN,
    NON_SUMMER_NEGATIVE_ACTION_BEFORE_TERM_PATTERN,
    NON_SUMMER_NEGATIVE_ACTION_AFTER_TERM_PATTERN,
    NON_SUMMER_CROSS_CLAUSE_REJECTION_PATTERN,
  ].reduce((masked, pattern) => {
    pattern.lastIndex = 0;
    return masked.replace(pattern, ' ');
  }, text);
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ShiftPolarity = 'day' | 'night';

/** 班次词 → 早晚极性。"全天"两头都占，读不出单一极性，返回 null。 */
function readShiftPolarity(shiftWord: string): ShiftPolarity | null {
  if (/白班|早班|日班/.test(shiftWord)) return 'day';
  if (/晚班|夜班|通宵/.test(shiftWord)) return 'night';
  return null;
}

/**
 * 从产生 schedule_filter_empty 的 job_list 调用 args 里读候选人所求班次极性。
 * candidateScheduleConstraint.onlyEvenings/onlyMornings 是工具入参 schema 里的班次
 * 硬约束字段；onlyWeekends/maxDaysPerWeek 不含早晚极性，读不出时返回 null。
 */
function readRequestedShiftPolarity(args: unknown): ShiftPolarity | null {
  if (!args || typeof args !== 'object') return null;
  const constraint = (args as Record<string, unknown>).candidateScheduleConstraint;
  if (!constraint || typeof constraint !== 'object') return null;
  const record = constraint as Record<string, unknown>;
  if (record.onlyEvenings === true) return 'night';
  if (record.onlyMornings === true) return 'day';
  return null;
}

// "可用" job_list 判定与最后一次可用/裸调用读取已收敛到 job-list-call.util（多规则共用）。

/**
 * 从岗位工具返回的多层结构里读取薪资事实。
 * job-list 结果可能包在 result 或 rawData.result 下，这里保持兼容，避免因为封装差异误判。
 */
function hasNonEmptyHolidayOrOvertimeSalary(jobListResult: unknown): boolean {
  if (typeof jobListResult !== 'object' || jobListResult === null) return false;
  const rawData = (jobListResult as Record<string, unknown>).rawData as
    | Record<string, unknown>
    | undefined;
  const jobs = (rawData?.result ?? (jobListResult as Record<string, unknown>).result) as
    | unknown[]
    | undefined;
  if (!Array.isArray(jobs)) return false;

  for (const job of jobs) {
    const jobSalary = (job as Record<string, unknown> | undefined)?.jobSalary;
    const facts = extractSalaryFacts(jobSalary);
    if (facts.hasHolidayBonus || facts.hasOvertimeBonus) return true;
  }
  return false;
}

function readErrorType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const errorType = (value as Record<string, unknown>).errorType;
  return typeof errorType === 'string' ? errorType : null;
}
