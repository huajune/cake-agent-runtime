import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

/**
 * 承诺-动作对账（core-flow-review 议题 7-1 / 9-4）。
 *
 * 沿革：`handoff_promise_without_handoff` 于 2026-08-11 第三批下线（commit ca0ce158，
 * 删 383 行）。下线的理由不是"这个问题不存在"，而是**拦截形态本身就是错的**：模型承诺
 * "让同事帮你确认"而本轮没有 handoff 动作时，正确处置不是改写/拦掉文案（消灭承诺），
 * 而是补执行 handoff 动作（让承诺成真）。dangling-promise 规则注释已独立论证过同一结论
 * （repair 改不出候选人要的结果、block 让候选人什么都收不到）。
 *
 * 本模块只做**检测**，不改文本、不进投递路径：
 * - `handoff_promise_reconciliation` → 命中时由 turn-outcome 挂人工介入 sideEffect
 *   （暂停托管 + 飞书通知 + handoff-events 落库，reasonCode=promise_reconciliation），
 *   文本原样放行，承诺由真人接续兑现。**直接 enforce，不设 shadow 期**（用户 8-14 裁定）：
 *   补动作形态下假阳代价 = 一次不必要的暂停 + 真人被 ping，候选人无感知、无错误投递物，
 *   风险本质不同于原 block 形态，无需观测期背书。
 * - `booking_promise_without_booking` → 纯观测。报名动作**无法**自动补
 *   （precheck 未通过时不能替报），出口不是补动作；9-2 断路器落地后此形态应趋零，
 *   指标用于验证 9-2 有效性。
 *
 * 词形刻意取最窄子集（第一人称明确升级承诺），并沿用原规则「不拦『具体以门店确认为准』
 * 类边界声明」的排除设计。
 */

/**
 * 第一人称明确升级承诺（人设内措辞）：我让/请/找同事…确认/联系你。
 *
 * ⚠️ **刻意不收"转人工/人工客服/转接人工"这类词形**：它们是 human_service_phrase_leak
 * （REVISE）的治理对象——出站前会被改写成人设内口径，候选人根本收不到那句话，
 * 拿它当"已向候选人做出的承诺"来触发补动作是错的口径。两条规则正交：
 * 措辞露馅归 human_service_phrase_leak，承诺-动作对账归本规则。
 * 改写后的产物（"我帮你问下同事"）仍会在二审被本规则按下方词形接住，不漏。
 */
const HANDOFF_PROMISE_PATTERNS: readonly RegExp[] = [
  // "我让同事帮你确认下" / "我找负责人问一下再联系你" / "我这边帮你转给店长跟进"
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?(?:帮你|给你)?(?:让|请|找|问|联系|反馈给|转给|转达给)[^。！？\n]{0,12}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,20}(?:确认|核实|处理|跟进|联系你|回复你|答复你|安排)/u,
];

/**
 * 边界声明排除：候选人问的是"以谁为准"，模型说"具体以门店/同事确认为准"——
 * 这是把不确定性如实交代出去，不是承诺自己发起了一次升级动作。
 */
const BOUNDARY_STATEMENT_PATTERN =
  /(?:具体|最终|实际|准确的?)[^。！？\n]{0,8}(?:以|看|按)[^。！？\n]{0,10}(?:同事|负责人|店长|门店|招聘经理|现场|面试时)[^。！？\n]{0,6}(?:确认|沟通|说明|为准|通知)/u;

/** 否定/条件式：本身不构成承诺（"如果同事没联系你，随时找我"）。 */
const NEGATED_PROMISE_PATTERN =
  /(?:如果|要是|万一|假如)[^。！？\n]{0,20}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:没有?|未|不)/u;

/** 本轮是否已发生成功的人工升级动作。 */
const HANDOFF_ACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'request_handoff',
  'raise_risk_alert',
]);

const BOOKING_TOOL_NAMES: ReadonlySet<string> = new Set(['duliday_interview_booking']);

