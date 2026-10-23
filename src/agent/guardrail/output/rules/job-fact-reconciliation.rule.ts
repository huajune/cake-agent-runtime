// business-rules: GP-01, GP-04
import { createOutputRuleFinding } from '../output-rule-catalog';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { asRecord } from '@infra/utils/object.util';
import { extractPresentedJobs } from '@resolution/job';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { RuleContradiction } from '../output-rule.types';
import { extractQuantifiedJobFacts, isSalaryFact } from './job-fact-signals.util';
import { buildJobFactProvenanceIndex, isJobFactSupported } from './job-fact-provenance.util';

/**
 * 岗位事实 ↔ 查询动作对账（零工具轮的两种假事实）。
 *
 * 背景（badcase 5j1mbgi8 / kwxk74gn / kb629uko）：模型在本轮没有调用任何查岗工具的情况下，
 * 要么宣称"帮你查了下 / 系统里没查到"，要么直接报出会话里从未出现过的门店薪资/距离。
 * 单轮 requiredTool 判据会误伤合法的跨轮复述，所以两条规则各自只取一个高置信形态：
 *
 * 两条都是 REPLAN 档：问题不在文案而在"该发生的查询没发生"，文本重写修不出来，
 * runner 用相同参数重进一次 generator（见 output-rule.types GuardrailRuleAction）。
 *
 * - `job_query_claim_without_query`（REPLAN）：回复用**完成时态**宣称本轮查过（"帮你查了下""没查到"
 *   "系统里暂时没有"），而本轮零查岗/预检/定位工具。"刚才/之前/上次查的"这类回指历史的说法不算。
 * - `job_fact_without_provenance`（REPLAN）：回复出现量化岗位事实（元/时·天·月、月薪/时薪 N、km、
 *   HH:MM-HH:MM），本轮没有可作证据的查岗结果，且该数字在会话内 Agent 自己的历史回复、候选人
 *   消息与会话记忆的岗位摘要（已展示岗位 / 上轮候选池 / 焦点岗位，即上一轮工具结果沉淀后渲染进
 *   [会话记忆] 的班次、薪资、距离）里都没出现过。"出现过"按事实种类比对而不是逐字比对
 *   （见 job-fact-provenance.util）。回指历史（"刚才那家/上面那个"）的句子、"N 公里内"这类
 *   距离偏好、复述候选人自己可上班时间的句子豁免。
 *   - 证据工具只认**成功**的 duliday_job_list / duliday_interview_precheck。取消、改约、报名、
 *     定位（以及失败的查岗/预检）不提供岗位薪资事实：调过它们时仍对**薪资**对账，时段与距离
 *     可能来自这些回执，照旧放行（生产 trace …_1790233240971：只调了两次取消，回复照抄真人
 *     招聘经理消息里的"月薪3000-4000"介绍兼职岗）。
 *   - 证据按岗位绑定：能从回复认出介绍的岗位、且本轮证据能确定覆盖哪些岗位时，证据只覆盖同 jobId；
 *     认不出岗位或证据覆盖面不确定时，有证据即放行（与旧口径一致，不扩大误拦面）。
 *   - 真人招聘经理（MOBILE_PUSH 等手动消息）里出现过的数字不能为 Agent 报出的**薪资**作证
 *     （2026-10-14 用户裁定）；距离、时段仍可引用。会话记忆岗位摘要的 salaryDesc 仍是合法出处。
 */
// 「看了下」泛用（看健康证/看定位），只有后面跟岗位类宾语才算查岗宣称；「查/搜了下」本身就是查岗动作。
const QUERY_DONE_CLAIM_PATTERN =
  /(?:帮你|给你|替你|我)(?:重新|再|又)?(?:查|搜)(?:了(?:一)?下|了下|到了|过了)|(?:帮你|给你|替你|我)(?:重新|再|又)?看(?:了(?:一)?下|了下)(?!你)[^。！？!?\n]{0,14}(?:岗位|门店|工作|兼职|职位|附近|系统)|(?:系统|平台|后台)(?:里|上)?(?:目前|暂时|现在)?(?:没(?:有)?|无)(?:查到|找到|看到|搜到)|(?:目前|暂时|现在)?(?:没(?:有)?|未)(?:查到|搜到)[^，。！？!?\n]{0,12}(?:岗位|门店|工作|兼职|职位)/u;

const HISTORY_REFERENCE_PATTERN = /刚才|刚刚|之前|上次|上回|前面|上面|早上|昨天|先前|开始/u;

/**
 * job_query_claim 的"查过系统"工具集（查岗/预检/定位/工单三件套）：本轮调过任一个，
 * "帮你查了下（工单）"就是真查询。只用于查询宣称，不用于岗位事实出处。
 */
