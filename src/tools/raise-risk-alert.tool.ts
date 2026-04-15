import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SessionService } from '@memory/services/session.service';
import { InterventionService } from '@notification/intervention/intervention.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { extractLatestUserMessage } from './utils/chat-history.util';

const logger = new Logger('raise_risk_alert');

const RISK_TYPE_LABELS: Record<string, string> = {
  abuse: '辱骂/攻击',
  complaint_risk: '投诉/举报风险',
  escalation: '情绪升级',
};

/**
 * raise_risk_alert 工具
 *
 * 当 Agent 在推理过程中识别到以下任一情况时调用：
 * - 候选人出现辱骂、粗俗表达
 * - 候选人明确投诉、举报或威胁维权
 * - 候选人情绪连续升级、反复追问或出现软负向表达
 *
 * 本工具仅触发副作用：暂停托管 + 飞书告警。
 * 安抚话术由 Agent 基于候选人语境自行组织，不使用预设模板，
 * 并且严格禁止在回复中暴露“机器人 / 托管 / 系统”等身份字眼。
 */
export function buildRaiseRiskAlertTool(
  interventionService: InterventionService,
  chatSessionService: ChatSessionService,
  sessionService: SessionService,
): ToolBuilder {
  return (context) => {
    return tool({
      description:
        '当候选人出现明显辱骂/投诉/情绪升级时调用，同步触发人工介入（暂停托管+飞书告警）。调用后请以真人招募者的口吻，基于候选人原话做共情/致歉/安抚，不得提及机器人、自动回复、系统、托管等字眼。',
      inputSchema: z.object({
        riskType: z
          .enum(['abuse', 'complaint_risk', 'escalation'])
          .describe('风险类型：abuse=辱骂，complaint_risk=投诉/举报风险，escalation=情绪升级'),
        reason: z.string().describe('命中原因：用简短中文描述触发信号（引用候选人原话更佳）'),
        summary: z.string().optional().describe('风险摘要：1 句话概括当前局面，供人工快速了解'),
      }),
      execute: async ({ riskType, reason, summary }) => {
        const chatId = context.chatId ?? context.sessionId;
        const pauseTargetId = chatId || context.imContactId || context.userId;

        if (!chatId) {
          logger.warn(`raise_risk_alert 缺少 chatId (user=${context.userId})`);
          return { dispatched: false, error: 'missing_chat_id' };
        }

        const [recentMessages, sessionState] = await Promise.all([
          chatSessionService.getChatHistory(chatId, 10).catch(() => []),
          sessionService
            .getSessionState(context.corpId, context.userId, context.sessionId)
            .catch(() => null),
        ]);

        const result = await interventionService.dispatch({
          kind: 'conversation_risk',
          source: 'agent_tool',
          riskType,
          riskLabel: RISK_TYPE_LABELS[riskType] ?? '交流异常',
          summary: summary?.trim() || '候选人对话出现异常风险',
          reason: reason?.trim() || `命中 ${riskType}`,
          chatId,
          corpId: context.corpId,
          userId: context.userId,
          pauseTargetId,
          botImId: context.botImId,
          contactName: context.contactName,
          currentMessageContent: extractLatestUserMessage(recentMessages),
          recentMessages: recentMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.timestamp,
          })),
          sessionState,
        });

        logger.warn(
          `raise_risk_alert: chatId=${chatId}, type=${riskType}, dispatched=${result.dispatched}, alerted=${result.alerted}`,
        );

        return {
          dispatched: result.dispatched,
          paused: result.paused,
          alerted: result.alerted,
          suppressed: result.suppressed,
          instruction:
            '请在本轮回复中以招募者身份共情候选人情绪，避免继续推进任务；严禁使用“机器人/托管/系统/自动”等字眼。',
        };
      },
    });
  };
}
