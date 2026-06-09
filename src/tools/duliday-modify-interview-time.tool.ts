/**
 * DuLiDay 修改约面时间工具
 *
 * 候选人主动要求改约面试时间（改期/换一天）时，自助调海绵修改约面时间接口完成改约。
 * 自助优先：接口失败或无工单号时，回退 request_handoff(modify_appointment) 转人工。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import { OpsEventsRecorderService } from '@biz/ops-events/ops-events-recorder.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('duliday_modify_interview_time');

/** 海绵约面时间格式：yyyy-MM-dd HH:mm（与接口契约一致，不含秒）。 */
const NEW_INTERVIEW_TIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const DESCRIPTION = `修改约面时间。候选人**主动**要求把一个**已确认的**面试改到新时间时调用，真正调海绵改约接口更新该工单的约面时间。

## 调用前提（全部满足才调用）
1. [当前预约信息] 存在且带有「工单号」——必须把该工单号原样填入 workOrderId 入参；没有工单号时**禁止**调用本工具
2. 候选人是**主动**要求改时间/改期/换一天，例如"能不能改到明天"、"约的那天我去不了，换周一行吗"、"想改个时间"
3. 已经和候选人确认了**具体的新时间点**（到分钟）。新时间含糊（"下周吧""随便哪天"）时先追问确认，不要猜时间提交

## 不要调用的场景
- 候选人只是要**取消**、不另约 → 用 duliday_cancel_work_order
- 招募经理上一条刚抛出多个候选时段让候选人挑、候选人首次选时段 → 属于首次约面（booking 流程），不是改约
- 没有 [当前预约信息] 或拿不到工单号 → 说明尚无已确认预约，按首次约面流程处理，不要调用本工具
- 候选人说已被门店面试通过/餐厅自招/办入职/已上岗等 → 走 request_handoff

## 参数
- workOrderId：必填，取自 [当前预约信息] 的「工单号」
- newInterviewTime：必填，新约面时间，格式必须为 YYYY-MM-DD HH:mm（不含秒），例如 2026-06-20 14:00

## 成功/失败处理硬规则
- **只有当本工具返回 success 后**，才能向候选人确认改约成功并复述新的面试时间
- 失败时按 _replyInstruction 行动：自助改约失败应转人工（request_handoff，reasonCode=modify_appointment），不要原样复读报错、不要透露接口细节、不要谎称已改约`;

const inputSchema = z.object({
  workOrderId: z.number().int().positive().describe('工单 ID，取自 [当前预约信息] 的「工单号」'),
  newInterviewTime: z
    .string()
    .describe('新约面时间，格式必须为 YYYY-MM-DD HH:mm（不含秒），例如 2026-06-20 14:00'),
});

/**
 * duliday_modify_interview_time 工具
 *
 * 自助修改已确认面试的约面时间。普通业务工具（非短路）：成功后由 Agent 向候选人复述新时间。
 * workOrderId 由 LLM 从 [当前预约信息] 显式传入；newInterviewTime 在工具层做格式校验。
 * 成功后写入 booking.interview_modified 运营事件。
 */
export function buildModifyInterviewTimeTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ workOrderId, newInterviewTime }) => {
        const chatId = context.chatId ?? context.sessionId;

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

        const tokenContext = buildSpongeTokenContext(context);

        try {
          const result = await spongeService.modifyInterviewTime(
            { workOrderId, newInterviewTime: trimmedTime },
            tokenContext,
          );

          if (!result.success) {
            logger.warn(
              `修改约面时间失败: chatId=${chatId}, workOrderId=${workOrderId}, code=${result.code}, message=${result.message ?? '-'}`,
            );
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REJECTED,
              outcome: '修改约面时间失败',
              replyInstruction:
                '改约未成功。请以真人招募者口吻一句话向候选人说明"我让同事帮你确认一下，稍等"之类的衔接语，并按 request_handoff（reasonCode=modify_appointment）转人工；不要透露接口报错/技术细节，不要谎称已改约。',
              details: { workOrderId, newInterviewTime: trimmedTime },
            });
          }

          logger.log(
            `修改约面时间成功: chatId=${chatId}, workOrderId=${workOrderId}, newInterviewTime=${trimmedTime}`,
          );

          // 运营事件底账：booking.interview_modified。幂等键含新时间，允许同一工单多次改约，
          // 仅 Bull 重试（同工单同新时间）去重。
          void opsEventsRecorder.recordEvent({
            corpId: context.corpId,
            eventName: 'booking.interview_modified',
            idempotencyKey: `${workOrderId}:interview_modified:${trimmedTime}`,
            botImId: context.botImId,
            managerName: context.botUserId,
            userId: context.userId,
            chatId: context.sessionId,
            payload: {
              work_order_id: workOrderId,
              new_interview_time: trimmedTime,
            },
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
            err instanceof Error ? (err.stack ?? err.message) : String(err),
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MODIFY_INTERVIEW_REQUEST_FAILED,
            outcome: '修改约面时间异常',
            replyInstruction:
              '改约未成功。请以真人招募者口吻一句话安抚衔接，并按 request_handoff（reasonCode=modify_appointment）转人工；不要透露接口报错/技术细节，不要谎称已改约。',
            details: {
              workOrderId,
              newInterviewTime: trimmedTime,
              reason: err instanceof Error ? err.message : '未知错误',
            },
          });
        }
      },
    });
  };
}
