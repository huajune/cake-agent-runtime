import { toErrorMessage } from '@infra/utils/error.util';
import type { Logger } from '@nestjs/common';
import type { GroupInviteService } from '@biz/group-task/services/group-invite.service';
import type { SessionStateService } from '@memory/short-term/session-state.service';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { readSessionCityForInvite, runGroupInvitePipeline } from './group-invite-pipeline';

/**
 * 报名成功后的运行时拉群（PRD R3）。
 *
 * 首次报名成功是确定信息，拉群不再靠模型在同一轮想起来调 `invite_to_group`：
 * booking 工具在外部工单落地后直接走与 `invite_to_group` 相同的确定性流水线，
 * 把结果放进报名回执，模型只按结果说话。任何失败都不影响报名成功回执。
 */

export type PostBookingGroupInviteSkipReason =
  | 'service_unavailable'
  | 'group_chat'
  | 'additional_candidate'
  | 'not_first_booking'
  | 'city_unknown'
  | 'already_invited';

export interface PostBookingGroupInviteOutcome {
  /** 是否真的走到了拉群执行（闸门放行后）；false 时看 skippedReason。 */
  attempted: boolean;
  success: boolean;
  city?: string;
  groupName?: string;
  delivery?: 'direct_add' | 'invite_card';
  alreadyInGroup?: boolean;
  simulated?: boolean;
  skippedReason?: PostBookingGroupInviteSkipReason;
  /** GroupInviteFailureReason | 城市 gate 拒绝原因 | 'exception'。 */
  failureReason?: string;
}

export interface PostBookingGroupInviteParams {
  context: ToolBuildContext;
  groupInviteService?: GroupInviteService;
  sessionService?: SessionStateService;
  logger: Logger;
  /** 代报同行人的报名：群邀请对象是当前联系人，不为他人的报名拉群。 */
  isAdditionalCandidate: boolean;
  /** 报名前候选人名下已有其他在途工单：不是本会话首次报名。 */
  hasOtherActiveBookings: boolean;
}

/** 候选人城市：会话高置信事实 → 本轮工具确权城市 → 本轮 geocode 锚点；全无则未知。 */
async function resolveCandidateCity(
  context: ToolBuildContext,
  sessionService: SessionStateService | undefined,
  logger: Logger,
): Promise<string | null> {
  const sessionCity = await readSessionCityForInvite(context, sessionService, logger);
  if (sessionCity) return sessionCity;
  const attested = context.ledger.geo.cityAttestation?.city?.trim();
  if (attested) return attested;
  for (const anchor of [...(context.ledger.geo.anchors ?? [])].reverse()) {
    const city = anchor.city?.trim();
    if (city) return city;
  }
  return null;
}

function skipped(
  reason: PostBookingGroupInviteSkipReason,
  extra: Partial<PostBookingGroupInviteOutcome> = {},
): PostBookingGroupInviteOutcome {
  return { attempted: false, success: false, skippedReason: reason, ...extra };
}

