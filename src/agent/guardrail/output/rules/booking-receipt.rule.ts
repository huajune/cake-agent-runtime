import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

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
 *   候选人的当前明确指令。
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

/** 如实披露失败：说了没成功/失败/再试，就不是假宣称。 */
const BOOKING_FAILURE_ACKNOWLEDGED_PATTERN =
  /(?:提交|报名|预约|约)[^。！？\n]{0,8}(?:失败|没成功|未成功|不成功|没约上|没成|出了点问题|有点问题)|(?:失败|没能|未能|没有)[^。！？\n]{0,6}(?:提交|报名|预约)|重新(?:试|提交|约)|稍后(?:再|重新)(?:试|约|提交)/u;

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

export function detectBookingReceiptMismatch(
  replyText: string,
  toolCalls: AgentToolCall[],
  userMessage?: string,
): RuleContradiction | null {
  if (!replyText.trim()) return null;

  if (resolveLatestBookingIntent(userMessage) === 'opt_out' && containsBookingAdvance(replyText)) {
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
    if (
      failedBooking &&
      !BOOKING_FAILURE_ACKNOWLEDGED_PATTERN.test(replyText) &&
      (BOOKING_IN_FLIGHT_CLAIM_PATTERN.test(replyText) ||
        CONFIRMATION_PATTERN.test(replyText) ||
        BOOKING_SETTLED_CLAIM_PATTERN.test(replyText))
    ) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '本轮 duliday_interview_booking 调用失败，回复却宣称正在提交或已提交面试预约' +
          '——回执永远不会来，候选人会一直空等（badcase …_1785332310556）',
        action: GUARDRAIL_ACTION.REVISE,
        // 目录里的 feedback 是为成功路径写的（"本轮预约已真实提交成功"），直接复用会
        // 指示重写者把失败说成成功。失败路径必须带自己的口径。
        feedbackToGenerator:
          '本轮 duliday_interview_booking 调用失败，预约并未提交成功，但上一版回复宣称正在提交或已经提交，当前文本不可发送。' +
          '请如实告知候选人这次没有提交成功、你会重新帮他提交或稍后再试，不要给出任何"等回执/等通知"的暗示；' +
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

  return null;
}
