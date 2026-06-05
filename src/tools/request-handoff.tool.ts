import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SessionService } from '@memory/services/session.service';
import { LongTermService } from '@memory/services/long-term.service';
import { InterventionService } from '@biz/intervention/intervention.service';
import { HandoffRecorderService } from '@biz/handoff-events/handoff-recorder.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { extractLatestUserMessage } from './utils/chat-history.util';

const logger = new Logger('request_handoff');

const DESCRIPTION = `面试/入职跟进阶段遇到需人工处理的场景时调用。**调用即短路本轮——runtime 会自动结束本轮，候选人本次不会收到任何回复**，副作用（暂停托管 / 飞书告警 / case 状态变更）全部异步执行。

## 前置条件
- [当前预约信息] 存在时必须调用，本工具会异步暂停托管并发送人工介入告警
- 若对话文本已明确出现已预约、改期/取消、已面试、面试通过、店长已联系、只能一家店、报到/培训/办入职等状态，即使 [当前预约信息] 缺失也必须调用；本轮仍会沉默，托管会被异步关闭
- 若候选人说明银行卡异常、被起诉、房贷断供、不能用本人卡收薪，或追问税务/发薪主体导致你无法确认岗位规则，也调用本工具，本轮沉默并由人工跟进

## 触发场景（出现任一即调用）
1. cannot_find_store：候选人反馈找不到门店、导航错、门店地址错等定位问题，且 send_store_location 仍无法解决
2. no_reception：候选人到店后联系不上负责人、店长不在、无人接待、电话打不通
3. booking_conflict：门店反馈查不到预约、与系统记录冲突、现场说没有你预约的岗位
4. onboarding_paperwork：候选人进入入职/上岗对接、办理手续、报到流程等你无法处理的环节
5. interview_result_inquiry：候选人主动追问面试结果/是否通过/录取通知，例如"我刚刚面试过了通过了吗"、"店长说让我等通知"、"今天面完了什么时候有结果"
6. modify_appointment：候选人**主动**要求改时间/取消/重排**已确认的**面试，例如"能不能改到明天"、"约的那天我去不了"、"想取消之前的预约"
   - 反面（不调用）：招募经理上一条刚抛出多个候选时段让候选人挑（如"明天 10-16 / 后天 10-16 / 下周一 10-16，你看哪天方便"），候选人回单个时段（"明天"/"周一"/"后天上午"）属于首次约面，是 booking 流程而非改期
   - 反面（不调用）：系统里有 active case 但其 interview_time 已过去（早于今天），属于 stale 数据，不要据此推断候选人"改期"
7. self_recruited_or_completed：候选人称已被该门店面试通过/已经在该门店上班/餐厅自招/办入职/上岗/试工/试做，例如"我已经在 X 店干过了"、"是店长让我来的"、"我们餐厅找的我"、"现在来办入职"、"要先离职吗"、"明天去 X 店试工"、"明天试做一下"、"今天上岗"、"已经面试过了/通过了"。**关键词触发**：候选人消息中出现"试工 / 试做 / 上岗 / 入职 / 已面试过 / 已通过"等明确信号时，即使没有"店长"等其他线索，也必须按本场景调用本工具，不得当作普通新候选人继续约面或登记
8. no_match_or_group_full：放宽品牌/区域重查后仍无匹配岗位，且对应兼职群已满或该城市无兼职群、无法自助拉群维护，需人工跟进维护拉群 / 跨城跨区推荐。**这是最常见的兜底场景**：当你已用 duliday_job_list 去掉品牌限制、保留硬约束重查仍无岗，且 invite_to_group 返回群满 / 无群时，按本码转人工，不要再笼统归为 other
9. system_blocked：precheck / booking / invite_to_group 等工具返回结构性错误导致无法自助推进（如 precheck 持续 missingFields 卡住 booking、booking 返回 BOOKING_REJECTED、拉群接口 errcode 异常 / bot 不在群），属于系统/工具卡死而非候选人原因，需人工补录或修复
10. other：明显需人工介入、且确实不属于以上九类的面试/入职阶段阻塞（真正的兜底，能归类就不要用 other）
- 候选人出现银行卡/税务/发薪主体特殊情况需要确认，也按 other 处理；不要重新推荐、重新收资或重新预约

## 何时不调用
- 如果候选人只是常规询问门店位置/路线，先用 send_store_location 处理，不要直接转人工
- 如果只是你上一轮主动推荐的岗位在收资后发现年龄/性别/班次/学历等硬条件不匹配，且候选人没有已确认预约、入职办理、门店异常、风险投诉等人工阻塞，不要直接调用本工具。先说明当前岗位不匹配，再用 duliday_job_list 去掉原品牌限制、保留候选人的位置/年龄/身份/时间窗等硬约束重查可匹配替代岗位；查后确实没有自助推进路径时，才按 invite_to_group 或本工具兜底（此时转人工用 reasonCode="no_match_or_group_full"，不要用 other）。

## 执行效果
- runtime 立即结束本轮 loop，候选人本次不会收到任何回复
- 异步执行「暂停托管 + case 状态改为 handoff + 飞书告警」

## 参数
- reasonCode：十个枚举之一
- reason：结合候选人原话描述阻塞点
- actionAdvice（可选）：建议下一步动作（一句话），帮招募经理直接看到"该做什么"，例如"协调周末面试"、"联系门店确认到岗安排"、"引导改岗到 X 品牌"

## 硬规则
- 调用本工具后，**禁止再生成任何对外文本**，也不得继续调用其它工具
- 严禁在本轮继续推进其他任务（换岗位、改约时间、收资料等）`;