export async function runPostBookingGroupInvite(
  params: PostBookingGroupInviteParams,
): Promise<PostBookingGroupInviteOutcome> {
  const { context, groupInviteService, sessionService, logger } = params;
  const outcome = await evaluate(params);
  context.ledger.jobs.postBookingGroupInvite = outcome;
  logger.log(
    `[booking] 报名后拉群结果: attempted=${outcome.attempted} success=${outcome.success}` +
      ` city=${outcome.city ?? '-'} group=${outcome.groupName ?? '-'}` +
      ` skipped=${outcome.skippedReason ?? '-'} failure=${outcome.failureReason ?? '-'}` +
      ` (user=${context.session.userId})`,
  );
  return outcome;

  async function evaluate(
    input: PostBookingGroupInviteParams,
  ): Promise<PostBookingGroupInviteOutcome> {
    if (!groupInviteService) return skipped('service_unavailable');
    if (context.session.imRoomId) return skipped('group_chat');
    if (input.isAdditionalCandidate) return skipped('additional_candidate');
    if (input.hasOtherActiveBookings) return skipped('not_first_booking');

    let city: string | null = null;
    try {
      city = await resolveCandidateCity(context, sessionService, logger);
    } catch (error: unknown) {
      logger.warn(`[booking] 报名后拉群读取城市异常，按城市未知跳过: ${toErrorMessage(error)}`);
    }
    if (!city) return skipped('city_unknown');

    try {
      const pipeline = await runGroupInvitePipeline({
        context,
        city,
        groupInviteService,
        sessionService,
        logger,
      });
      switch (pipeline.kind) {
        case 'already_invited':
          return skipped('already_invited', {
            city,
            groupName: pipeline.verdict.invitedGroupName,
          });
        case 'already_in_group':
          return {
            attempted: true,
            success: true,
            city,
            groupName: pipeline.result.groupName,
            alreadyInGroup: true,
          };
        case 'city_rejected':
          return { attempted: true, success: false, city, failureReason: pipeline.verdict.reason };
        case 'simulated':
          return {
            attempted: true,
            success: true,
            city,
            groupName: pipeline.groupName,
            delivery: 'invite_card',
            simulated: true,
          };
        case 'invited': {
          const { result } = pipeline;
          if (!result.success) {
            return {
              attempted: true,
              success: false,
              city,
              groupName: result.groupName,
              failureReason: result.reason ?? 'api_failed',
            };
          }
          return {
            attempted: true,
            success: true,
            city,
            groupName: result.groupName,
            ...(result.alreadyInGroup
              ? { alreadyInGroup: true }
              : { delivery: result.inviteDelivery }),
          };
        }
      }
    } catch (error: unknown) {
      logger.error(
        `[booking] 报名后拉群异常（不影响报名回执）: ${toErrorMessage(error)} (user=${context.session.userId})`,
      );
      return { attempted: true, success: false, city, failureReason: 'exception' };
    }
  }
}

const GROUP_BOUNDARY_REMINDER =
  '这是兼职岗位信息群，不是面试群，不得把腾讯会议链接或面试通知关联到这个群；禁止输出、编造或粘贴任何群链接 / URL。';

const NO_TOOL_REMINDER = '拉群已由系统在本轮处理完毕，不要再调用 invite_to_group。';

/** 给模型的群动作说明：只按结果说话。 */
export function buildPostBookingGroupInviteGuide(outcome: PostBookingGroupInviteOutcome): string {
  if (outcome.success) {
    const groupName = outcome.groupName ?? '';
    if (outcome.alreadyInGroup) {
      return (
        `候选人已经在兼职岗位信息群「${groupName}」里（系统实时核验），本轮不要承诺拉群、不要说"已拉你进群"；` +
        `候选人主动问群时，告知已在该群并带实际群名。${GROUP_BOUNDARY_REMINDER}${NO_TOOL_REMINDER}`
      );
    }
    if (outcome.delivery === 'direct_add') {
      return (
        `系统已在报名成功后把候选人直接加入兼职岗位信息群「${groupName}」。告知报名成功后，顺带说明已加入该群并带实际群名，` +
        `说明群用于查看兼职岗位信息。${GROUP_BOUNDARY_REMINDER}${NO_TOOL_REMINDER}`
      );
    }
    return (
      `系统已在报名成功后向候选人发送兼职岗位信息群「${groupName}」的入群邀请卡片。告知报名成功后，顺带说明邀请已发送、点击卡片即可入群并带实际群名，` +
      `说明群用于查看兼职岗位信息。${GROUP_BOUNDARY_REMINDER}${NO_TOOL_REMINDER}`
    );
  }
  const reason = outcome.skippedReason ?? outcome.failureReason ?? 'unknown';
  return (
    `系统本轮未完成拉群（原因: ${reason}）。不要向候选人提及群相关内容，不要承诺拉群或说"已发邀请"，` +
    `报名成功回执照常告知。${NO_TOOL_REMINDER}`
  );
}

/** 写进 booking.succeeded 运营事件 payload 的结构化结果（周报「首次报名后同轮拉群率」口径来源）。 */
export function describePostBookingGroupInviteForEvent(
  outcome: PostBookingGroupInviteOutcome,
): Record<string, unknown> {
  const status = outcome.success
    ? outcome.alreadyInGroup
      ? 'already_in_group'
      : 'invited'
    : outcome.attempted
      ? `failed:${outcome.failureReason ?? 'unknown'}`
      : `skipped:${outcome.skippedReason ?? 'unknown'}`;
  return {
    outcome: status,
    attempted: outcome.attempted,
    success: outcome.success,
    city: outcome.city ?? null,
    group_name: outcome.groupName ?? null,
    delivery: outcome.delivery ?? null,
    simulated: outcome.simulated ?? false,
  };
}
