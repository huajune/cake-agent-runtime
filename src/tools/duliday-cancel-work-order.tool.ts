/**
 * DuLiDay 取消工单工具
 *
 * 候选人主动要求取消已确认的面试预约时，自助调海绵取消工单接口完成取消。
 * 取消原因取自海绵失败原因字典（父级 pid 12001），由 LLM 据候选人原话挑选 cancelReasonId。
 * 自助优先：字典/接口失败或无工单号时，回退 request_handoff(modify_appointment) 转人工。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import type { FailureReasonItem } from '@sponge/sponge.types';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { LongTermService } from '@memory/services/long-term.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('duliday_cancel_work_order');

/**
 * 取消原因父级 pid。
 *
 * 取消工单的 cancelReasonId 必须取自该父级下的失败原因字典叶子项；业务侧约定值，集中在此便于调整。
 */
const CANCEL_REASON_PID = 12001;

const DESCRIPTION = `取消工单。候选人**主动**要求取消一个**已确认的**面试预约时调用，真正调海绵取消接口作废该工单。

## 调用前提（全部满足才调用）
1. [当前预约信息] 存在且带有「工单号」——必须把该工单号原样填入 workOrderId 入参；没有工单号时**禁止**调用本工具
2. 候选人是**主动**要求取消/不去了/不想面了，例如"那个面试我不去了"、"帮我取消吧"、"不想去面试了"
3. 仅取消、不另约新时间。若候选人是要"改时间/换一天"，用 duliday_modify_interview_time，不要先取消

## 取消原因（两步法）
- 取消必须带一个 cancelReasonId（取消原因 ID），它来自海绵失败原因字典
- **第一步**：不传 cancelReasonId 调用本工具，工具会返回 availableReasons（可选取消原因列表：id + 描述）
- **第二步**：从 availableReasons 里**按候选人原话**挑出最贴切的一项，把其 id 作为 cancelReasonId 再次调用本工具完成取消
- cancelReasonDesc 可选：结合候选人原话补一句具体描述

## 不要调用的场景
- 候选人只是询问预约状态/时间/门店 → 直接基于 [当前预约信息] 回答
- 没有 [当前预约信息] 或拿不到工单号 → 说明尚无已确认预约，按首次约面流程处理，不要调用本工具
- 候选人说已被门店面试通过/餐厅自招/办入职/已上岗等 → 走 request_handoff

## 参数
- workOrderId：必填，取自 [当前预约信息] 的「工单号」
- cancelReasonId：第二步必填，取自第一步返回的 availableReasons
- cancelReasonDesc：可选，结合候选人原话简述取消原因（如"候选人当天有事去不了"）
- candidateName / phone / brandName / storeName / jobName / interviewTime：可选；若 [当前预约信息] 中有这些字段，尽量原样带上，用于取消通知提醒人工判断是否需要通知门店

## 成功/失败处理硬规则
- **只有当本工具返回 success 后**，才能向候选人确认"已帮你取消这次面试预约"
- 失败时按 _replyInstruction 行动：自助取消失败应转人工（request_handoff，reasonCode=modify_appointment），不要原样复读报错、不要透露接口细节、不要谎称已取消`;

const inputSchema = z.object({
  workOrderId: z.number().int().positive().describe('工单 ID，取自 [当前预约信息] 的「工单号」'),
  cancelReasonId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('取消原因 ID：取自第一步返回的 availableReasons，按候选人原话挑选；首次调用可不传'),
  cancelReasonDesc: z.string().optional().describe('取消原因描述：结合候选人原话简述（可选）'),
  candidateName: z
    .string()
    .optional()
    .describe('候选人姓名：若 [当前预约信息] 中存在则原样带上，用于取消通知展示'),
  phone: z
    .string()
    .optional()
    .describe('候选人手机号：若 [当前预约信息] 中存在则原样带上，用于取消通知展示'),
  brandName: z
    .string()
    .optional()
    .describe('品牌名称：若 [当前预约信息] 中存在则原样带上，用于取消通知展示'),
  storeName: z
    .string()
    .optional()
    .describe('门店名称：若 [当前预约信息] 中存在则原样带上，用于取消通知展示'),
  jobName: z
    .string()
    .optional()
    .describe('岗位名称：若 [当前预约信息] 中存在则原样带上，用于取消通知展示'),
  interviewTime: z
    .string()
    .optional()
    .describe('原面试时间：若 [当前预约信息] 中存在则原样带上，用于取消通知展示'),
});

