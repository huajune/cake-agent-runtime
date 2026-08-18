import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * booking 回执对账（badcase recvoFsFPZHTxw / 7-27 复测 RT-016 第二失败形态）。
 *
 * booking 成功的 _replyInstruction 播报硬指令是 prompt 层约束，已被生产实测击穿：
 * 工单真实建单后回复仍问「你定哪一天」（候选人以为没约上，重复提交撞 already_booked，
 * badcase yfrc6wb9 同族）。本规则做确定性对账——本轮 duliday_interview_booking
 * success=true 是不可逆副作用，回复必须与它一致：
 *
 * - 形态 A（REVISE，近零假阳）：预约已提交却仍在向候选人征询日期/时刻
 *   （「你定哪天/几号方便/什么时候有空」）——直接与已提交的工单矛盾；
 * - 形态 B（OBSERVE）：回复完全未提报名/预约结果（一个报名类词都没有）——
 *   播报缺失，候选人不知已报名；表述方式多样，先 observe 落档累计精确率。
 * - 形态 C（REVISE，2026-07-30 审计 P1-7）：booking **失败**却宣称正在/已经提交——
 *   与形态 A 镜像，对账的是失败路径。
 * - 形态 D（REVISE，2026-08-04 发版回归）：候选人本轮明确说“先别报名/预约”，
 *   回复却仍催其登记或直接承诺安排面试时间——即使没有真实调用工具，也违背了
 *   候选人的当前明确指令；候选人同时想自行到店时，也不得在提示流程后又附和
 *   “那你先自己看看”。
 */
const DATE_ASK_PATTERN =
  /(?:你|您)(?:定|看|选|挑)[^，。！？!?\n]{0,6}(?:哪一?天|几号|几点|什么时候|时间)|(?:哪一?天|几号|几点|什么时候)[^，。！？!?\n]{0,4}(?:方便|有空|合适|可以|行)[^，。！？!?\n]{0,4}[？?]?|(?:选|挑|定)(?:个|一个)[^，。！？!?\n]{0,4}(?:时间|日子|时段)/u;

const BOOKING_MENTION_PATTERN = /报名|预约|登记|约好|约上|已(?:帮你)?约|帮你约|面试|工单/u;

// 已确认口径：回复明确播报了"已约好/已登记/报名成功"。窗口制岗位"已帮你约好周四，
// 你几点方便到店"是合法话术——确认在场时的时间征询不算回执矛盾。
const CONFIRMATION_PATTERN =
  /已(?:经)?(?:帮你|给你)?(?:约|报名|登记|提交|预约)|(?:约|登记|报名|预约)(?:好|上|成功)|帮你(?:约|报)(?:好|上)/u;

// —— 失败路径（2026-07-30 审计 P1-7）————————————————————————————————
// 形态 C：booking 调用失败/报错，回复却以进行时或完成时宣称在提交/已提交预约。
// 生产实例 …_1785332310556：duliday_interview_booking status=error，回复"好的，信息
// 都收到啦，我现在帮你提交两家门店的面试预约"——语义 shadow 判 high 置信 block，
// 硬规则却整条放行（对账前提是 booking 成功，失败即提前 return）。候选人会一直等
// 一个永远不来的回执。
const BOOKING_IN_FLIGHT_CLAIM_PATTERN =
  /(?:现在|这就|马上|立刻|立即|正在|稍后)[^，。！？!?\n]{0,8}(?:帮你|给你)?[^，。！？!?\n]{0,6}(?:提交|报名|预约)/u;

// 敲定式宣称（2026-08-04 审计 P0-3）：booking 失败后 repair 曾产出"那就给你约明天
// （8月4日）下午1点半的面试哈"/"好的，那就定在明天上午10点"——没有"已/正在"词形，
// 上面两个 pattern 都跨不住，二审对修复版复跑本规则时照样放行。"那就约/定"的口吻
// 向候选人传达的是预约已敲定，而工单根本没提交成功（trace …_1785740343589 /
// …_1785748484273，幸被投递层 hosting_paused 丢弃）。
const BOOKING_SETTLED_CLAIM_PATTERN =
  /那就(?:帮你|给你)?(?:约|定|安排)|(?:约|定)在(?:明天|今天|后天|周[一二三四五六日天]|\d{1,2}月\d{1,2}[号日]|\d{1,2}[点:：])/u;