const JOB_QUERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_job_list',
  'duliday_interview_precheck',
  'geocode',
  'duliday_interview_booking',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
]);

/** job_fact 的证据工具：只有查岗与预检会返回岗位薪资/班次/距离事实。 */
const JOB_FACT_EVIDENCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_job_list',
  'duliday_interview_precheck',
]);

/** "1 公里内还是 2 公里内？"是在问候选人的距离偏好，不是岗位事实。 */
const DISTANCE_PREFERENCE_SUFFIX = /^\s*以?内/u;
/** 复述候选人自己的可上班时间（"你说的 8:30-16:30""你可用时间是…"），不是岗位班次。 */
const CANDIDATE_TIME_REFERENCE_PATTERN =
  /你(?:说的|提到的|的(?:可用|空闲|方便)?时间|可用时间|空闲时间|方便的时间|有空的时间|能上班的时间|可以上班的时间)/u;

function hasJobQueryTool(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => JOB_QUERY_TOOL_NAMES.has(call.toolName));
}

/** 成功的查岗/预检调用：工具失败、无匹配等带 errorType 的回执不提供岗位事实。 */
function isJobFactEvidenceCall(call: AgentToolCall): boolean {
  if (!JOB_FACT_EVIDENCE_TOOL_NAMES.has(call.toolName) || call.status === 'error') return false;
  const result = asRecord(call.result);
  return result !== null && typeof result.errorType !== 'string' && result.success !== false;
}

function readJobIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => (typeof item === 'string' && /^\d+$/u.test(item) ? Number(item) : item))
    .filter((item): item is number => typeof item === 'number' && Number.isInteger(item));
}

/**
 * 本轮证据能确定覆盖的岗位集合；任一证据调用覆盖面不确定（按位置/品牌查岗且没有本轮召回账本）时
 * 返回 null，由调用方按"有证据即放行"处理。
 */
function resolveEvidenceJobIds(
  evidenceCalls: readonly AgentToolCall[],
  turnJobs: readonly RecommendedJobSummary[] | undefined,
): Set<number> | null {
  const covered = new Set<number>((turnJobs ?? []).map((job) => job.jobId));
  for (const call of evidenceCalls) {
    const args = asRecord(call.args);
    if (call.toolName === 'duliday_interview_precheck') {
      const ids = readJobIds(args?.jobId);
      if (ids.length === 0) return null;
      ids.forEach((id) => covered.add(id));
      continue;
    }
    const ids = readJobIds(args?.jobIdList);
    if (ids.length > 0) ids.forEach((id) => covered.add(id));
    else if (turnJobs === undefined) return null;
  }
  return covered;
}

/**
 * 有成功证据时，是否仍需对账：只有能认出回复在介绍哪些岗位、且这些岗位都不在本轮证据覆盖面内时
 * 才对账（证据是别的岗位的）。认不出或覆盖面不确定一律放行。
 */
function evidenceMissesPresentedJobs(
  text: string,
  evidenceCalls: readonly AgentToolCall[],
  context: JobFactProvenanceContext,
): boolean {
  const covered = resolveEvidenceJobIds(evidenceCalls, context.turnJobs);
  if (!covered) return false;
  const pool = dedupeJobs([...(context.turnJobs ?? []), ...(context.sessionJobs ?? [])]);
  const presented = extractPresentedJobs(text, pool);
  return presented.length > 0 && presented.every((job) => !covered.has(job.jobId));
}

function dedupeJobs(jobs: readonly RecommendedJobSummary[]): RecommendedJobSummary[] {
  const seen = new Set<number>();
  return jobs.filter((job) => {
    if (seen.has(job.jobId)) return false;
    seen.add(job.jobId);
    return true;
  });
}

function sentenceOf(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf('。', index),
    text.lastIndexOf('\n', index),
    text.lastIndexOf('！', index),
    text.lastIndexOf('？', index),
  );
  return text.slice(start + 1, index + 1);
}

export function detectJobQueryClaimWithoutQuery(
  text: string,
  toolCalls: AgentToolCall[] = [],
): RuleContradiction | null {
  if (!text.trim() || hasJobQueryTool(toolCalls)) return null;
  const pattern = new RegExp(QUERY_DONE_CLAIM_PATTERN.source, 'gu');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    if (HISTORY_REFERENCE_PATTERN.test(before)) continue;
    return createOutputRuleFinding(
      'job_query_claim_without_query',
      '回复用完成时态宣称本轮查过岗位（"帮你查了下/没查到/系统里没有"），但本轮没有任何 ' +
        'duliday_job_list / duliday_interview_precheck / geocode 调用——查询从未发生',
    );
  }
  return null;
}