const inputSchema = z.object({
  reasonCode: z
    .enum([
      'cannot_find_store',
      'no_reception',
      'booking_conflict',
      'onboarding_paperwork',
      'interview_result_inquiry',
      'modify_appointment',
      'self_recruited_or_completed',
      'no_match_or_group_full',
      'system_blocked',
      'other',
    ])
    .describe('转人工原因代码'),
  reason: z.string().describe('具体原因：结合候选人原话说明当前阻塞点'),
  actionAdvice: z
    .string()
    .optional()
    .describe(
      '建议动作：1 句话给招募经理一个明确的下一步动作（如：协调周末面试 / 联系门店确认到岗安排 / 引导改岗到 X 品牌）',
    ),
});

const HANDOFF_REASON_LABELS: Record<string, string> = {
  cannot_find_store: '找不到门店',
  no_reception: '到店无人接待',
  booking_conflict: '预约信息冲突',
  onboarding_paperwork: '入职办理异常',
  interview_result_inquiry: '候选人追问面试结果',
  modify_appointment: '候选人要求改期/取消已预约面试',
  self_recruited_or_completed: '候选人已被面试通过/餐厅自招/办入职',
  no_match_or_group_full: '无匹配岗位/群满需维护',
  system_blocked: '工具/系统卡死无法自助',
  other: '其他需人工处理场景',
};

/**
 * request_handoff 工具
 *
 * 当 Agent 判断候选人已进入「面试/入职跟进阶段」或出现明显需要人工确认的
 * 预约/改期/入职阻塞时调用。
 *
 * 行为约定（与 skip_reply 同属「短路工具」）：
 * - 调用即由 runtime 立即结束本轮 loop，本轮不再生成任何对外回复
 * - 副作用全部 fire-and-forget：异步暂停托管 + 异步飞书告警 + 异步 case 状态变更
 * - 即便没有 active case，也会异步暂停托管，避免 Agent 继续与候选人对话
 *
 * Agent 调用前不要再尝试组织安抚/收口话术——本轮就是沉默。
 */