/** 如实披露失败：只认本轮没有提交成功的事实，不把未来重试承诺当作失败回执。 */
const BOOKING_FAILURE_ACKNOWLEDGED_PATTERN =
  /(?:提交|报名|预约|约)[^。！？\n]{0,10}(?:失败|没(?:有)?成功|未成功|不成功|没约上|没成|出了点问题|有点问题)|(?:失败|没能|未能|没有)[^。！？\n]{0,8}(?:提交|报名|预约|约上)|(?:没|未)(?:有|能)?(?:提交|报名|预约)成功/u;

// booking 已失败后，回复不能凭空承诺由当前账号再试、重新提交或稍后推进。
// 这类承诺既没有对应工具事实，也会击穿“只问本次结果时确认失败后立即结束”的终止约束。
const BOOKING_RETRY_PROMISE_PATTERN =
  /(?:我|我们|我这边|这边)[^。！？\n]{0,12}(?:现在|马上|立即|这就|稍后|晚点|明天|回头|一会儿|之后|重新|再)[^。！？\n]{0,10}(?:试|提交|报名|预约|约)|(?:稍后|晚点|明天|回头|一会儿|之后)[^。！？\n]{0,10}(?:我|我们|这边)?[^。！？\n]{0,8}(?:帮你|给你|重新|再)[^。！？\n]{0,8}(?:试|提交|报名|预约|约)|(?:重新|再)(?:帮你|给你)[^。！？\n]{0,4}(?:试|提交|报名|预约|约)/gu;
const NEGATED_BOOKING_RETRY_PATTERN =
  /(?:不能|不会|不再|不要|别|不得|不应|不可以|不可|无需|无法|没法|不承诺)[^，,；;。！？!?\n]{0,18}(?:试|提交|报名|预约|约)/u;

// 候选人明确要求本轮不要推进预约。只认当前 userMessage，避免把历史犹豫错误套到新一轮。
// 事件式而非单布尔正则：同轮“先别报 A 店，帮我报 B 店”以后一个明确意图为准；
// 正向事件落在 opt-out 文本内部（如“别帮我报名”里的“帮我报名”）时不重复计数。
const BOOKING_OPT_OUT_EVENT_PATTERN =
  /(?:我)?(?:先|暂时|暂且|目前|现在)?(?:别|不要|不用|不|不想|不打算|先不|暂不|暂缓|暂停)(?:再)?(?:帮我|给我)?(?:报名|登记|预约|约面|提交|报(?!价|销|税|警|数|表))(?:了)?|(?:报名|登记|预约|约面|提交|报(?!价|销|税|警|数|表))(?:这事|这件事|这边)?(?:先|暂时|暂且)?(?:别|不要|不用|不做|不办|暂缓|暂停|放一放)|(?:^|[，,。！？!?\s])(?:这事|这件事|这个)?(?:先|暂时)?放一放(?:吧|了)?(?=$|[，,。！？!?\s])/gu;

const BOOKING_PROCEED_EVENT_PATTERN =
  /(?:帮我|给我|替我|请|麻烦你|可以|同意|确认|那就|直接|现在|马上|这就)(?:再|继续|直接)?[^，,。！？!?\n]{0,6}(?:报(?:名)?|登记|预约|约面|提交)|(?:改|换)(?:报(?:名)?|约(?:面|预约)?|登记)|重新(?:报(?:名)?|登记|预约|约面)|(?:报名|登记|预约|约面)[^，,。！？!?\n]{0,6}(?:吧|可以|没问题|同意|确认|继续)|直接(?:帮我|给我)?提交/gu;

type BookingIntentEvent = {
  kind: 'opt_out' | 'proceed';
  index: number;
  end: number;
};

function rangesOverlap(left: BookingIntentEvent, right: BookingIntentEvent): boolean {
  return left.index < right.end && right.index < left.end;
}

const FUTURE_BOOKING_PROCEED_PREFIX_PATTERN =
  /(?:等|等到|待)[^。！？!?\n]{0,24}(?:再|时|后)[^。！？!?\n]{0,8}$|(?:以后|之后|回头|到时候|届时|稍后|晚点|晚些时候|改天|下次|过(?:两|几|\d+)天|过(?:一)?阵子|过段时间|有空(?:时|的时候)?|有需要时|需要时)[^。！？!?\n]{0,16}$|(?:想|考虑|决定)(?:好|清楚)(?:了)?(?:以后|之后|后|再)[^。！？!?\n]{0,12}$/u;
