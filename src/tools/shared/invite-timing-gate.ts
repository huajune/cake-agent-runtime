import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { stripTimeContextSuffix } from '@resolution/candidate/name';

/**
 * invite_to_group 时机 gate（tool guardrail，纯函数）。
 *
 * 根因（badcase 63eefu6c / chat 6a68392bce406a6aee39dd0a，2026-07-29）：同一会话里
 * Agent 两次把要**全职**的候选人拉进「深圳餐饮兼职②群」——
 * ① 13:50 在查岗结论出来（13:51）之前就发了群邀请（突兀拉群）；
 * ② 14:01 候选人问「直接去门店面试吗还是怎么样」（报名推进信号）时又发一次。
 * 这三条（先给查岗结论 / 推进信号时禁止打断 / 本会话已拉过群禁止重复）**都已经写在
 * 工具描述里**，模型照样不遵循 —— 与 booking 的 `prechecked` 自证、invite 的 city
 * 自报同一个模式：只靠提示词约束的前置条件迟早会被击穿，必须落成确定性闸门。
 *
 * 三档判定（顺序即优先级），均为可恢复拒绝（reject_collect 语义）：
 * - `already_invited_city`：本会话已给同城市拉过群 → 重复邀请只会骚扰候选人；
 *   换城市（候选人真的搬了）放行，只记日志。
 * - `no_job_result_this_turn`：本轮没跑过 duliday_job_list → 候选人还不知道有岗没岗，
 *   先给查岗结论再谈群。
 * - `booking_progress_signal`：本轮候选人正在推进某个岗位的报名/约面 → 拉群是"无岗维护"
 *   场景，不是"有岗推进"场景，此时拉群等于打断成单。
 *
 * 预约成功后拉群（工具描述场景 1）走 `bookingSucceeded === true`，天然豁免后两档：
 * 该路径既不需要本轮查岗，候选人问"几点面试"也属正常收尾而非被打断。
 */

/** 报名/约面推进信号：候选人正在往成单方向走，此时拉群即打断。 */
const BOOKING_PROGRESS_SIGNAL_RE =
  /(怎么报名|咋报名|如何报名|怎样报名|报名流程|在哪报名|哪里报名|能报名吗|可以报名吗|报名要什么|几点面试|什么时候面试|面试时间|面试地址|去哪面试|面试在哪|怎么面试|面试怎么|能面试吗|可以面试吗|直接去(?:门店|店里|店)?面试|明天(?:能|可以)?(?:去)?面)/u;

export type InviteTimingGateVerdict =
  | { decision: 'allow' }
  | {
      decision: 'reject';
      reason: 'already_invited_city' | 'no_job_result_this_turn' | 'booking_progress_signal';
      /** already_invited_city 时给出已拉过的群名，供模型据实回应候选人。 */
      invitedGroupName?: string;
    };

export interface InviteTimingGateInput {
  /** 模型传入的 city 参数。 */
  requestedCity: string;
  /** 本轮是否执行过 duliday_job_list（由该工具回合内直写，同 bookingSucceeded 模式）。 */
  jobListExecutedThisTurn: boolean;
  /** 本轮 booking 是否成功；true 即工具描述的场景 1，豁免后两档。 */
  bookingSucceeded?: boolean;
  /** 会话记忆里已拉过的群（城市 + 群名）。 */
  invitedGroups?: readonly { groupName?: string | null; city?: string | null }[];
  /** 本轮候选人原话（含 debounce 合并的多条）。 */
  currentUserMessage?: string | null;
}

export function evaluateInviteTimingGate(input: InviteTimingGateInput): InviteTimingGateVerdict {
  const requested = normalizeCity(input.requestedCity);

  const duplicate = (input.invitedGroups ?? []).find(
    (group) => group.city != null && normalizeCity(group.city) === requested,
  );
  if (duplicate) {
    return {
      decision: 'reject',
      reason: 'already_invited_city',
      invitedGroupName: duplicate.groupName ?? undefined,
    };
  }

  // 预约成功后拉群：查岗结论与推进信号两档不适用。
  if (input.bookingSucceeded === true) return { decision: 'allow' };

  if (!input.jobListExecutedThisTurn) {
    return { decision: 'reject', reason: 'no_job_result_this_turn' };
  }

  const userText = stripTimeContextSuffix(input.currentUserMessage ?? '');
  if (userText && BOOKING_PROGRESS_SIGNAL_RE.test(userText)) {
    return { decision: 'reject', reason: 'booking_progress_signal' };
  }

  return { decision: 'allow' };
}