/** 报名类将来时承诺（9-4）：完成时态由 B-5 治理，这里只管将来时。 */
const BOOKING_PROMISE_PATTERN =
  /(?:我(?:们)?(?:这边)?)?(?:马上|这就|现在|稍后|等下|等会儿?)?(?:帮你|给你|替你)(?:提交|submit)?(?:报名|预约|登记|约(?:面试|一下)?|提交报名|提交预约)|(?:我)?这就(?:去)?(?:帮你)?(?:提交|报名|登记)/u;

/**
 * 完成时态的报名口径（"已帮你报好"）归 B-5 报名空头宣称治理，本规则不重复覆盖，
 * 否则同一条投递物会被两套机制各记一笔，档案口径失真。
 */
const BOOKING_COMPLETED_TENSE_PATTERN = /已(?:经)?(?:帮你|给你)?(?:报好|报名成功|登记好|提交)/u;

function hasSuccessfulCall(
  toolCalls: readonly AgentToolCall[],
  names: ReadonlySet<string>,
): boolean {
  return toolCalls.some((call) => names.has(call.toolName) && isSuccessfulCall(call));
}

function isSuccessfulCall(call: AgentToolCall): boolean {
  const result = call.result;
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (record.success === false) return false;
  if (typeof record._errorType === 'string') return false;
  return true;
}

/** precheck 是否已判定本轮可以直接报名；未通过时报名承诺一定是空头的。 */
function isPrecheckReadyToBook(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'duliday_interview_precheck') return false;
    const result = call.result;
    if (!result || typeof result !== 'object') return false;
    return (result as Record<string, unknown>).nextAction === 'ready_to_book';
  });
}

/**
 * handoff 承诺-动作对账。命中 = 模型明确承诺了一次人工升级，但本轮没有任何成功的
 * request_handoff / raise_risk_alert。返回的 OBSERVE 只表示"文本原样放行"——
 * 补动作由 turn-outcome 按本 ruleId 挂 sideEffect 执行。
 */
export function detectHandoffPromiseWithoutAction(text: string, toolCalls: AgentToolCall[] = []) {
  if (!text.trim()) return null;
  if (BOUNDARY_STATEMENT_PATTERN.test(text)) return null;
  if (NEGATED_PROMISE_PATTERN.test(text)) return null;
  if (!HANDOFF_PROMISE_PATTERNS.some((pattern) => pattern.test(text))) return null;
  if (hasSuccessfulCall(toolCalls, HANDOFF_ACTION_TOOL_NAMES)) return null;

  return {
    ruleId: HANDOFF_PROMISE_RECONCILIATION_RULE_ID,
    label:
      '回复明确承诺了一次人工升级（我让/找同事确认、稍后联系你），但本轮没有成功的 ' +
      'request_handoff / raise_risk_alert。文本原样放行，由系统补执行人工介入让承诺成真。',
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}

export const HANDOFF_PROMISE_RECONCILIATION_RULE_ID = 'handoff_promise_reconciliation';

/** 报名类将来时承诺 + 无 booking 动作（9-4）：纯观测，无自动补动作。 */
export function detectBookingPromiseWithoutBooking(text: string, toolCalls: AgentToolCall[] = []) {
  if (!text.trim()) return null;
  if (BOOKING_COMPLETED_TENSE_PATTERN.test(text)) return null;
  if (!BOOKING_PROMISE_PATTERN.test(text)) return null;
  if (hasSuccessfulCall(toolCalls, BOOKING_TOOL_NAMES)) return null;
  // precheck 已放行时"我这就帮你提交"只是下一步动作的自然预告，不算空头。
  if (isPrecheckReadyToBook(toolCalls)) return null;

  return {
    ruleId: 'booking_promise_without_booking',
    label:
      '回复用将来时承诺了报名/预约（"我帮你提交报名"），但本轮没有成功的 ' +
      'duliday_interview_booking，precheck 也未判定 ready_to_book——报名并未提交。',
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}
