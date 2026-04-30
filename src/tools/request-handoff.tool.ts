import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { SessionService } from '@memory/services/session.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { InterventionService } from '@biz/intervention/intervention.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { extractLatestUserMessage } from './utils/chat-history.util';

const logger = new Logger('request_handoff');

const HANDOFF_REASON_LABELS: Record<string, string> = {
  cannot_find_store: '找不到门店',
  no_reception: '到店无人接待',
  booking_conflict: '预约信息冲突',
  onboarding_paperwork: '入职办理异常',
  interview_result_inquiry: '候选人追问面试结果',
  modify_appointment: '候选人要求改期/取消已预约面试',
  self_recruited_or_completed: '候选人已被面试通过/餐厅自招/办入职',
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
  recruitmentCaseService: RecruitmentCaseService,
  chatSessionService: ChatSessionService,
  sessionService: SessionService,
  userHostingService: UserHostingService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: `面试/入职跟进阶段遇到需人工处理的场景时调用。**调用即短路本轮——runtime 会自动结束本轮，候选人本次不会收到任何回复**，副作用（暂停托管 / 飞书告警 / case 状态变更）全部异步执行。

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
6. modify_appointment：候选人要求改时间/取消/重排已预约的面试，例如"能不能改到明天"、"约的那天我去不了"、"想取消之前的预约"
7. self_recruited_or_completed：候选人称已被该门店面试通过/已经在该门店上班/餐厅自招/办入职/上岗/试工/试做，例如"我已经在 X 店干过了"、"是店长让我来的"、"我们餐厅找的我"、"现在来办入职"、"要先离职吗"、"明天去 X 店试工"、"明天试做一下"、"今天上岗"、"已经面试过了/通过了"。**关键词触发**：候选人消息中出现"试工 / 试做 / 上岗 / 入职 / 已面试过 / 已通过"等明确信号时，即使没有"店长"等其他线索，也必须按本场景调用本工具，不得当作普通新候选人继续约面或登记
8. other：明显需要人工介入但不属于以上七类的面试/入职阶段阻塞
- 候选人出现银行卡/税务/发薪主体特殊情况需要确认，也按 other 处理；不要重新推荐、重新收资或重新预约

## 何时不调用
- 如果候选人只是常规询问门店位置/路线，先用 send_store_location 处理，不要直接转人工

## 执行效果
- runtime 立即结束本轮 loop，候选人本次不会收到任何回复
- 异步执行「暂停托管 + case 状态改为 handoff + 飞书告警」

## 参数
- reasonCode：八个枚举之一
- reason：结合候选人原话描述阻塞点
- summary（可选）：一句话概括当前信息状态

## 硬规则
- 调用本工具后，**禁止再生成任何对外文本**，也不得继续调用其它工具
- 严禁在本轮继续推进其他任务（换岗位、改约时间、收资料等）`,
      inputSchema: z.object({
        reasonCode: z
          .enum([
            'cannot_find_store',
            'no_reception',
            'booking_conflict',
            'onboarding_paperwork',
            'interview_result_inquiry',
            'modify_appointment',
            'self_recruited_or_completed',
            'other',
          ])
          .describe('转人工原因代码'),
        reason: z.string().describe('具体原因：结合候选人原话说明当前阻塞点'),
        summary: z.string().optional().describe('情况摘要：1 句话描述已收集的关键信息'),
      }),
      execute: async ({ reasonCode, reason, summary }) => {
        const chatId = context.chatId ?? context.sessionId;
        const pauseTargetId = chatId || context.imContactId || context.userId;

        if (!chatId) {
          return { dispatched: false, error: 'missing_chat_id' };
        }

        const activeCase = await recruitmentCaseService.getActiveOnboardFollowupCase({
          corpId: context.corpId,
          chatId,
        });

        if (!activeCase) {
          logger.warn(
            `request_handoff 无 active case: chatId=${chatId}, code=${reasonCode}; 仍异步暂停托管以避免继续对话`,
          );
          void userHostingService.pauseUser(pauseTargetId).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`request_handoff 异步暂停托管失败: chatId=${chatId}, ${message}`);
          });
          return {
            dispatched: false,
            shortCircuited: true,
            error: 'no_active_case',
            instruction:
              '本轮 runtime 已自动结束，托管已异步暂停。禁止再生成任何文本或调用其他工具。',
          };
        }

        const [recentMessages, sessionState] = await Promise.all([
          chatSessionService.getChatHistory(chatId, 10).catch(() => []),
          sessionService
            .getSessionState(context.corpId, context.userId, context.sessionId)
            .catch(() => null),
        ]);

        void interventionService
          .dispatch({
            kind: 'onboard_handoff',
            source: 'agent_tool',
            caseId: activeCase.id,
            alertLabel: HANDOFF_REASON_LABELS[reasonCode] ?? '面试/入职异常',
            reason: reason?.trim() || HANDOFF_REASON_LABELS[reasonCode] || '需要人工协助',
            summary: summary?.trim(),
            chatId,
            corpId: context.corpId,
            userId: context.userId,
            pauseTargetId,
            botImId: context.botImId ?? activeCase.bot_im_id ?? undefined,
            botUserName: context.botUserId,
            contactName: context.contactName,
            currentMessageContent: extractLatestUserMessage(recentMessages),
            recentMessages: recentMessages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: m.timestamp,
            })),
            sessionState,
            recruitmentCase: activeCase,
          })
          .then((result) => {
            logger.warn(
              `request_handoff dispatched: chatId=${chatId}, caseId=${activeCase.id}, code=${reasonCode}, paused=${result.paused}, alerted=${result.alerted}, suppressed=${result.suppressed ?? '-'}`,
            );
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              `request_handoff dispatch 异步执行失败: chatId=${chatId}, caseId=${activeCase.id}, ${message}`,
            );
          });

        return {
          dispatched: true,
          shortCircuited: true,
          caseId: activeCase.id,
          instruction:
            '本轮 runtime 已自动结束，托管将异步暂停，飞书人工告警将异步发送。禁止再生成任何文本或调用其他工具。',
        };
      },
    });
  };
}
