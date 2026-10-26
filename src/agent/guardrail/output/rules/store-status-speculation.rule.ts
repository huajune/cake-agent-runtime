// business-rules: IB-05
import { createOutputRuleFinding } from '../output-rule-catalog';
import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { asRecord } from '@infra/utils/object.util';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { classifyBookingFailure } from '@tools/shared/tool-failure-handoff.util';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 门店运营状态断言（封闭词形）：招满/名额已满/满员/招够/关店/搬迁/装修/下架/门店调整。
 * 「名额」只认后接"满/没了"的完成形态，"名额不会满/名额还有"等承诺或否定不在本词表（归 quota_promise）。
 */
const UNSUPPORTED_STORE_STATUS_PATTERN =
  /(?:可能|应该|估计|大概|也许|或许|看起来)?(?:已经|都|暂时)?(?:(?:招满|招完|招够|满员|不招了|停止招聘|关店|关了|搬了|装修|撤店|下架)|名额(?:已经|都|早就|基本)?(?:满|没了)|(?:门店|岗位)(?:那边|这边)?(?:有|做了|出现)?(?:调整|变动|变化))/gu;

/**
 * 同句内紧贴命中的否定/安抚前缀（「没有招满」「不是名额满了」「还没招够」「别担心关店」）：
 * 否认或安抚不是状态断言。前缀与命中之间只容「还/也/都/完全」等副词，不跨标点；
 * 「是不是招满了」「不会是门店调整了吧」是猜测性设问，不算否定。
 */
const NEGATED_OR_REASSURING_PREFIX_PATTERN =
  /(?:没有|没|并非|(?<!是)不是|不会|未|别担心|不用担心|不必担心)(?:还|也|都|并|完全|真的)?$/u;

/** 正反问（「名额满不满」「招满没招满」）是在问状态，不是断言。 */
const A_NOT_A_SUFFIX_PATTERN = /^了?(?:不|没)(?:招)?满/u;

/**
 * 无岗事实的两个居所：真实无岗走 noMatchScript（nextAction=wait_for_inventory），
 * 品牌不在合作目录走 brandNotPartneredScript（nextAction=brand_not_partnered）。
 * 后者我们连该品牌的岗位数据都没有，更没有资格断言它的门店经营状态。
 */
const NO_INVENTORY_SCRIPT_ACTIONS = new Set(['wait_for_inventory', 'brand_not_partnered']);

/**
 * precheck 查不到岗位详情的两种回执：岗位查不到（job_not_found）只能证明海绵本次没返回该岗，
 * 已有预约的岗位查不到（booked_job_unverifiable）连预约都仍然有效——都不是招满/关店的证据。
 */
const PRECHECK_JOB_UNAVAILABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_FOUND,
  TOOL_ERROR_TYPES.PRECHECK_BOOKED_JOB_UNVERIFIABLE,
]);

function hasStoreStatusAssertion(replyText: string): boolean {
  for (const match of replyText.matchAll(UNSUPPORTED_STORE_STATUS_PATTERN)) {
    const start = match.index ?? 0;
    const prefix = replyText.slice(Math.max(0, start - 8), start);
    if (NEGATED_OR_REASSURING_PREFIX_PATTERN.test(prefix)) continue;
    if (A_NOT_A_SUFFIX_PATTERN.test(replyText.slice(start + match[0].length))) continue;
    return true;
  }
  return false;
}

function hasNoMatchScript(call: AgentToolCall): boolean {
  if (call.toolName !== 'duliday_job_list' || call.status === 'error') return false;
  if (!call.result || typeof call.result !== 'object') return false;
  const result = call.result as Record<string, unknown>;
  const script = result.noMatchScript ?? result.brandNotPartneredScript;
  if (!script || typeof script !== 'object') return false;
  const errorType = result.errorType;
  return (
    typeof errorType === 'string' &&
    errorType.startsWith('job_list.') &&
    NO_INVENTORY_SCRIPT_ACTIONS.has(String((script as Record<string, unknown>).nextAction))
  );
}

function hasPrecheckJobUnavailable(call: AgentToolCall): boolean {
  if (call.toolName !== 'duliday_interview_precheck') return false;
  const errorType = asRecord(call.result)?.errorType;
  return typeof errorType === 'string' && PRECHECK_JOB_UNAVAILABLE_ERROR_TYPES.has(errorType);
}

/** 本轮报名接口真实拒绝为名额已满/达上限：此时"名额满了"是工具事实，不是猜测。 */
function hasBookingCapacityFull(call: AgentToolCall): boolean {
  if (call.toolName !== 'duliday_interview_booking') return false;
  const result = asRecord(call.result);
  if (!result || typeof result.errorType !== 'string') return false;
  return classifyBookingFailure(result) === 'booking_capacity_full';
}

/**
 * noMatchScript 只能证明当前查询没有匹配岗位，precheck 查不到岗位详情也只说明这次没取到岗位；
 * 两者都不能证明门店已经招满、关店、搬迁或调整。规则仅在本轮有这两类明确工具事实时生效；
 * 本轮报名接口真实回了名额已满/上限时豁免。
 */
export function detectUnsupportedStoreStatusSpeculation(
  replyText: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!hasStoreStatusAssertion(replyText)) return null;
  if (!toolCalls.some((call) => hasNoMatchScript(call) || hasPrecheckJobUnavailable(call))) {
    return null;
  }
  if (toolCalls.some(hasBookingCapacityFull)) return null;

  return createOutputRuleFinding(
    'unsupported_store_status_speculation',
    '岗位工具只返回了无匹配（noMatchScript）或岗位详情查不到，无法证明门店已招满、名额已满、关店、搬迁或装修；' +
      '只能说明当前暂时没查到匹配的在招岗位，已有预约的岗位仍按预约有效处理',
  );
}
