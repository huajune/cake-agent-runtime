/**
 * DuLiDay 修改约面时间工具
 *
 * 候选人主动要求改约面试时间（改期/换一天）时，自助调海绵修改约面时间接口完成改约。
 * 自助优先：接口失败时回执自带转人工副作用（modify_appointment + 工单号/岗位/失败原因），
 * 模型只需如实告知已转同事；无工单号时仍回退 request_handoff(modify_appointment)。
 *
 * 工单归属两级核验：先看 active_booking 指针；不在指针里（真人后台手工建单、[当前预约信息]
 * 按手机号带外查得）时，再拿工单登记手机号与候选人本会话自报原话核对，一致即视为本人、
 * 放行并回填指针；核对不上一律 fail-closed 转人工，绝不跨微信联系人改单。
 */

import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';
import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { buildSpongeTokenContext } from '@tools/shared/sponge-token-context.util';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import type { ToolBuilder } from '@shared-types/tool.types';
import type { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import {
  bookingEventSource,
  findSnapshotWorkOrder,
  resolveBookingOwnership,
} from '@tools/booking/booking-ownership.util';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import {
  buildToolFailureHandoffSideEffect,
  buildToolFailureReplyInstruction,
} from '@tools/shared/tool-failure-handoff.util';
import { isInterviewSlotAvailabilityInquiryOnly } from '@tools/booking/interview-time-intent.util';

const logger = new Logger('duliday_modify_interview_time');

/** 海绵约面时间格式：yyyy-MM-dd HH:mm（与接口契约一致，不含秒）。 */
const NEW_INTERVIEW_TIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const DESCRIPTION = `修改约面时间。候选人**主动**要求把一个**已确认的**面试改到新时间时调用，真正调海绵改约接口更新该工单的约面时间。

## 调用前提（全部满足才调用）
1. workOrderId 必须来自 [当前预约信息]，或本轮 duliday_interview_precheck 返回的 duplicateBookingGuard.workOrderId（候选人名下同岗位在途工单）；没有真实工单号时**禁止**调用本工具
2. 候选人是**主动**要求修改已确认预约的日期或时间
3. 已经和候选人确认了**具体的新时间点**（到分钟）。新时间含糊时先追问确认，不要猜时间提交
   - **仅询问某时段是否可约，不构成改约确认**：只能 precheck 后回答可约时段，再问候选人是否确定改到该时间；即使 precheck 只返回一个上午场，也禁止擅自取开始时间提交改约
4. **新日期已经过 duliday_interview_precheck 校验确认可约**——改约前必须先用 [当前预约信息] 的「岗位ID」调 duliday_interview_precheck(jobId=岗位ID, requestedDate=候选人想改到的新日期)，只有当返回的 interview.requestedDate.status === "available"（nextAction 不是 date_unavailable）时，才允许调用本工具提交改约。与首次约面"先 precheck 再 booking"完全同一套契约：本工具信任 precheck 的时段结论，自身不再做时段/周末/报名截止的二次校验
5. **工单归属保护**：workOrderId 不在当前微信联系人的 active_booking 中时（典型为 [当前预约信息] 标注"按候选人手机号实时查得、非本会话提交"的工单），本工具会拿工单登记手机号与候选人本会话亲口发过的手机号核对：一致则正常改约；核对不上则不改单、直接短路触发人工介入。严禁跨微信联系人自助修改工单

## precheck 判新日期不可约时（status=unavailable / nextAction=date_unavailable）
- **不要**调用本工具，**也不要**转人工（request_handoff）
- 用 precheck 返回的 interview.scheduleRule + interview.upcomingTimeOptions，以真人招募者口吻告诉候选人该日期约不上、把最近可约时段抛给候选人**继续协商**重选
- 等候选人确认一个具体可约的新时间后，再带新日期重新调一次 duliday_interview_precheck 复核 → 可约后才调本工具

## 不要调用的场景
- 候选人只是要**取消**、不另约 → 用 duliday_cancel_work_order
- 候选人仅查询指定日期或时段的面试可用性 → 只查可用性并回答，等其明确确认具体时间后再改；不要调用本工具，也不要转人工
- 招募经理上一条刚抛出多个候选时段让候选人挑、候选人首次选时段 → 属于首次约面（booking 流程），不是改约
- [当前预约信息] 和本轮 precheck 都拿不到真实工单号 → 说明尚无已确认预约，按首次约面流程处理，不要调用本工具
- 候选人说已被门店面试通过/餐厅自招/办入职/已上岗等 → 走 request_handoff

## 参数
- workOrderId：必填，取自 [当前预约信息] 的「工单号」
- newInterviewTime：必填，新约面时间，格式必须为 YYYY-MM-DD HH:mm（不含秒）。必须是已被 precheck 判为可约的日期上的具体时段

## 成功/失败处理硬规则
- **只有当本工具返回 success 后**，才能向候选人确认改约成功并复述新的面试时间
- 失败时按 _replyInstruction 行动：接口失败的回执已自带转人工（本轮不要再调 request_handoff），你只需如实告诉候选人这次改约暂时处理不了、已转同事跟进；不要原样复读报错、不要透露接口细节、不要谎称已改约`;

const inputSchema = z.object({
  workOrderId: z
    .number()
    .int()
    .positive()
    .describe('工单 ID，取自 [当前预约信息] 或本轮 precheck 实时返回的真实工单号'),
  newInterviewTime: z.string().describe('新约面时间，格式必须为 YYYY-MM-DD HH:mm（不含秒）'),
});

/**
 * duliday_modify_interview_time 工具
 *
 * 自助修改已确认面试的约面时间。普通业务工具（非短路）：成功后由 Agent 向候选人复述新时间。
 * workOrderId 由 LLM 从 [当前预约信息] 或本轮 precheck 实时工单结果显式传入；
 * newInterviewTime 在工具层做格式校验，并在提交前核对工单是否属于当前微信联系人的记忆。
 * 新日期的可约性由 duliday_interview_precheck 负责（改约前置校验），本工具不重复校验时段。
 * 成功后写入 booking.interview_modified 运营事件。
 */
export interface ModifyInterviewTimeToolDeps {
  /** 改约成功后失效该手机号的预约快照缓存（否则 5 分钟内仍显示旧面试时间）。 */
  bookingSnapshot?: Pick<BookingSnapshotService, 'invalidate'>;
}

export function buildModifyInterviewTimeTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
  longTermService: LongTermService,
  deps?: ModifyInterviewTimeToolDeps,
): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ workOrderId, newInterviewTime }) => {
        const chatId = context.session.chatId ?? context.session.sessionId;

        // 测试链路保守整拦：modify 无手机号入参、无法做假身份白名单校验，而
        // workOrderId 可能经 precheck(真实手机号) 取到真实工单——测试重放一旦
        // 提交即误改真实候选人面试（与 booking/cancel 的 PII 闸门同源防线）。
        if (context.runtime.strategySource === 'testing') {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.TEST_LINK_MODIFY_BLOCKED,
            outcome: '测试链路拦截：不执行真实改约提交',
            replyInstruction:
              '当前为测试链路，改约不会真正提交（防止误改真实候选人的面试工单）。' +
              '不得谎称已改约；请按 precheck 的可约结论向候选人说明将为其改约到该时间即可。',
            details: { workOrderId, newInterviewTime },
          });
        }

        if (isInterviewSlotAvailabilityInquiryOnly(context.turnInput.currentUserMessage)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_UNCONFIRMED,
            outcome: '候选人仅询问面试时段是否可约，尚未确认改约',
            replyInstruction:
              '候选人当前只是在问该时段还有没有，并未确认要改约。请根据刚才 precheck 返回的可约时段直接回答，并询问是否确定改到其中一个具体时间；本轮禁止提交改约，也不要转人工。',
            details: { workOrderId, newInterviewTime },
          });
        }

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_MISSING_WORK_ORDER_ID,
            outcome: '缺少有效工单号，无法改约',
            replyInstruction:
              '当前拿不到有效的工单号，无法自助改约。请按 request_handoff（reasonCode=modify_appointment）转人工处理，不要谎称已改约。',
          });
        }

        const trimmedTime = newInterviewTime.trim();
        if (!NEW_INTERVIEW_TIME_REGEX.test(trimmedTime)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_INVALID_TIME,
            outcome: '新约面时间格式不合法',
            replyInstruction:
              '新约面时间格式不对（应为 YYYY-MM-DD HH:mm）。请先和候选人确认一个具体到分钟的新时间，再重新调用本工具；不要把模糊时间或报名截止时间当作面试时间提交。',
            details: { workOrderId, newInterviewTime: trimmedTime },
          });
        }

        // 将本轮核验到的工单号挂入回合上下文；改约失败转 request_handoff 时该工具用它
        // 兜底关联工单（active_booking 查不到时）。归属 gate 拒绝路径的告警工单号
        // 则直接来自本工具结果的 workOrderId 字段（outcome 层读工具结果，不读此上下文）。
        context.ledger.jobs.resolvedWorkOrderId = workOrderId;

        const tokenContext = buildSpongeTokenContext(context);

        // 归属核验：active_booking 指针里的工单直接放行；本轮预约快照里的工单（含真人后台建的
        // 带外单）通过本人校验（海绵登记姓名与候选人姓名一致）即视同自有工单放行——账号边界
        // 保证查得到的就是操作得了的，不再要求登记手机号出现在候选人原话里。
        // 本人校验未通过或不在快照里的一律转人工，不做 active_booking 回填（带外工单不落库）。
        const snapshotRef = findSnapshotWorkOrder(context.archive.bookingWorkOrders, workOrderId);
        const activeBookings = await longTermService.getActiveBookings(
          context.session.corpId,
          context.session.userId,
        );
        const ownership = resolveBookingOwnership({
          workOrderId,
          pointerWorkOrderIds: activeBookings.map((booking) => booking.work_order_id),
          snapshotRefs: context.archive.bookingWorkOrders,
        });
        if (ownership.owned === false) {
          const reasonText =
            ownership.reason === 'identity_mismatch'
              ? '工单登记姓名与候选人本会话自报姓名不一致'
              : '该工单不在本轮预约快照中';
          logger.warn(
            `工单不属于当前联系人（${ownership.reason}），禁止自助改约并转人工: chatId=${chatId}, workOrderId=${workOrderId}`,
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_WORK_ORDER_NOT_IN_MEMORY,
            outcome: `工单不属于当前微信联系人（${reasonText}），已阻止自助改约`,
            replyInstruction:
              '该工单不在当前微信联系人的预约记忆中，或登记姓名与候选人自报不一致，禁止继续自助修改。runtime 会直接触发人工介入并暂停本轮；不要再生成文本或调用 request_handoff。',
            details: {
              shortCircuited: true,
              gateRejected: true,
              reasonCode: 'modify_appointment',
              workOrderId,
              ownershipReason: ownership.reason,
              handoffReason: `候选人要求修改工单 ${workOrderId}，但${reasonText}，为避免跨联系人误改已阻止自助操作。`,
              actionAdvice: `核实当前联系人和工单 ${workOrderId} 的候选人关系，确认后人工修改工单信息。`,
            },
          });
        }
        if (ownership.via === 'snapshot') {
          logger.log(
            `快照工单通过本人校验放行改约: chatId=${chatId}, workOrderId=${workOrderId}, signupSource=${ownership.ref?.signupSource ?? '-'}`,
          );
        }

        try {
          const result = await spongeService.modifyInterviewTime(
            { workOrderId, newInterviewTime: trimmedTime },
            tokenContext,
          );

          if (!result.success) {
            logger.warn(
              `修改约面时间失败: chatId=${chatId}, workOrderId=${workOrderId}, code=${result.code}, message=${result.message ?? '-'}`,
            );
            return {
              ...buildToolError({
                errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REJECTED,
                outcome: '修改约面时间失败',
                replyInstruction: buildToolFailureReplyInstruction('改约'),
                // apiCode/apiMessage 透传海绵后端的拒绝原因，仅供观测落库（dashboard 直接可见，无需翻 Winston 日志）；
                // _replyInstruction 已禁止 LLM 把这些细节复读给候选人。
                details: {
                  workOrderId,
                  newInterviewTime: trimmedTime,
                  apiCode: result.code,
                  apiMessage: result.message ?? null,
                },
              }),
              // 失败即自带转人工（outcome 统一出口在回复投递后落底账/暂停/告警），不再让模型调 request_handoff
              sideEffect: buildToolFailureHandoffSideEffect({
                context,
                action: '改约',
                workOrderId,
                errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REJECTED,
                failureReason: result.message ?? `海绵返回 code=${result.code}`,
                requestedInterviewTime: trimmedTime,
              }),
            };
          }

          logger.log(
            `修改约面时间成功: chatId=${chatId}, workOrderId=${workOrderId}, newInterviewTime=${trimmedTime}`,
          );

          // 运营事件底账：booking.interview_modified。幂等键含新时间，允许同一工单多次改约，
          // 仅 Bull 重试（同工单同新时间）去重。
          void opsEventsRecorder.recordEvent({
            corpId: context.session.corpId,
            eventName: 'booking.interview_modified',
            idempotencyKey: `${workOrderId}:interview_modified:${trimmedTime}`,
            botImId: context.session.botImId,
            managerName: context.session.botUserId,
            userId: context.session.userId,
            chatId: context.session.sessionId,
            payload: {
              work_order_id: workOrderId,
              new_interview_time: trimmedTime,
              // 带外工单（供应商后台建单）的后续改约按来源单列统计。
              source: bookingEventSource(snapshotRef),
            },
          });
          // 预约快照按手机号缓存 5 分钟；不失效会让后续回合仍显示旧面试时间。
          await deps?.bookingSnapshot?.invalidate({
            phone:
              context.archive.bookingCandidateFacts?.phone ??
              context.archive.profile?.phone ??
              null,
            botImId: context.session.botImId,
            corpId: context.session.corpId,
            userId: context.session.userId,
          });

          return {
            success: true,
            errorType: null,
            workOrderId,
            newInterviewTime: trimmedTime,
            _outcome: '改约成功，可以告知候选人新的面试时间',
            _replyInstruction: `已成功把面试改到 ${trimmedTime}。请以真人招募者口吻向候选人确认新的面试时间并叮嘱准时到店，不要提及工单/接口/系统等字眼。`,
          };
        } catch (err) {
          logger.error(
            `修改约面时间异常: chatId=${chatId}, workOrderId=${workOrderId}`,
            toErrorStack(err),
          );
          return {
            ...buildToolError({
              errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REQUEST_FAILED,
              outcome: '修改约面时间异常',
              replyInstruction: buildToolFailureReplyInstruction('改约'),
              details: {
                workOrderId,
                newInterviewTime: trimmedTime,
                reason: toErrorMessage(err) || '未知错误',
              },
            }),
            sideEffect: buildToolFailureHandoffSideEffect({
              context,
              action: '改约',
              workOrderId,
              errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REQUEST_FAILED,
              failureReason: toErrorMessage(err) || '未知错误',
              requestedInterviewTime: trimmedTime,
            }),
          };
        }
      },
    });
  };
}
