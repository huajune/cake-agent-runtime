import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import type { ConversationRiskSideEffectIntent } from '@agent/runner/turn-side-effect.types';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('raise_risk_alert');

const DESCRIPTION = `当候选人出现风险行为时调用，触发人工介入（异步暂停托管 + 异步飞书告警，不阻塞本轮回复）。

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
- 严禁在话术中提及"机器人"、"自动回复"、"系统"、"托管"等字眼`;

const inputSchema = z.object({
  riskType: z
    .enum(['abuse', 'complaint_risk', 'escalation'])
    .describe('风险类型：abuse=辱骂，complaint_risk=投诉/举报风险，escalation=情绪升级'),
  reason: z.string().describe('命中原因：用简短中文描述触发信号（引用候选人原话更佳）'),
  summary: z.string().optional().describe('风险摘要：1 句话概括当前局面，供人工快速了解'),
});

type ToolRiskType = ConversationRiskSideEffectIntent['riskType'];

const RISK_TYPE_LABELS: Record<ToolRiskType, string> = {
  abuse: '辱骂/攻击',
  complaint_risk: '投诉/举报风险',
  escalation: '情绪升级',
  interview_result_inquiry: '面试结果追问',
};

function extractLatestUserMessageFromToolContext(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') {
      continue;
    }

    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== 'user') {
      continue;
    }

    if (typeof candidate.content === 'string') {
      return candidate.content;
    }
  }

  return '';
}

/**
 * raise_risk_alert 工具
 *
 * 这是 Agent 语义判断后的风险升级工具，不是 input guardrail 的二次关键词拦截。
 * 高置信关键词风险在生成前由 input guardrail 处理；能走到这里，说明模型需要基于
 * 当前可见上下文主动升级人工介入。本工具只声明 side-effect intent，最终由 outcome
 * 统一出口执行暂停托管 + 飞书告警。
 */
export function buildRaiseRiskAlertTool(): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ riskType, reason, summary }) => {
        const chatId = context.chatId ?? context.sessionId;

        if (!chatId) {
          logger.warn(`raise_risk_alert 缺少 chatId (user=${context.userId})`);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MISSING_CHAT_ID,
            outcome: '缺少 chatId，无法发起风险告警',
            replyInstruction:
              '当前调用缺少 chatId 上下文，本轮不要再调用其他工具；这是结构性问题，无法通过对话恢复。',
            successField: 'accepted',
          });
        }

        const currentMessageContent = extractLatestUserMessageFromToolContext(context.messages);
        const finalRiskType = riskType as ToolRiskType;

        return {
          accepted: true,
          sideEffect: {
            kind: 'conversation_risk',
            source: 'agent_tool',
            riskType: finalRiskType,
            riskLabel: RISK_TYPE_LABELS[finalRiskType] ?? '交流异常',
            summary: summary?.trim() || '候选人对话出现异常风险',
            reason: reason.trim() || `命中 ${finalRiskType}`,
            currentMessageContent,
          },
          instruction:
            '请在本轮回复中以招募者身份共情候选人情绪，避免继续推进任务；严禁使用“机器人/托管/系统/自动”等字眼。',
        };
      },
    });
  };
}
