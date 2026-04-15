import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { SessionService } from '@memory/services/session.service';
import { InterventionService } from '@notification/intervention/intervention.service';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('request_handoff');

const HANDOFF_REASON_LABELS: Record<string, string> = {
  cannot_find_store: '找不到门店',
  no_reception: '到店无人接待',
  booking_conflict: '预约信息冲突',
  onboarding_paperwork: '入职办理异常',
  other: '其他需人工处理场景',
};

/**
 * request_handoff 工具
 *
 * 当 Agent 判断候选人已进入「面试/入职跟进阶段」且出现需要人工介入的场景时调用。
 *
 * 前置条件：
 * - 会话存在 active 状态的 onboard_followup case（通过系统提示里的 [当前预约信息] 感知）
 *
 * 本工具仅触发副作用：暂停托管 + case 状态变更为 handoff + 飞书告警。
 * 转接话术由 Agent 以招募者身份自然组织，禁止使用“机器人/托管/系统”等字眼。
 */
export function buildRequestHandoffTool(
  interventionService: InterventionService,
  recruitmentCaseService: RecruitmentCaseService,
  chatSessionService: ChatSessionService,
  sessionService: SessionService,
): ToolBuilder {
  return (context) => {
    return tool({
      description:
        '面试/入职跟进阶段遇到需人工处理的场景（找不到门店、到店无人接待、预约冲突、办理入职等）时调用，同步触发人工介入。调用后请以招募者身份自然地告诉候选人“我让同事跟进一下”之类的衔接话，不要暴露机器人/托管/系统。',
      inputSchema: z.object({
        reasonCode: z
          .enum([
            'cannot_find_store',
            'no_reception',
            'booking_conflict',
            'onboarding_paperwork',
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
          logger.warn(`request_handoff 无 active case: chatId=${chatId}`);
          return {
            dispatched: false,
            error: 'no_active_case',
            instruction: '当前会话不存在可转接的 onboard_followup case；请继续按常规流程处理。',
          };
        }

        const [recentMessages, sessionState] = await Promise.all([
          chatSessionService.getChatHistory(chatId, 10).catch(() => []),
          sessionService
            .getSessionState(context.corpId, context.userId, context.sessionId)
            .catch(() => null),
        ]);

        const result = await interventionService.dispatch({
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
          contactName: context.contactName,
          currentMessageContent: extractLatestUserMessage(recentMessages),
          recentMessages: recentMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.timestamp,
          })),
          sessionState,
          recruitmentCase: activeCase,
        });

        logger.warn(
          `request_handoff: chatId=${chatId}, caseId=${activeCase.id}, code=${reasonCode}, dispatched=${result.dispatched}`,
        );

        return {
          dispatched: result.dispatched,
          paused: result.paused,
          alerted: result.alerted,
          suppressed: result.suppressed,
          caseId: activeCase.id,
          instruction:
            '请以招募者身份向候选人自然衔接：说明会让同事跟进处理，但严禁提及“机器人/托管/系统/自动”等字眼。',
        };
      },
    });
  };
}

function extractLatestUserMessage(messages: Array<{ role: string; content: string }>): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return lastUser?.content ?? '';
}
