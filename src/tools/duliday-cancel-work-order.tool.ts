/**
 * DuLiDay 取消工单工具
 *
 * 候选人主动要求取消已确认的面试预约时，自助调海绵取消工单接口完成取消。
 * 取消原因取自海绵失败原因字典（父级 pid 12001），由 LLM 据候选人原话挑选 cancelReasonId。
 * 自助优先：字典/接口失败时回执自带转人工副作用（modify_appointment + 工单号/岗位/失败原因），
 * 模型只需如实告知已转同事；无工单号时仍回退 request_handoff(modify_appointment)。
 */

import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';
import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { type FailureReasonItem } from '@sponge/sponge.types';
import { buildSpongeTokenContext } from '@tools/shared/sponge-token-context.util';
import { isTestPiiPhoneAllowed, maskPhoneForDetails } from '@tools/shared/test-pii-gate';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import type { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import {
  bookingEventSource,
  findSnapshotWorkOrder,
  resolveBookingOwnership,
} from '@tools/booking/booking-ownership.util';
import {
  buildToolFailureHandoffSideEffect,
  buildToolFailureReplyInstruction,
} from '@tools/shared/tool-failure-handoff.util';

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
2. 候选人在**面试开始之前**明确放弃这次已约的面试/岗位——**不需要候选人说出"取消"二字**。直接要求取消或明确拒绝已约岗位要求、表示无法或不愿继续该岗位，都属于放弃。候选人放弃后即使下一步是拉群维护或改推其它岗位，也必须先取消该工单。
   ⚠️ **时点是硬前提**：上述"明确放弃"只在面试时间尚未到达时才适用。面试时间已到/已过之后候选人才说没去，属爽约，见下方「不要调用的场景」，禁止取消
3. 仅取消、不另约新时间。若候选人是要"改时间/换一天"，用 duliday_modify_interview_time，不要先取消

## 为什么面试前放弃就必须取消
工单**不会**因候选人口头放弃而自动失效：不取消的话门店会照常备面等人、候选人留下爽约记录、人工还要跟单。**禁止**以"工单会自动失效"、"后续会有人工处理"为由跳过取消。
本节只适用于**面试开始之前**；面试时点已过后的"没去"是爽约，此时取消反而是错的（见「不要调用的场景」）。

## 取消原因（两步法）
- 取消必须带一个 cancelReasonId（取消原因 ID），它来自海绵失败原因字典
- **第一步**：不传 cancelReasonId 调用本工具，工具会返回 availableReasons（可选取消原因列表：id + 描述）
- **第二步**：从 availableReasons 里**按候选人原话**挑出最贴切的一项，把其 id 作为 cancelReasonId 再次调用本工具完成取消
- cancelReasonDesc 可选：结合候选人原话补一句具体描述

## 不要调用的场景
- 候选人只是询问预约状态/时间/门店 → 直接基于 [当前预约信息] 回答
- 候选人拒绝的是**尚未约面的新推荐岗位**（拒绝指向本轮推荐、不是 [当前预约信息] 里已约的岗位）→ 不要取消已约工单，只按推荐流程继续
- 候选人只是犹豫或表达距离、薪资等顾虑，但没有明确放弃 → 先沟通，不要抢跑取消
- **约定面试时间已经到了/过了，候选人才说"没有去/不去了"→ 这是爽约不是取消**：过时未到属门店与人工跟单处理的爽约事件，不要再调本工具取消工单；只承接候选人（问下原因/是否还想找），有继续找工意向就按新流程推进。取消只服务于**面试开始前**的主动放弃。
- 没有 [当前预约信息] 或拿不到工单号 → 不要调用本工具。但**系统没有工单 ≠ 候选人没有预约**：若对话里有真人经理手动发出的预约确认（带手动发送标记），或候选人明确指认某个具体日期/门店的已约面试要取消，说明预约是真人带外约的、系统查不到——此时**必须**调用 request_handoff(reasonCode="modify_appointment") 交人工取消，**严禁**据此否认预约、宣称预约未提交成功或断言无需取消。只有对话里也没有任何预约痕迹时，才按首次约面流程处理
- 候选人说已被门店面试通过/餐厅自招/办入职/已上岗等 → 走 request_handoff

## 参数
- workOrderId：必填，取自 [当前预约信息] 的「工单号」
- cancelReasonId：第二步必填，取自第一步返回的 availableReasons
- cancelReasonDesc：可选，结合候选人原话简述取消原因
- candidateName / phone / brandName / storeName / jobName / interviewTime：可选；若 [当前预约信息] 中有这些字段，尽量原样带上，用于取消通知提醒人工判断是否需要通知门店

## 成功/失败处理硬规则
- **只有当本工具返回 success 后**，才能向候选人确认取消成功
- 失败时按 _replyInstruction 行动：接口/字典失败的回执已自带转人工（本轮不要再调 request_handoff），你只需如实告诉候选人这次取消暂时处理不了、已转同事跟进；不要原样复读报错、不要透露接口细节、不要谎称已取消
- 工具执行前有一道确定性核验，被拦时严格按返回的 _replyInstruction 行动：工单号必须在候选人当前有效预约集合内——不在则说明引用了记忆残留/不存在的预约，不可取消
- 工单在海绵里的状态字段不参与取消判断（该字段滞后不可信）；候选人面试前明确放弃就取消，面试已开始/已过才说放弃属于爽约，按 [当前预约信息] 的共享规则处理`;

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
export interface CancelWorkOrderToolDeps {
  /** 取消成功后失效该手机号的预约快照缓存（否则 5 分钟内仍显示在途）。 */
  bookingSnapshot?: Pick<BookingSnapshotService, 'invalidate'>;
}

export function buildCancelWorkOrderTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
  longTermService: LongTermService,
  privateChatNotifier: PrivateChatMonitorNotifierService,
  deps?: CancelWorkOrderToolDeps,
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
        const chatId = context.session.chatId ?? context.session.sessionId;

        // 测试链路 PII 白名单闸门：cancel 真调海绵生产网关，测试重放只允许
        // 假身份工单，与 booking 共用同一条生产写入防线。
        if (context.runtime.strategySource === 'testing' && !isTestPiiPhoneAllowed(phone)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.TEST_LINK_REAL_PII_BLOCKED,
            outcome: '测试链路拦截：手机号不在测试白名单，未执行真实取消',
            replyInstruction:
              '当前为测试链路且候选人手机号不是测试假身份，本工具已拒绝执行、未触达真实工单。' +
              '不得谎称已取消；请如实说明未执行。测试用例应使用统一假身份（兮兮/18271421690）。',
            details: { phone: maskPhoneForDetails(phone), workOrderId },
          });
        }

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.CANCEL_MISSING_WORK_ORDER_ID,
            outcome: '缺少有效工单号，无法取消',
            replyInstruction:
              '当前拿不到有效的工单号，无法自助取消。请按 request_handoff（reasonCode=modify_appointment）转人工处理，不要谎称已取消。',
          });
        }

        const tokenContext = buildSpongeTokenContext(context);

        // B5-1 工单归属核验：workOrderId 必须在候选人当前有效预约里——active_booking 指针，
        // 或本轮预约快照中通过本人校验的工单（含真人后台建的带外单：查得到就是操作得了的）。
        // 记忆污染/示例回声可能让模型引用根本不存在或不属于本人的"预约"（
        // Agent 声称取消一个臆造的上海预约），取消是不可逆动作，必须锚定真实工单证据。
        const snapshotRef = findSnapshotWorkOrder(context.archive.bookingWorkOrders, workOrderId);
        try {
          const activeBookings = await longTermService.getActiveBookings(
            context.session.corpId,
            context.session.userId,
          );
          const ownedWorkOrderIds = activeBookings.map((b) => b.work_order_id);
          const ownership = resolveBookingOwnership({
            workOrderId,
            pointerWorkOrderIds: ownedWorkOrderIds,
            snapshotRefs: context.archive.bookingWorkOrders,
          });
          if (ownership.owned === false) {
            logger.warn(
              `取消拦截（工单不属于候选人当前预约，${ownership.reason}）: chatId=${chatId}, workOrderId=${workOrderId}, owned=[${ownedWorkOrderIds.join(',')}]`,
            );
            const identityMismatch = ownership.reason === 'identity_mismatch';
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.CANCEL_WORK_ORDER_NOT_OWNED,
              outcome: identityMismatch
                ? '取消拦截（工单登记姓名与候选人自报姓名不一致）'
                : '取消拦截（工单号不在候选人当前有效预约中）',
              replyInstruction: identityMismatch
                ? '该工单登记的候选人姓名与本会话候选人自报姓名不一致，禁止自助取消。请调 request_handoff(reasonCode="modify_appointment") 交人工核实后取消，不得否认已有预约或断言无需取消，也不要提及工单/系统。'
                : '该工单号不在候选人当前有效预约中，禁止取消——它可能来自记忆残留或误引用。' +
                  '请基于 [当前预约信息] 里真实存在的「工单号」重新确认候选人要取消哪一个预约；' +
                  '若 [当前预约信息] 为空：对话里有真人经理手动发出的预约确认或候选人指认的具体已约面试时，改调 request_handoff(reasonCode="modify_appointment") 交人工取消，不得否认已有预约或断言无需取消；确实没有任何预约痕迹时才向候选人自然说明，不要提及工单/系统。',
              details: { workOrderId, ownedWorkOrderIds, ownershipReason: ownership.reason },
            });
          }
        } catch (err) {
          // 归属核验依赖本地 long-term 存储，读失败时降级放行（保持原有可取消能力），只记警告。
          logger.warn(
            `取消前归属核验读取失败（降级放行）: chatId=${chatId}, workOrderId=${workOrderId}, error=${toErrorMessage(
              err,
            )}`,
          );
        }

        // 工单状态不参与取消判断：海绵 currentStatus / interviewPassTime 由运营手工维护、严重滞后
        // （2026-09-16 运营裁定；此前按「面试成功/上岗…」拦截自助取消的 B5-2 已拆除）。

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
            toErrorStack(err),
          );
          return buildCancelFailure({
            context,
            workOrderId,
            errorType: TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED,
            outcome: '取消原因字典拉取失败',
            failureReason: toErrorMessage(err) || '未知错误',
            details: { workOrderId, reason: toErrorMessage(err) || '未知错误' },
          });
        }

        if (reasons.length === 0) {
          logger.warn(
            `取消原因字典为空: chatId=${chatId}, workOrderId=${workOrderId}, pid=${CANCEL_REASON_PID}`,
          );
          return buildCancelFailure({
            context,
            workOrderId,
            errorType: TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED,
            outcome: '取消原因字典为空',
            failureReason: '取消原因字典为空',
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
            return buildCancelFailure({
              context,
              workOrderId,
              errorType: TOOL_ERROR_TYPES.CANCEL_REJECTED,
              outcome: '取消工单失败',
              failureReason: result.message ?? `海绵返回 code=${result.code}`,
              // apiCode/apiMessage 透传海绵后端的拒绝原因，仅供观测落库（dashboard 直接可见，无需翻 Winston 日志）；
              // _replyInstruction 已禁止 LLM 把这些细节复读给候选人。
              details: { workOrderId, apiCode: result.code, apiMessage: result.message ?? null },
            });
          }

          logger.log(
            `取消工单成功: chatId=${chatId}, workOrderId=${workOrderId}, cancelReasonId=${matched.id}`,
          );

          // 运营事件底账：booking.canceled。幂等键用 workOrderId（一张工单仅取消一次，Bull 重试去重）。
          void opsEventsRecorder.recordEvent({
            corpId: context.session.corpId,
            eventName: 'booking.canceled',
            idempotencyKey: `${workOrderId}:canceled`,
            botImId: context.session.botImId,
            managerName: context.session.botUserId,
            userId: context.session.userId,
            chatId: context.session.sessionId,
            payload: {
              work_order_id: workOrderId,
              // 带外工单（供应商后台建单）的后续取消按来源单列统计。
              source: bookingEventSource(snapshotRef),
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

          await longTermService.clearActiveBooking(
            context.session.corpId,
            context.session.userId,
            workOrderId,
          );
          // 预约快照按手机号缓存 5 分钟；不失效会让刚取消的工单在后续回合仍显示在途。
          await deps?.bookingSnapshot?.invalidate({
            phone:
              normalizeOptionalText(phone) ??
              context.archive.bookingCandidateFacts?.phone ??
              context.archive.profile?.phone ??
              null,
            botImId: context.session.botImId,
            corpId: context.session.corpId,
            userId: context.session.userId,
          });

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
              '已成功取消该面试预约。请以真人招募者口吻向候选人确认取消成功，再按候选人当前诉求自然衔接；只要求取消或已结束求职时直接收口，不强制追问是否重新推荐或另约。不要提及工单/接口/系统等字眼。',
          };
        } catch (err) {
          logger.error(
            `取消工单异常: chatId=${chatId}, workOrderId=${workOrderId}`,
            toErrorStack(err),
          );
          return buildCancelFailure({
            context,
            workOrderId,
            errorType: TOOL_ERROR_TYPES.CANCEL_REQUEST_FAILED,
            outcome: '取消工单异常',
            failureReason: toErrorMessage(err) || '未知错误',
            details: {
              workOrderId,
              reason: toErrorMessage(err) || '未知错误',
            },
          });
        }
      },
    });
  };
}

/**
 * 自助取消失败的统一回执：工具错误 + 自带转人工副作用（由 outcome 统一出口在回复投递后
 * 落底账/暂停/告警），模型只需如实告知候选人已转同事，不再要求调 request_handoff。
 */
function buildCancelFailure(params: {
  context: Parameters<ToolBuilder>[0];
  workOrderId: number;
  errorType:
    | typeof TOOL_ERROR_TYPES.CANCEL_REASON_FETCH_FAILED
    | typeof TOOL_ERROR_TYPES.CANCEL_REJECTED
    | typeof TOOL_ERROR_TYPES.CANCEL_REQUEST_FAILED;
  outcome: string;
  failureReason: string;
  details: Record<string, unknown>;
}) {
  return {
    ...buildToolError({
      errorType: params.errorType,
      outcome: params.outcome,
      replyInstruction: buildToolFailureReplyInstruction('取消'),
      details: params.details,
    }),
    sideEffect: buildToolFailureHandoffSideEffect({
      context: params.context,
      action: '取消',
      workOrderId: params.workOrderId,
      errorType: params.errorType,
      failureReason: params.failureReason,
    }),
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
      botImId: context.session.botImId,
      contactName: normalizeOptionalText(context.session.contactName) ?? undefined,
      candidateName: normalizeOptionalText(params.candidateName) ?? undefined,
      phone: normalizeOptionalText(params.phone) ?? undefined,
      botUserName: normalizeOptionalText(context.session.botUserId) ?? undefined,
      brandName: normalizeOptionalText(params.brandName) ?? undefined,
      storeName: normalizeOptionalText(params.storeName) ?? undefined,
      jobName: normalizeOptionalText(params.jobName) ?? undefined,
      interviewTime: normalizeOptionalText(params.interviewTime) ?? undefined,
      workOrderId: params.workOrderId,
      cancelReason: normalizeOptionalText(params.cancelReason) ?? undefined,
      cancelReasonDesc: normalizeOptionalText(params.cancelReasonDesc) ?? undefined,
      userMessage:
        normalizeOptionalText(extractLatestUserMessage(context.turnInput.messages)) ?? undefined,
    });
  } catch (error) {
    logger.error(
      `取消工单通知发送异常: workOrderId=${params.workOrderId}, error=${toErrorMessage(error)}`,
    );
  }
}