export function buildRequestHandoffTool(
  interventionService: InterventionService,
  chatSessionService: ChatSessionService,
  sessionService: SessionService,
  longTermService: LongTermService,
  handoffRecorder: HandoffRecorderService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ reasonCode, reason, actionAdvice }) => {
        const chatId = context.chatId ?? context.sessionId;
        const pauseTargetId = chatId || context.imContactId || context.userId;

        if (!chatId) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MISSING_CHAT_ID,
            outcome: '缺少 chatId，无法转人工',
            replyInstruction:
              '当前调用缺少 chatId 上下文，本轮不要再调用其他工具；这是结构性问题，无法通过对话恢复。',
            successField: 'dispatched',
          });
        }

        const latestBooking = await longTermService
          .getLatestBooking(context.corpId, context.userId)
          .catch(() => null);
        const workOrderId = latestBooking?.latest_work_order_id ?? null;

        // 守卫：候选人要求"改期/取消"但根本没有已确认预约 → 这其实是首次约面意向。
        // 返回 shortCircuited:false（不短路），让 runtime 继续、Agent 按首次约面流程推进。
        if (reasonCode === 'modify_appointment' && workOrderId == null) {
          logger.log(
            `request_handoff(modify_appointment) 但无 latest_booking，按首次约面继续: chatId=${chatId}`,
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.HANDOFF_NO_BOOKING,
            outcome: '候选人尚无已确认预约，不应作为改期转人工',
            replyInstruction:
              '候选人尚无已确认的面试预约，这其实是首次约面意向。请按首次约面流程继续：调 duliday_interview_precheck 校验并推进预约，不要转人工，也不要说"帮你改期/取消"。',
            details: { shortCircuited: false },
          });
        }

        // botImId 缺失时，飞书告警无法 @ 到对应招募负责人（recruitment_cases 废弃后已无 case.bot_im_id
        // 可兜底）。正常生产链路 botImId 必有值；这里显式告警，让漏 @ 的边缘场景可观测、可排查。
        if (!context.botImId) {
          logger.warn(
            `request_handoff 缺少 botImId，飞书告警将无法 @ 招募负责人: chatId=${chatId}, code=${reasonCode}`,
          );
        }

        // 转人工底账 + handoff.triggered 事件（两者共用幂等键）。fire-and-forget。
        // 幂等键用本轮稳定 turnId 而非 occurredAt.getTime()：handoff 会短路本轮 → 一轮至多一次 handoff，
        // 故 Bull 重试 / 进程在副作用后、消息去重前崩溃重跑时，同一逻辑 handoff 仍得到同一 key，
        // 不会重复写 handoff_events 与 daily_ops_report.handoff_count。turnId 缺省（test/debug）回退时间戳。
        const occurredAt = new Date();
        const handoffIdempotencyKey = `${chatId}:handoff:${context.turnId ?? occurredAt.getTime()}`;
        void handoffRecorder
          .record({
            corpId: context.corpId,
            chatId,
            userId: context.userId,
            reasonCode,
            reason: reason?.trim() || null,
            actionAdvice: actionAdvice?.trim() || null,
            stage: context.currentStage ?? null,
            botImId: context.botImId,
            workOrderId,
            idempotencyKey: handoffIdempotencyKey,
            occurredAt,
          })
          .catch((err: unknown) => {
            logger.warn(
              `记录 handoff 事件失败: chatId=${chatId}, ${err instanceof Error ? err.message : String(err)}`,
            );
          });

        const [recentMessages, sessionState] = await Promise.all([
          chatSessionService.getChatHistory(chatId, 10).catch(() => []),
          sessionService
            .getSessionState(context.corpId, context.userId, context.sessionId)
            .catch(() => null),
        ]);

        // recruitment_cases 已废弃：handoff 统一走 general_handoff（暂停托管 + 飞书告警），
        // 不再区分 onboard/general。触发分析价值沉到 handoff_events + ops_events.handoff.triggered。
        void interventionService
          .dispatch({
            kind: 'general_handoff',
            source: 'agent_tool',
            alertLabel: HANDOFF_REASON_LABELS[reasonCode] ?? '需人工跟进',
            reason: reason?.trim() || HANDOFF_REASON_LABELS[reasonCode] || '需要人工协助',
            actionAdvice: actionAdvice?.trim(),
            chatId,
            corpId: context.corpId,
            userId: context.userId,
            pauseTargetId,
            botImId: context.botImId,
            botUserName: context.botUserId,
            contactName: context.contactName,
            currentMessageContent: extractLatestUserMessage(recentMessages),
            recentMessages: recentMessages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: m.timestamp,
            })),
            sessionState,
          })
          .then((result) => {
            logger.warn(
              `request_handoff dispatched: chatId=${chatId}, code=${reasonCode}, paused=${result.paused}, alerted=${result.alerted}, suppressed=${result.suppressed ?? '-'}`,
            );
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`request_handoff dispatch 异步执行失败: chatId=${chatId}, ${message}`);
          });

        return {
          dispatched: true,
          shortCircuited: true,
          instruction:
            '本轮 runtime 已自动结束，托管将异步暂停，飞书人工告警将异步发送。禁止再生成任何文本或调用其他工具。',
        };
      },
    });
  };
}
