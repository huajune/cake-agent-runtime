import { normalizeCityName as normalizeCity } from '@resolution/geo';

/**
 * invite_to_group 时机 gate（tool guardrail，纯函数）。
 *
 * 工具边界只校验可由结构化状态确定的条件；候选人是否已同意入群、是否已经完成
 * 岗位推荐等对话语义，由主 Agent 根据完整上下文判断，工具层不再二次解析文本否决。
 *
 * 当前只保留一档可恢复拒绝（reject_collect 语义）：
 * - `already_invited_city`：本会话已给同城市拉过群 → 重复邀请只会骚扰候选人；
 *   换城市（候选人真的搬了）放行，只记日志。
 */

export type InviteTimingGateVerdict =
  | { decision: 'allow' }
  | {
      decision: 'reject';
      reason: 'already_invited_city';
      /** already_invited_city 时给出已拉过的群名，供模型据实回应候选人。 */
      invitedGroupName?: string;
    };

export interface InviteTimingGateInput {
  /** 模型传入的 city 参数。 */
  requestedCity: string;
  /** 会话记忆里已拉过的群（城市 + 群名）。 */
  invitedGroups?: readonly { groupName?: string | null; city?: string | null }[];
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

  return { decision: 'allow' };
}