const BOOKING_INTENT_TARGET_PATTERN =
  /[A-Za-z0-9]{1,8}\s*店|今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}[号日]?/gu;

function isFutureBookingProceed(userMessage: string, event: BookingIntentEvent): boolean {
  const beforeEvent = userMessage.slice(0, event.index);
  const clauseStart = Math.max(
    beforeEvent.lastIndexOf('，'),
    beforeEvent.lastIndexOf(','),
    beforeEvent.lastIndexOf('。'),
    beforeEvent.lastIndexOf('！'),
    beforeEvent.lastIndexOf('？'),
    beforeEvent.lastIndexOf('!'),
    beforeEvent.lastIndexOf('?'),
    beforeEvent.lastIndexOf('；'),
    beforeEvent.lastIndexOf(';'),
    beforeEvent.lastIndexOf('\n'),
  );
  const eventContext = userMessage.slice(Math.max(clauseStart + 1, event.index - 48), event.end);
  return FUTURE_BOOKING_PROCEED_PREFIX_PATTERN.test(eventContext);
}

function extractIntentTargets(userMessage: string, event: BookingIntentEvent): ReadonlySet<string> {
  const before = userMessage.slice(0, event.index);
  const clauseStart = Math.max(
    before.lastIndexOf('，'),
    before.lastIndexOf(','),
    before.lastIndexOf('。'),
    before.lastIndexOf('！'),
    before.lastIndexOf('？'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
  );
  const after = userMessage.slice(event.end);
  const boundaryOffsets = ['，', ',', '。', '！', '？', '!', '?']
    .map((boundary) => after.indexOf(boundary))
    .filter((offset) => offset >= 0);
  const clauseEnd =
    event.end + (boundaryOffsets.length > 0 ? Math.min(...boundaryOffsets) : after.length);
  const clause = userMessage.slice(clauseStart + 1, clauseEnd);
  return new Set(
    Array.from(clause.matchAll(BOOKING_INTENT_TARGET_PATTERN), (match) =>
      match[0].replace(/\s+/gu, ''),
    ),
  );
}

function hasAmbiguousIntentTargets(
  userMessage: string,
  events: readonly BookingIntentEvent[],
): boolean {
  const targetSets = events.map((event) => extractIntentTargets(userMessage, event));
  if (targetSets.every((targets) => targets.size === 0)) return false;
  if (targetSets.some((targets) => targets.size === 0)) return true;

  const [firstTargets, ...remainingTargets] = targetSets;
  return !Array.from(firstTargets).some((target) =>
    remainingTargets.every((targets) => targets.has(target)),
  );
}

function resolveLatestBookingIntent(userMessage?: string): BookingIntentEvent['kind'] | null {
  if (!userMessage?.trim()) return null;

  const optOutEvents: BookingIntentEvent[] = Array.from(
    userMessage.matchAll(BOOKING_OPT_OUT_EVENT_PATTERN),
    (match) => ({
      kind: 'opt_out' as const,
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }),
  );
  if (optOutEvents.length === 0) return null;

  const proceedEvents: BookingIntentEvent[] = Array.from(
    userMessage.matchAll(BOOKING_PROCEED_EVENT_PATTERN),
    (match) => ({
      kind: 'proceed' as const,
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }),
  )
    .filter((event) => !optOutEvents.some((optOut) => rangesOverlap(event, optOut)))
    .filter((event) => !isFutureBookingProceed(userMessage, event));

  if (
    proceedEvents.length > 0 &&
    hasAmbiguousIntentTargets(userMessage, [...optOutEvents, ...proceedEvents])
  ) {
    // 同轮对不同门店/日期既拒绝又授权时，确定性规则无法可靠绑定回复目标，交语义审查。
    return null;
  }

  const latest = [...optOutEvents, ...proceedEvents]
    .sort((left, right) => left.index - right.index || left.end - right.end)
    .at(-1);
  return latest?.kind ?? null;
}

// 只拦“当前继续推进”的窄词形；“到店前需要先报名约面”这类流程说明不会命中。
const BOOKING_ADVANCE_PATTERNS = [
  /(?:^|[，,。！？!?\n；;])(?:(?:那|要不|你|您|咱们|我们)(?:这边)?(?:先|现在|直接)?|(?:先|现在|直接))(?:把)?(?:报名信息|登记信息)?(?:填(?:一下|下)?|登记(?:一下|下)?|报名(?:一下|下)?|预约(?:一下|下)?|约面)(?:一下|下)?(?:吧|哈)?(?=$|[，,。！？!?\n；;])/gu,
  /(?:^|[，,。！？!?\n；;])(?:你|您)?(?:先)?把(?:报名信息|登记信息|报名资料|资料)(?:填(?:一下|下)?|发(?:给)?我|补(?:一下|下)?|提交(?:一下|下)?)/gu,
  /我(?:这边)?(?:来|先|现在|马上|再)?(?:帮你|给你)?(?:报名|登记|预约|约面|报(?!价|销|税|警|数|表))(?:一下|下)?/gu,
  /我(?:这边)?(?:来|先|现在|马上|再)?(?:帮你|给你)?安排(?:个|一个|一下)?(?:面试)?时间/gu,
] as const;

const NEGATED_BOOKING_ADVANCE_PREFIX_PATTERN =
  /(?:不是|并非|不会|不能|不该|不再|不由|不用|无需|别|不要)(?:由)?[^，,。！？!?\n]{0,8}$/u;
const DEFERRED_BOOKING_CONSENT_PREFIX_PATTERN =
  /(?:等|等到|待|如果|要是)[^。！？!?\n]{0,24}(?:同意|确认|决定|想好|想报名|要报名|主动提出)[^。！？!?\n]{0,12}$/u;

function stripQuotedBookingText(text: string): string {
  return text.replace(
    /“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu,
    (quoted) => ' '.repeat(quoted.length),
  );
}

function containsBookingRetryPromise(replyText: string): boolean {
  const candidateVisibleText = stripQuotedBookingText(replyText);
  for (const match of candidateVisibleText.matchAll(BOOKING_RETRY_PROMISE_PATTERN)) {
    const index = match.index ?? 0;
    const before = candidateVisibleText.slice(0, index);
    const clauseStart = Math.max(
      before.lastIndexOf('，'),
      before.lastIndexOf(','),
      before.lastIndexOf('；'),
      before.lastIndexOf(';'),
      before.lastIndexOf('。'),
      before.lastIndexOf('！'),
      before.lastIndexOf('？'),
      before.lastIndexOf('!'),
      before.lastIndexOf('?'),
      before.lastIndexOf('\n'),
    );
    const localClause = candidateVisibleText.slice(clauseStart + 1, index + match[0].length);
    if (NEGATED_BOOKING_RETRY_PATTERN.test(localClause)) continue;
    return true;
  }
  return false;
}

function containsBookingAdvance(replyText: string): boolean {
  const candidateVisibleText = stripQuotedBookingText(replyText);
  for (const pattern of BOOKING_ADVANCE_PATTERNS) {
    for (const match of candidateVisibleText.matchAll(pattern)) {
      const prefix = candidateVisibleText.slice(0, match.index ?? 0);
      if (NEGATED_BOOKING_ADVANCE_PREFIX_PATTERN.test(prefix)) continue;
      if (DEFERRED_BOOKING_CONSENT_PREFIX_PATTERN.test(prefix)) continue;
      return true;
    }
  }
  return false;
}

const DIRECT_VISIT_INTENT_PATTERN =
  /(?:想|准备|打算|要|先|直接|自己)[^。！？!?\n]{0,12}(?:去|到|过去)[^。！？!?\n]{0,8}(?:门店|店里|店)|(?:去|到|过去)[^。！？!?\n]{0,8}(?:门店|店里|店)[^。！？!?\n]{0,8}(?:看看|看下|问问|了解)|(?:那|要不)?(?:我)?(?:先|直接|自己){1,3}(?:去|过去|前往)(?:现场)?(?:看看|看下|问问|了解)?/u;

const DIRECT_VISIT_ENCOURAGEMENT_PATTERNS = [
  /(?:^|[，,。！？!?\n；;])(?:那就|那|好|好的|可以|行|没问题)?(?:你)?(?:先)?(?:自己)?看看(?:情况)?(?:吧|哈)?(?=$|[，,。！？!?\n；;])/gu,
  /(?:^|[，,。！？!?\n；;])(?:那就|那|好|好的|可以|行|没问题)?(?:你)?(?:先)?(?:自己)?(?:去|过去|到店|去店里|到门店)[^。！？!?\n]{0,6}(?:看看|看下|问问|了解)/gu,
  /(?:^|[，,。！？!?\n；;])(?:可以|行|没问题|好的?)(?:让你)?(?:直接|自行|自己)?(?:去|过去|前往|到店|去店里|到门店)(?:吧|哈)?(?=$|[，,。！？!?\n；;])/gu,
] as const;

function containsDirectVisitEncouragement(replyText: string): boolean {
  const candidateVisibleText = stripQuotedBookingText(replyText);
  return DIRECT_VISIT_ENCOURAGEMENT_PATTERNS.some((pattern) =>
    Array.from(candidateVisibleText.matchAll(pattern)).some((match) => Boolean(match[0].trim())),
  );
}

function findFailedBooking(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (const call of toolCalls) {
    if (call.toolName !== 'duliday_interview_booking') continue;
    if (call.status === 'error') return call;
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : null;
    if (result?.success === false) return call;
  }
  return null;
}

function findSuccessfulBooking(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (const call of toolCalls) {
    if (call.toolName !== 'duliday_interview_booking' || call.status === 'error') continue;
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : null;
    if (result?.success === true) return call;
  }
  return null;
}

/**
 * 取 booking 成功结果里的人类可读面试时间（`8月6日（周四）14:00`）。
 *
 * 该字段由 formatInterviewTimeForReply 生成，**自带星期**，是候选人唯一能用来核对
 * "约的是不是我要的那天"的锚点。等通知岗位（wait_notice，无 interviewTime）不产出
 * 该字段，本形态自然不适用。
 */
function readConfirmedInterviewTimeHuman(booking: AgentToolCall): string | null {
  const result =
    booking.result && typeof booking.result === 'object' && !Array.isArray(booking.result)
      ? (booking.result as Record<string, unknown>)
      : null;
  const value = result?._confirmedInterviewTimeHuman;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 回复是否把已建单的那一天告诉了候选人。
 *
 * 判据刻意宽松——只要**月日**或**星期**任一出现即放行：目的是保证候选人拿得到可核对
 * 的锚点，不是规定话术怎么写。日期与星期是否自洽由 date_reference_mismatch 负责，
 * 本规则不重复对账，避免同一条回复被两条规则夹击。
 */
function replyStatesBookedDate(replyText: string, confirmedTimeHuman: string): boolean {
  if (replyText.includes(confirmedTimeHuman)) return true;
  // 容忍空格与「日/号」两种写法：生产走 formatInterviewTimeForReply（`8月6日（周四）14:00`），
  // 但该字段历史上也出现过手写形态（`6 月 18 号（周四）上午 10 点`），解析过严会把
  // 已如实播报日期的回复误判成未播报。
  const parsed = confirmedTimeHuman.match(
    /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号](?:\s*（\s*(周.)\s*）)?/u,
  );
  if (!parsed) return false;
  const [, month, day, weekday] = parsed;
  const monthDay = new RegExp(`${month}\\s*月\\s*${day}\\s*[日号]`, 'u');
  if (monthDay.test(replyText)) return true;
  return weekday ? replyText.includes(weekday) : false;
}

function findSuccessfulJobPoolInvite(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (const call of toolCalls) {
    if (call.toolName !== 'invite_to_group' || call.status === 'error') continue;
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : null;
    if (result?.success === true && result.groupPurpose === 'job_pool') return call;
  }
  return null;
}

function requiresManualInterviewGroup(booking: AgentToolCall): boolean {
  const result =
    booking.result && typeof booking.result === 'object' && !Array.isArray(booking.result)
      ? (booking.result as Record<string, unknown>)
      : null;
  const handling =
    result?.interviewGroupHandling &&
    typeof result.interviewGroupHandling === 'object' &&
    !Array.isArray(result.interviewGroupHandling)
      ? (result.interviewGroupHandling as Record<string, unknown>)
      : null;
  return handling?.required === true && handling.delivery === 'manual';
}

const INTERVIEW_GROUP_COMPLETION_CLAIM_PATTERN =
  /面试群[^。！？\n]{0,18}(?:已经|已|刚)[^。！？\n]{0,10}(?:发|拉|邀请)|(?:已经|已|刚)[^。！？\n]{0,12}(?:发|拉|邀请)[^。！？\n]{0,12}面试群/u;
const INTERVIEW_GROUP_IDENTITY_SPLIT_PATTERN =
  /(?:工作人员|运营|人工|机器人|同事)[^。！？\n]{0,16}(?:发|拉|邀请|处理|接手)|(?:转交|转给|切换|接管)[^。！？\n]{0,12}(?:工作人员|运营|人工|同事)/u;
const MEETING_GROUP_PROMISE_PATTERN = /腾讯会议|会议链接|按时入会|上线入会/u;
const GROUP_PURPOSE_DISTINCTION_PATTERN =
  /兼职[^。！？\n]{0,30}(?:群|岗位信息)[\s\S]{0,100}面试群[\s\S]{0,40}(?:接着|随后|稍后|单独)[^。！？\n]{0,12}(?:发|邀请)|面试群[\s\S]{0,40}(?:接着|随后|稍后|单独)[^。！？\n]{0,12}(?:发|邀请)[\s\S]{0,100}兼职[^。！？\n]{0,30}(?:群|岗位信息)/u;

/**
 * 本轮 precheck 返回的在途工单（duplicateBookingGuard）。
 *
 * precheck 命中它时会在 _replyInstruction 里点名"改时间用 duliday_modify_interview_time
 * （传该工单号）"；模型不照做时，工单时间与回复口径就会分叉。
 */
function findActiveWorkOrderGuard(
  toolCalls: AgentToolCall[],
): { workOrderId?: number; interviewTime?: string } | null {
  for (const call of [...toolCalls].reverse()) {
    if (call.toolName !== 'duliday_interview_precheck' || call.status === 'error') continue;
    const guard = asRecord(asRecord(call.result)?.duplicateBookingGuard);
    if (!guard) continue;
    return {
      workOrderId: typeof guard.workOrderId === 'number' ? guard.workOrderId : undefined,
      interviewTime: typeof guard.interviewTime === 'string' ? guard.interviewTime : undefined,
    };
  }
  return null;
}

/** 本轮是否成功改约。 */
function hasSuccessfulModify(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some(
    (call) =>
      call.toolName === 'duliday_modify_interview_time' &&
      call.status !== 'error' &&
      asRecord(call.result)?.success === true,
  );
}

/** 回复里对某个钟点的确认口径："15:30没问题" / "3点半可以" / "就约十五点半"。 */
const TIME_CONFIRMATION_PATTERN =
  /(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点(?:半|\d{1,2}分?)?|[一二三四五六七八九十]+\s*点(?:半)?)[^。！？!?\n]{0,12}(?:没问题|可以的?|行的?|OK|ok|安排好了?|定了?|没得问题|已(?:经)?(?:改|调整|安排|确认)好?)/u;

/** 把 `2026-08-06 15:00` / `2026/08/06 15:00` 里的钟点归一成分钟数，用于比对。 */
function extractWorkOrderMinutes(interviewTime: string | undefined): number | null {
  const match = /(\d{1,2})\s*[:：]\s*(\d{2})/u.exec(interviewTime ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 回复里被确认的钟点（分钟数）；识别 `15:30` / `3点半` / `下午3点` 三类写法。 */
function extractConfirmedMinutes(replyText: string): number[] {
  const result: number[] = [];
  for (const match of replyText.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/gu)) {
    result.push(Number(match[1]) * 60 + Number(match[2]));
  }
  for (const match of replyText.matchAll(/(下午|晚上|中午)?\s*(\d{1,2})\s*点\s*(半|\d{1,2})?/gu)) {
    let hour = Number(match[2]);
    if (match[1] && hour < 12) hour += 12;
    const minute = match[3] === '半' ? 30 : match[3] ? Number(match[3]) : 0;
    result.push(hour * 60 + minute);
  }
  return result;
}

export function detectBookingReceiptMismatch(
  replyText: string,
  toolCalls: AgentToolCall[],
  userMessage?: string,
): RuleContradiction | null {
  if (!replyText.trim()) return null;

  // 形态 F（badcase 2026-08-06 chat 6a1e42c5 trace …_1785977561594）：
  // precheck 已返回在途工单 455384（约面时间 15:00）并点名改时间要调
  // duliday_modify_interview_time，模型零工具调用，回复却确认了"15:30没问题"。
  // 工单至今是 15:00，候选人会按 15:30 到店白跑一趟——不可挽回，故 REVISE 而非 OBSERVE。
  // 该轮首审只命中了 handoff_promise_without_handoff（已于 8-11 下线；"让同事确认下"），repair 删掉承诺
  // 改成"没问题"后二审无人可拦；回归闸的 commitment_upgraded 是并联防线，本规则则覆盖
  // "模型首版就直接确认"这条 repair 链够不着的路径。
  const activeGuard = findActiveWorkOrderGuard(toolCalls);
  if (activeGuard && !hasSuccessfulModify(toolCalls) && TIME_CONFIRMATION_PATTERN.test(replyText)) {
    const workOrderMinutes = extractWorkOrderMinutes(activeGuard.interviewTime);
    const confirmedMinutes = extractConfirmedMinutes(replyText);
    // 只在回复确认的钟点与工单**不同**时判——复述工单既有时间是如实陈述，必须放行。
    const confirmsDifferentTime =
      workOrderMinutes === null
        ? confirmedMinutes.length > 0
        : confirmedMinutes.some((minutes) => minutes !== workOrderMinutes);
    if (confirmsDifferentTime) {
      return {
        ruleId: 'interview_time_change_unconfirmed',
        label:
          `本轮 precheck 返回在途工单${activeGuard.workOrderId ? `（${activeGuard.workOrderId}）` : ''}` +
          `约面时间为 ${activeGuard.interviewTime ?? '既有时间'}，回复却确认了另一个时间，` +
          '但本轮没有成功的 duliday_modify_interview_time——工单未改，候选人会按错误时间到店',
        action: GUARDRAIL_ACTION.REVISE,
        feedbackToGenerator:
          '本轮预检返回候选人在该岗位已有在途工单，约面时间是 ' +
          `${activeGuard.interviewTime ?? '工单上的既有时间'}，而本轮并没有成功调用 duliday_modify_interview_time 改约。` +
          '上一版回复却确认了另一个面试时间，当前文本不可发送——工单没改，候选人会按你确认的时间白跑一趟。' +
          '请删除对新时间的任何确认、应允或"没问题/可以"类表述，改为如实告知工单上现在的时间，' +
          '并说明改时间需要重新处理。严禁新增本轮工具结果之外的任何时间事实，也不得承诺由自己或同事稍后确认；' +
          '其余未被点名的内容逐字保留。',
      };
    }
  }

  const latestBookingIntent = resolveLatestBookingIntent(userMessage);
  if (
    latestBookingIntent === 'opt_out' &&
    userMessage &&
    DIRECT_VISIT_INTENT_PATTERN.test(userMessage) &&
    containsDirectVisitEncouragement(replyText)
  ) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        '候选人明确暂不报名且想自行到店，回复在提示流程后仍附和其“先自己看看”，变相鼓励未预约到店',
      action: GUARDRAIL_ACTION.REVISE,
      feedbackToGenerator:
        '候选人本轮明确暂不报名，上一版虽然说明未报名到店可能无法接待，却又用“那你先自己看看/先过去了解下”等话术附和其自行到店，当前文本不可发送。' +
        '请删除该附和，只保留“到店前需要先报名约面，否则门店无法接待”的流程说明，并以“既然暂不报名，这轮先不推进”收口；不得提供定位或到店指引。',
    };
  }

  if (latestBookingIntent === 'opt_out' && containsBookingAdvance(replyText)) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        '候选人本轮明确要求先别报名/预约，回复却仍催其登记或承诺安排面试时间，违背当前明确指令',
      action: GUARDRAIL_ACTION.REVISE,
      feedbackToGenerator:
        '候选人本轮已经明确说先别报名/预约。上一版在解释到店流程后仍催候选人登记或承诺安排面试时间，当前文本不可发送。' +
        '请只说明“未报名约面时不建议直接到店，否则门店无法接待”，并尊重候选人暂不报名的决定；等候选人主动同意后再推进。' +
        '不得催其登记，也不得声称或承诺已经/将要安排面试时间；其余未被点名的内容逐字保留。',
    };
  }

  const booking = findSuccessfulBooking(toolCalls);
  if (!booking) {
    const failedBooking = findFailedBooking(toolCalls);
    const retryPromise = failedBooking ? containsBookingRetryPromise(replyText) : false;
    if (
      failedBooking &&
      (retryPromise ||
        (!BOOKING_FAILURE_ACKNOWLEDGED_PATTERN.test(replyText) &&
          (BOOKING_IN_FLIGHT_CLAIM_PATTERN.test(replyText) ||
            CONFIRMATION_PATTERN.test(replyText) ||
            BOOKING_SETTLED_CLAIM_PATTERN.test(replyText))))
    ) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label: retryPromise
          ? '本轮 duliday_interview_booking 调用失败，回复却承诺由当前账号重新提交或稍后再试'
          : '本轮 duliday_interview_booking 调用失败，回复却宣称正在提交或已提交面试预约' +
            '——回执永远不会来，候选人会一直空等（badcase …_1785332310556）',
        action: GUARDRAIL_ACTION.REVISE,
        // 目录里的 feedback 是为成功路径写的（"本轮预约已真实提交成功"），直接复用会
        // 指示重写者把失败说成成功。失败路径必须带自己的口径。
        feedbackToGenerator:
          '本轮 duliday_interview_booking 调用失败，预约并未提交成功。上一版回复宣称正在/已经提交，或承诺重新提交、稍后再试，当前文本不可发送。' +
          '请只如实告知候选人这次没有提交成功；不得承诺以后重试、重新提交、确认或通知，也不要给出任何“等回执/等通知”的暗示。' +
          '如果候选人只问本次预约结果，必须在确认失败事实处结束，不得添加下一步建议；' +
          '回复中与预约状态无关的内容（岗位信息、候选人问题的回答等）逐字保留。',
      };
    }
    return null;
  }

  if (requiresManualInterviewGroup(booking)) {
    if (INTERVIEW_GROUP_IDENTITY_SPLIT_PATTERN.test(replyText)) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '面试群补发由当前企微账号无感承接，回复却出现工作人员/运营/人工/同事接手等身份切换表述，' +
          '会暴露账号背后的执行切换',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }

    if (INTERVIEW_GROUP_COMPLETION_CLAIM_PATTERN.test(replyText)) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '本岗位面试群只能由当前企微账号随后手动发送，回复却声称面试群已经发送/已拉入；' +
          '这会把未来动作说成已完成',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }

    const jobPoolInvite = findSuccessfulJobPoolInvite(toolCalls);
    if (
      jobPoolInvite &&
      MEETING_GROUP_PROMISE_PATTERN.test(replyText) &&
      !GROUP_PURPOSE_DISTINCTION_PATTERN.test(replyText)
    ) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '本轮 invite_to_group 发送的是兼职岗位信息群，回复却没有把它与待手动发送的面试群区分，' +
          '容易让候选人误以为兼职群会发送腾讯会议链接',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }

  if (DATE_ASK_PATTERN.test(replyText) && !CONFIRMATION_PATTERN.test(replyText)) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        '本轮 duliday_interview_booking 已成功提交工单，回复却仍在向候选人征询面试日期/时间' +
        '——与已提交的预约直接矛盾，候选人会以为没约上而重复提交或流失',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  if (!BOOKING_MENTION_PATTERN.test(replyText)) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        '本轮 duliday_interview_booking 已成功提交工单，回复却完全未向候选人播报报名结果' +
        '（badcase yfrc6wb9：候选人不知已报名，重复提交撞 already_booked）',
      action: GUARDRAIL_ACTION.OBSERVE,
    };
  }

  // 形态 E：工单已按某个具体日期建单，回复却没把这个日期告诉候选人。
  const confirmedTime = readConfirmedInterviewTimeHuman(booking);
  if (confirmedTime && !replyStatesBookedDate(replyText, confirmedTime)) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        `本轮 duliday_interview_booking 已按「${confirmedTime}」建单，回复却没有把这个日期告诉候选人` +
        '——候选人无从发现日期被约错（badcase 0091mnfr：候选人选周三、工单落周四，次日到店下车才发现）',
      action: GUARDRAIL_ACTION.REVISE,
      feedbackToGenerator:
        `本轮预约已真实提交成功，工单登记的面试时间是「${confirmedTime}」。上一版回复没有把这个日期原样告诉候选人，当前文本不可发送。` +
        `请在回复中**逐字**给出「${confirmedTime}」（含月日与括号里的星期），让候选人能立刻核对是不是他要的那天；` +
        '其余未被点名的内容逐字保留，不要改变已确认的事实，也不要再向候选人征询日期。',
    };
  }

  return null;
}