/**
 * 把会话记忆里的岗位摘要压成出处文本：只取会被量化事实正则命中的字段（薪资/结算/班次/距离/年龄）。
 * 这些摘要来自上一轮真实工具结果，模型在 [会话记忆] 里看得到，按它们作答不是编造。
 */
export function formatJobFactProvenanceTexts(
  jobs: readonly (RecommendedJobSummary | null | undefined)[],
): string[] {
  const texts: string[] = [];
  for (const job of jobs) {
    if (!job) continue;
    const parts = [
      job.salaryDesc,
      job.settlementSummary,
      job.shiftSummary,
      job.ageRequirement,
      job.distanceKm != null ? `${job.distanceKm.toFixed(1)}km` : null,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    if (parts.length > 0) texts.push(parts.join(' | '));
  }
  return texts;
}

export interface JobFactProvenanceContext {
  /**
   * 真人招聘经理手动发出的消息（`isHumanAgentTextMessage`）。只为距离/时段作证，
   * 不为 Agent 报出的薪资作证（2026-10-14 用户裁定）。
   */
  humanRecruiterTexts?: readonly string[];
  /** 本轮查岗/预检确认过的岗位（TurnLedger fetchedJobs + attestedFocusJob）；undefined=未知。 */
  turnJobs?: readonly RecommendedJobSummary[];
  /** 会话记忆岗位（已展示/候选池/焦点），用于认出回复在介绍哪些岗位。 */
  sessionJobs?: readonly RecommendedJobSummary[];
}

/**
 * @param priorTexts 会话内 Agent 自己的历史回复 + 候选人消息（含本轮）+ 会话记忆岗位摘要
 *   （见 formatJobFactProvenanceTexts）。候选人自己刚说的数字（"那个 25 元/时的还在招吗"）
 *   被复述回去不是编造；上一轮工具结果沉淀进记忆的班次/薪资被挑出来回答追问同样不是。
 *   调用方拿不到会话历史时不要调本函数（无法判出处 ≠ 无出处）。
 *   月收入估算等需要多步推导的数字不推导，仍按无出处处理。
 * @param context 真人招聘经理消息（仅为非薪资事实作证）与岗位绑定所需的本轮/记忆岗位。
 */
export function detectJobFactWithoutProvenance(
  text: string,
  toolCalls: AgentToolCall[] = [],
  priorTexts: readonly string[] = [],
  context: JobFactProvenanceContext = {},
): RuleContradiction | null {
  if (!text.trim()) return null;
  const evidenceCalls = toolCalls.filter(isJobFactEvidenceCall);
  if (evidenceCalls.length > 0 && !evidenceMissesPresentedJobs(text, evidenceCalls, context)) {
    return null;
  }
  // 本轮调过取消/改约/报名/定位（或查岗/预检失败）时，其回执仍可能给出面试时段、距离，
  // 只对薪资对账；完全零工具时三类事实都对账。
  const salaryOnly = evidenceCalls.length === 0 && hasJobQueryTool(toolCalls);
  const history = buildJobFactProvenanceIndex(priorTexts);
  const humanHistory = buildJobFactProvenanceIndex(context.humanRecruiterTexts ?? []);
  const orphanFacts: string[] = [];
  for (const fact of extractQuantifiedJobFacts(text)) {
    const salary = isSalaryFact(fact.normalized);
    if (salaryOnly && !salary) continue;
    const sentence = sentenceOf(text, fact.index);
    if (HISTORY_REFERENCE_PATTERN.test(sentence)) continue;
    const following = text.slice(fact.index + fact.raw.length);
    if (/km|公里/i.test(fact.raw) && DISTANCE_PREFERENCE_SUFFIX.test(following)) continue;
    if (/[:：]\d{2}$/.test(fact.raw) && CANDIDATE_TIME_REFERENCE_PATTERN.test(sentence)) continue;
    if (isJobFactSupported(fact.raw, history)) continue;
    // 真人经理消息只为距离/时段作证；薪资必须来自工具、记忆岗位摘要或 Agent 自己说过的话。
    if (!salary && isJobFactSupported(fact.raw, humanHistory)) continue;
    orphanFacts.push(fact.raw);
  }
  if (orphanFacts.length === 0) return null;
  return createOutputRuleFinding(
    'job_fact_without_provenance',
    `回复给出岗位量化事实「${orphanFacts.slice(0, 3).join('、')}」，但本轮没有该岗位的查岗结果，` +
      '会话内 Agent 历史回复与会话记忆也从未出现过这些数字（真人招聘经理消息里的薪资不算出处）——没有任何来源的岗位事实',
  );
}
