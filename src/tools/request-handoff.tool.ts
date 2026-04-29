import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { SessionService } from '@memory/services/session.service';
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
 * 会话存在 active 状态的 onboard_followup case 时，本工具触发副作用：
 * 暂停托管 + case 状态变更为 handoff + 飞书告警。
 * 若没有 active case，工具会返回 no_active_case；Agent 仍需停止预约推进，
 * 以"我让同事确认下"自然收口。
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
      description: `面试/入职跟进阶段遇到需人工处理的场景时调用，同步触发人工介入；若没有 active case，本工具会返回 no_active_case，但本轮仍必须停止重新预约/收资/推荐。

## 前置条件
- [当前预约信息] 存在时必须调用，本工具会暂停托管并发送人工介入告警
- 若对话文本已明确出现已预约、改期/取消、已面试、面试通过、店长已联系、只能一家店、报到/培训/办入职等状态，即使 [当前预约信息] 缺失也可以调用；工具可能返回 no_active_case，此时不要继续常规预约流程，只能告知候选人会让同事确认
- 若候选人说明银行卡异常、被起诉、房贷断供、不能用本人卡收薪，或追问税务/发薪主体导致你无法确认岗位规则，也可以调用；工具可能返回 no_active_case，此时只说明让同事确认发薪规则

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
- 同步执行「暂停托管 + case 状态改为 handoff + 飞书告警」

## 参数
- reasonCode：五个枚举之一
- reason：结合候选人原话描述阻塞点
- summary（可选）：一句话概括当前信息状态

## 硬规则
- 本轮回复必须先调用本工具，再以招募者口吻做一次自然衔接（例如"我让同事跟进一下这边"），措辞自定
- 若返回 no_active_case，也不得改走 booking/precheck/job_list；只回复会让同事确认，等待人工处理
- 严禁在本轮继续推进其他任务（换岗位、改约时间、收资料等）
- 严禁话术中提及"机器人"、"托管"、"系统"、"自动"等字眼`,
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
          logger.warn(`request_handoff 无 active case: chatId=${chatId}`);
          return {
            dispatched: false,
            error: 'no_active_case',
            instruction:
              '当前会话不存在可转接的 onboard_followup case；请停止重新预约/收资/推荐，以招募者身份自然说明“我让同事确认下这边”，等待人工处理。',
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