/**
 * duliday_cancel_work_order 工具
 *
 * 自助取消已确认的面试预约。普通业务工具（非短路）：成功后由 Agent 向候选人确认取消。
 * cancelReasonId 由 LLM 从失败原因字典（pid=CANCEL_REASON_PID）中按原话挑选；
 * workOrderId 由 LLM 从 [当前预约信息] 显式传入。成功后写入 booking.canceled 运营事件。
 */
export function buildCancelWorkOrderTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
  longTermService: LongTermService,
  privateChatNotifier: PrivateChatMonitorNotifierService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        workOrderId,
        cancelReasonId,
        cancelReasonDesc,
        candidateName,
        phone,
        brandName,
        storeName,
        jobName,
        interviewTime,
      }) => {
        const chatId = context.chatId ?? context.sessionId;

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.CANCEL_MISSING_WORK_ORDER_ID,
            outcome: '缺少有效工单号，无法取消',
            replyInstruction:
              '当前拿不到有效的工单号，无法自助取消。请按 request_handoff（reasonCode=modify_appointment）转人工处理，不要谎称已取消。',
          });
        }

        const tokenContext = buildSpongeTokenContext(context);

        // 取消原因字典：拉取父级 pid 下的候选原因，作为 cancelReasonId 的合法集合。
        let reasons: FailureReasonItem[];
        try {
          reasons = await spongeService.fetchFailureReasonsByPids(
            [CANCEL_REASON_PID],
            tokenContext,
          );
        } catch (err) {
          logger.error(
            `取消原因字典拉取异常: chatId=${chatId}, workOrderId=${workOrderId}`,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED,
            outcome: '取消原因字典拉取失败',
            replyInstruction:
              '暂时取不到取消原因，无法自助取消。请以真人招募者口吻一句话安抚衔接，并按 request_handoff（reasonCode=modify_appointment）转人工；不要透露接口细节，不要谎称已取消。',
            details: { workOrderId, reason: err instanceof Error ? err.message : '未知错误' },
          });
        }

        if (reasons.length === 0) {
          logger.warn(
            `取消原因字典为空: chatId=${chatId}, workOrderId=${workOrderId}, pid=${CANCEL_REASON_PID}`,
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED,
            outcome: '取消原因字典为空',
            replyInstruction:
              '暂时取不到可用的取消原因，无法自助取消。请以真人招募者口吻一句话安抚衔接，并按 request_handoff（reasonCode=modify_appointment）转人工；不要谎称已取消。',
            details: { workOrderId },
          });
        }

        const matched = reasons.find((r) => r.id === cancelReasonId);
        if (!matched) {
          // 第一步：未传 / 传了不在字典内的 id → 回吐候选原因列表，让 LLM 据原话挑一个再调。
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.CANCEL_REASON_REQUIRED,
            outcome: '需要先选定取消原因',
            replyInstruction:
              '请从 availableReasons 里按候选人原话挑出最贴切的一项，把它的 id 作为 cancelReasonId 重新调用本工具完成取消。本步不要给候选人发任何"已取消"的消息。',
            details: {
              workOrderId,
              availableReasons: reasons.map((r) => ({ id: r.id, info: r.info })),
            },
          });
        }

        try {
          const result = await spongeService.cancelWorkOrder(
            {
              workOrderId,
              cancelReasonId: matched.id,
              cancelReasonDesc: cancelReasonDesc?.trim() || undefined,
            },
            tokenContext,
          );

          if (!result.success) {
            logger.warn(
              `取消工单失败: chatId=${chatId}, workOrderId=${workOrderId}, code=${result.code}, message=${result.message ?? '-'}`,
            );
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.CANCEL_REJECTED,
              outcome: '取消工单失败',
              replyInstruction:
                '取消未成功。请以真人招募者口吻一句话向候选人说明"我让同事帮你确认一下，稍等"之类的衔接语，并按 request_handoff（reasonCode=modify_appointment）转人工；不要透露接口报错/技术细节，不要谎称已取消。',
              details: { workOrderId },
            });
          }

          logger.log(
            `取消工单成功: chatId=${chatId}, workOrderId=${workOrderId}, cancelReasonId=${matched.id}`,
          );

          // 运营事件底账：booking.canceled。幂等键用 workOrderId（一张工单仅取消一次，Bull 重试去重）。
          void opsEventsRecorder.recordEvent({
            corpId: context.corpId,
            eventName: 'booking.canceled',
            idempotencyKey: `${workOrderId}:canceled`,
            botImId: context.botImId,
            managerName: context.botUserId,
            userId: context.userId,
            chatId: context.sessionId,
            payload: {
              work_order_id: workOrderId,
              cancel_reason_id: matched.id,
              cancel_reason: matched.info || null,
              cancel_reason_desc: cancelReasonDesc?.trim() || null,
              candidate_name: normalizeOptionalText(candidateName),
              phone: normalizeOptionalText(phone),
              brand_name: normalizeOptionalText(brandName),
              store_name: normalizeOptionalText(storeName),
              job_name: normalizeOptionalText(jobName),
              interview_time: normalizeOptionalText(interviewTime),
            },
          });

          await longTermService.clearActiveBooking(context.corpId, context.userId, workOrderId);

          void sendCancelWorkOrderNotification({
            privateChatNotifier,
            context,
            workOrderId,
            cancelReasonId: matched.id,
            cancelReason: matched.info,
            cancelReasonDesc,
            candidateName,
            phone,
            brandName,
            storeName,
            jobName,
            interviewTime,
          });

          return {
            success: true,
            errorType: null,
            workOrderId,
            cancelReasonId: matched.id,
            _outcome: '取消成功，可以告知候选人面试预约已取消',
            _replyInstruction:
              '已成功取消该面试预约。请以真人招募者口吻向候选人确认"已经帮你取消这次面试预约了"，并自然衔接（如询问是否需要重新推荐/另约）。不要提及工单/接口/系统等字眼。',
          };
        } catch (err) {
          logger.error(
            `取消工单异常: chatId=${chatId}, workOrderId=${workOrderId}`,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.CANCEL_REQUEST_FAILED,
            outcome: '取消工单异常',
            replyInstruction:
              '取消未成功。请以真人招募者口吻一句话安抚衔接，并按 request_handoff（reasonCode=modify_appointment）转人工；不要透露接口报错/技术细节，不要谎称已取消。',
            details: {
              workOrderId,
              reason: err instanceof Error ? err.message : '未知错误',
            },
          });
        }
      },
    });
  };
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function extractLatestUserMessage(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;

    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user') continue;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

async function sendCancelWorkOrderNotification(params: {
  privateChatNotifier: PrivateChatMonitorNotifierService;
  context: Parameters<ToolBuilder>[0];
  workOrderId: number;
  cancelReasonId: number;
  cancelReason?: string;
  cancelReasonDesc?: string;
  candidateName?: string;
  phone?: string;
  brandName?: string;
  storeName?: string;
  jobName?: string;
  interviewTime?: string;
}): Promise<void> {
  const { privateChatNotifier, context } = params;
  try {
    await privateChatNotifier.notifyInterviewCancellation({
      botImId: context.botImId,
      contactName: normalizeOptionalText(context.contactName) ?? undefined,
      candidateName: normalizeOptionalText(params.candidateName) ?? undefined,
      phone: normalizeOptionalText(params.phone) ?? undefined,
      botUserName: normalizeOptionalText(context.botUserId) ?? undefined,
      brandName: normalizeOptionalText(params.brandName) ?? undefined,
      storeName: normalizeOptionalText(params.storeName) ?? undefined,
      jobName: normalizeOptionalText(params.jobName) ?? undefined,
      interviewTime: normalizeOptionalText(params.interviewTime) ?? undefined,
      workOrderId: params.workOrderId,
      cancelReason: normalizeOptionalText(params.cancelReason) ?? undefined,
      cancelReasonDesc: normalizeOptionalText(params.cancelReasonDesc) ?? undefined,
      userMessage: normalizeOptionalText(extractLatestUserMessage(context.messages)) ?? undefined,
    });
  } catch (error) {
    logger.error(
      `取消工单通知发送异常: workOrderId=${params.workOrderId}, error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
