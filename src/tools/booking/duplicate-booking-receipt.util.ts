import type { ToolBuildContext } from '@shared-types/tool.types';
import { HANDOFF_REASON_LABELS } from '@enums/handoff-reason.enum';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { formatInterviewTimeForReply } from './booking-reply-format.util';

export interface DuplicateBookingReceiptParams {
  workOrderId?: number;
  interviewTime?: string | null;
  matchedBy?: 'job' | 'brand';
  crossAccount: boolean;
  /** 海绵拒绝后的工单查询结果，未必能核实工单归属或当前面试安排。 */
  spongeRejection?: { context: ToolBuildContext; jobId: number; message: string };
}

/** 本地查重与海绵重复拦截共用回执；已有报名不进入预约失败路径。 */
export function buildDuplicateBookingReceipt(
  params: DuplicateBookingReceiptParams,
): Record<string, unknown> {
  const { workOrderId, interviewTime, matchedBy, crossAccount, spongeRejection } = params;
  const existingInterviewTimeHuman = interviewTime
    ? formatInterviewTimeForReply(interviewTime)
    : undefined;
  const scopeText = matchedBy === 'brand' ? '同品牌' : '该岗位';
  const needsReview = Boolean(spongeRejection && crossAccount);
  return {
    ...buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED,
      outcome: needsReview
        ? '系统显示已报过该岗位或品牌，本次未重复提交；工单归属和面试安排待人工核实'
        : `${scopeText}已有在途预约工单，本次未重复提交；预约已存在，不是失败`,
      replyInstruction: needsReview
        ? '如实告诉候选人「系统显示你已报过这个岗位或品牌，我让同事核实一下已有报名和面试安排」。' +
          '本轮已携带 duplicate_signup 转人工意图，回复后由系统处理；不要再调用 request_handoff。' +
          '不要把这次申请的面试时间说成已确认，不要重试报名、补收资料或称报名失败。'
        : (crossAccount
            ? `候选人在${scopeText}的面试预约已经存在（由其它托管账号/渠道提交），如实告诉候选人「你之前已经报过这个岗位/品牌」、不用再提交；`
            : `${scopeText}的面试预约已经存在，如实告诉候选人已经约上、不用再提交；`) +
          (existingInterviewTimeHuman
            ? `工单上的面试时间是 ${existingInterviewTimeHuman}，按此播报。`
            : spongeRejection
              ? '工单未记录面试时间，不要把这次申请的时间说成已确认，告诉候选人后续安排待通知。'
              : '工单未记录面试时间时不要编造时间，按 [当前预约信息] 或本轮已确认的时间播报。') +
          '禁止把已有预约描述为系统故障、提交失败或尚待再次提交。' +
          (crossAccount
            ? '本账号无法操作该工单，随后调用 request_handoff(reasonCode="duplicate_signup") 转人工核实。'
            : '改时间用 duliday_modify_interview_time，取消用 duliday_cancel_work_order。'),
      details: {
        ...(workOrderId != null ? { existingWorkOrderId: workOrderId } : {}),
        alreadyBookedSource: spongeRejection ? 'sponge_duplicate_signup' : 'active_booking_dedup',
        matchedBy,
        crossAccount,
        ...(interviewTime ? { existingInterviewTime: interviewTime } : {}),
        ...(existingInterviewTimeHuman
          ? { _existingInterviewTimeHuman: existingInterviewTimeHuman }
          : {}),
      },
    }),
    ...(needsReview && spongeRejection
      ? {
          sideEffect: {
            kind: 'general_handoff',
            source: 'agent_tool',
            origin: 'agent_tool',
            alertLabel: HANDOFF_REASON_LABELS.duplicate_signup,
            reasonCode: 'duplicate_signup',
            reason: `海绵提示已报名，需核实已有工单归属与面试安排：${spongeRejection.message}`,
            actionAdvice:
              '请核实候选人已有报名的账号归属和面试安排，再联系候选人；不要重复提交报名。',
            workOrderId: workOrderId ?? null,
            jobId: spongeRejection.jobId,
            stage: spongeRejection.context.archive.currentStage ?? null,
            botImId: spongeRejection.context.session.botImId,
            recordHandoff: true,
          },
        }
      : {}),
  };
}
