import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SessionService } from '@memory/services/session.service';
import { InterventionService } from '@biz/intervention/intervention.service';
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
 * 本工具仅触发副作用：异步暂停托管 + 异步飞书告警（fire-and-forget，不阻塞回复）。
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
      description: `当候选人出现风险行为时调用，触发人工介入（异步暂停托管 + 异步飞书告警，不阻塞本轮回复）。

## 触发场景（出现任一即必须调用）
1. 候选人出现明显辱骂、人身攻击、粗俗表达（如"滚"、"傻X"、"有病"）
2. 候选人明确威胁投诉、举报、曝光、维权、报警、找劳动局/仲裁
3. 候选人情绪连续升级：近 2~3 轮出现反复追问、催促、质疑、软负向表达（"不靠谱"、"敷衍"、"玩我"、"太差"等），且前一轮回复已尝试共情仍未缓解

## 何时不调用
- 如果仅是普通不耐烦、没有情绪升级迹象，不要调用本工具，按正常阶段策略处理即可

## 执行效果
- 异步执行「暂停托管 + 飞书告警」，本轮 Agent 仍需输出共情/安抚话术给候选人；下一轮候选人发言将由人工接手，不再由你回复

## 参数
- riskType：abuse / complaint_risk / escalation 三选一，按最贴合的一项选择
- reason：一句话描述触发信号，尽量引用候选人原话（便于人工快速定位）
- summary（可选）：简述当前局面（如候选人在哪个环节、拒绝什么）

## 硬规则
- 本轮回复必须先调用本工具，再按招募者身份自主组织一句共情/致歉/安抚话术
- 严禁在本轮继续推进任务（收资料、查岗位、约面试、拉群等）
- 严禁复读候选人的粗口或攻击性表达
- 严禁在话术中提及"机器人"、"自动回复"、"系统"、"托管"等字眼`,
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

        void interventionService
          .dispatch({
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
              `raise_risk_alert dispatched: chatId=${chatId}, type=${riskType}, paused=${result.paused}, alerted=${result.alerted}, suppressed=${result.suppressed ?? '-'}`,
            );
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              `raise_risk_alert dispatch 异步执行失败: chatId=${chatId}, type=${riskType}, ${message}`,
            );
          });

        return {
          dispatched: true,
          instruction:
            '请在本轮回复中以招募者身份共情候选人情绪，避免继续推进任务；严禁使用“机器人/托管/系统/自动”等字眼。',
        };
      },
    });
  };
}
