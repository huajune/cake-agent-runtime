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

const DESCRIPTION = `候选人遇到你无法自助推进、需要真人介入的阻塞时调用——**不限会话阶段**：岗位咨询、收资、约面、面试后、入职跟进期间都可能触发（具体见下方 15 类场景，其中 6/7/9/10 等场景在约面及之后阶段最常见）。**调用即短路本轮——runtime 会自动结束本轮，候选人本次不会收到任何回复**，副作用（暂停托管 / 飞书告警 / case 状态变更）全部异步执行。

## 前置条件
- [当前预约信息] 存在时必须调用，本工具会异步暂停托管并发送人工介入告警
- 若对话文本已明确出现已面试、面试通过、店长已联系/店长指定到某家店、报到/培训/办入职等**面试后状态**，即使 [当前预约信息] 缺失也必须按对应场景（5 interview_result_inquiry / 7 self_recruited_or_completed）调用；本轮仍会沉默，托管会被异步关闭。注意两个例外：候选人提"改期/取消"不适用本条，按场景 6 的自助优先规则处理；单说"已预约/约过了"也不足以触发本条，需结合上述面试后信号判断
- 若候选人说明银行卡异常、被起诉、房贷断供、不能用本人卡收薪，或追问税务/发薪主体导致你无法确认岗位规则，也调用本工具，本轮沉默并由人工跟进

## 触发场景（出现任一即调用）
1. cannot_find_store：候选人反馈找不到门店、导航错、门店地址错等定位问题，且 send_store_location 仍无法解决
2. no_reception：候选人到店后联系不上负责人、店长不在、无人接待、电话打不通
3. booking_conflict：门店反馈查不到预约、与系统记录冲突、现场说没有你预约的岗位
4. onboarding_paperwork：候选人进入入职/上岗对接、办理手续、报到流程等你无法处理的环节
5. interview_result_inquiry：候选人主动追问面试结果/是否通过/录取通知，例如"我刚刚面试过了通过了吗"、"店长说让我等通知"、"今天面完了什么时候有结果"
6. modify_appointment：候选人**主动**要求改时间/取消/重排**已确认的**面试，例如"能不能改到明天"、"约的那天我去不了"、"想取消之前的预约"
   - **自助优先（重要）**：改时间先用 duliday_modify_interview_time、取消先用 duliday_cancel_work_order（[当前预约信息] 带「工单号」时即可自助）。**只有这两个工具返回失败、或拿不到工单号时，才用本码转人工**——不要在能自助时直接转人工
   - **“明天上午的面试还有吗 / 上午还有场次吗”只是查询可用性，不是改约请求**：precheck 后直接回答可约时段并等待候选人确认，不调用本工具。严禁把 reasonCode 换成 other 绕过这条规则
   - 反面（不调用）：招募经理上一条刚抛出多个候选时段让候选人挑（如"明天 10-16 / 后天 10-16 / 下周一 10-16，你看哪天方便"），候选人回单个时段（"明天"/"周一"/"后天上午"）属于首次约面，是 booking 流程而非改期
   - 反面（不调用）：系统里有 active case 但其 interview_time 已过去（早于今天），属于 stale 数据，不要据此推断候选人"改期"
7. self_recruited_or_completed：候选人称已被该门店面试通过/已经在该门店上班/餐厅自招/办入职/上岗/试工/试做，例如"我已经在 X 店干过了"、"是店长让我来的"、"我们餐厅找的我"、"现在来办入职"、"要先离职吗"、"明天去 X 店试工"、"明天试做一下"、"今天上岗"、"已经面试过了/通过了"。**关键词触发**：候选人消息中出现"试工 / 试做 / 上岗 / 入职 / 已面试过 / 已通过"等明确信号时，即使没有"店长"等其他线索，也必须按本场景调用本工具，不得当作普通新候选人继续约面或登记
8. no_match_or_group_full：放宽品牌/区域重查后仍无匹配岗位，**且对应兼职群已满（invite.group_full）**、无法自助拉群维护，需人工跟进扩群 / 跨城跨区推荐。**这是常见兜底场景**：当你已用 duliday_job_list 去掉品牌限制、保留硬约束重查仍无岗，且 invite_to_group 返回"群满"时，按本码转人工，不要再笼统归为 other
   - **例外（不转人工）**：若 invite_to_group 返回的是"该城市/平台本就没有兼职群"（invite.no_group_in_city / invite.no_group_available，区别于群满），属于"推荐无岗且没有兼职群"场景，**不要**调用本工具转人工——按 invite_to_group 的 replyInstruction 自然收口、继续托管即可
9. system_blocked：precheck / booking 等工具返回结构性错误导致无法自助推进（如 precheck 持续 missingFields 卡住 booking、booking 返回 BOOKING_REJECTED 且非报名人数已满）。本质是**系统报错让流程转不下去、你无法替候选人完成报名登记，而非候选人自身原因**——需运营在后台核对资料、手动补录报名或修复数据。reason 里用平实语言写清「候选人卡在哪一步、资料是否已收齐、需要人工做什么」，不要只贴报错码。**报名人数超上限用 booking_capacity_full、拉群接口失败用 group_invite_failed，不要归入本码**
10. booking_capacity_full：duliday_interview_booking 返回"报名人数已超出上限"类失败——资料已齐、时间已定但岗位名额满，需人工确认能否加名额或协调其他时段/门店。这不是系统故障，严禁归入 system_blocked
11. group_invite_failed：候选人已同意进群，但 invite_to_group 返回接口拒绝（invite.api_rejected / bot 非好友 / bot 不在群 / errcode 异常等，**非群满、非该城市无群**），无法完成拉群，需人工手动邀请或维护
12. salary_admin_inquiry：候选人咨询针对个人的薪资/行政事务——如工时未计入、几号发几月工资、考勤核算、开工作证明/收入证明、三方协议、合同/协议条款、签约主体、社保、试用期、银行卡异常不能本人收薪、税务/发薪主体等。**先查证，查不到就当轮转人工**：属于岗位通用口径的（薪资范围/结算周期/福利）先用 duliday_job_list 等岗位工具的字段作答；工具字段确实没有答案（尤其针对候选人个人的账务/证明/合同细节）时，直接按本码调用本工具，由真人接续跟进。**用本码时必传 missingJobInfo**：逐项列出候选人问到而岗位字段没有答案的信息点（如 ["试用期","工作餐"]）——这类问题本质是岗位数据缺口，告警卡片会连同当前岗位一起展示给运营补录。**禁止空头承诺**：不要说"帮你确认下/我去问问"却不调用本工具——没有任何机制会去替你"确认"，这句话说出口就必须当轮转人工；也不要复读兜底、不要凭常识编造合同或薪资口径
13. interview_slot_coordination：候选人有明确的硬性时间窗（如只能周末/只能某个具体时段），precheck 确认系统可约场次均无法覆盖且候选人明确不接受现有场次，需人工与门店协调特殊时段。与 modify_appointment 区分：本码用于**尚未预约成功**的时段协调，不是改期
14. identity_age_exception：候选人身份/年龄处于岗位硬要求边界（如 17 岁、学生想上社会人士岗、暑假工改长期兼职但系统仍按原身份过滤），且你已按"何时不调用"的要求重查替代岗仍无果，需人工裁量能否破例或人工修正登记信息
15. other：明显需人工介入、且确实不属于以上十四类的阻塞场景（真正的兜底，能归类就不要用 other）
- **需求连续无法满足禁复读**：候选人明确提出的硬需求（包住宿/包吃/特定班次/距离等）连续两轮都无法用 duliday_job_list 结果满足，且你已无法再实质调整查询条件（扩区域/放宽品牌品类/调整距离）时，不要第三次复读"没有"、也不要重复反问同一个问题。兜底顺序保持拉群优先：先如实说明一次并调用 invite_to_group 拉群维护；invite 返回群满（group_full）才按 no_match_or_group_full 调用本工具；该城市本就没有群（no_group_in_city / no_group_available）时自然收口继续托管、不转人工；只有候选人明确拒绝进群、点名要真人跟进、或场景确实无法用拉群维护时才按 other 调用本工具。duliday_job_list 结果头部出现「重复查询提醒」即此场景的确定性信号

## 何时不调用
- 如果候选人只是常规询问门店位置/路线，先用 send_store_location 处理，不要直接转人工
- 如果只是你上一轮主动推荐的岗位在收资后发现年龄/性别/班次/学历等硬条件不匹配，且候选人没有已确认预约、入职办理、门店异常、风险投诉等人工阻塞，不要直接调用本工具。先说明当前岗位不匹配，再用 duliday_job_list 去掉原品牌限制、保留候选人的位置/年龄/身份/时间窗等硬约束重查可匹配替代岗位；查后确实没有自助推进路径时，才按 invite_to_group 或本工具兜底（此时转人工用 reasonCode="no_match_or_group_full"，不要用 other）。**但若 invite_to_group 返回的是"该城市/平台本就没有兼职群"（非群满），不要转人工，自然收口继续托管即可——只有"群满"才走本工具。**

## 执行效果
- runtime 立即结束本轮 loop，候选人本次不会收到任何回复
- 异步执行「暂停托管 + case 状态改为 handoff + 飞书告警」

## 参数
- reasonCode：十五个枚举之一
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
      'booking_capacity_full',
      'group_invite_failed',
      'salary_admin_inquiry',
      'interview_slot_coordination',
      'identity_age_exception',
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
  missingJobInfo: z
    .array(z.string())
    .optional()
    .describe(
      'reasonCode=salary_admin_inquiry 时必传：候选人问到而岗位工具/字段没有答案的信息点（岗位数据缺口），如 ["试用期","工作餐","转正政策"]。告警卡片会连同当前焦点岗位展示给运营补录岗位数据',
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
  system_blocked: '系统异常需人工补录',
  booking_capacity_full: '岗位报名人数已满',
  group_invite_failed: '拉群失败需人工维护',
  salary_admin_inquiry: '薪资/考勤/证明类咨询',
  interview_slot_coordination: '面试时段需人工协调',
  identity_age_exception: '身份/年龄边界需人工裁量',
  other: '其他需人工处理场景',
};

/**
 * request_handoff 工具
 *
 * 当 Agent 判断候选人遇到无法自助推进的阻塞（不限会话阶段：咨询/收资/约面/
 * 面试后/入职跟进均可能触发）时调用。
 *
 * 行为约定（与 skip_reply 同属「短路工具」）：
 * - 调用即由 runtime 立即结束本轮 loop，本轮不再生成任何对外回复
 * - 工具返回 sideEffect intent；最终 outcome 被采纳后，由统一出口执行暂停托管 + 飞书告警 + handoff 底账
 * - 即便没有 active case，也会异步暂停托管，避免 Agent 继续与候选人对话
 *
 * Agent 调用前不要再尝试组织安抚/收口话术——本轮就是沉默。
 */
export function buildRequestHandoffTool(
  interventionService: InterventionService,
  chatSessionService: ChatSessionService,
  sessionService: SessionService,
  longTermService: LongTermService,
  _handoffRecorder: HandoffRecorderService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ reasonCode, reason, actionAdvice, missingJobInfo }) => {
        const chatId = context.chatId ?? context.sessionId;

        if (!chatId) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.MISSING_CHAT_ID,
            outcome: '缺少 chatId，无法转人工',
            replyInstruction:
              '当前调用缺少 chatId 上下文，本轮不要再调用其他工具；这是结构性问题，无法通过对话恢复。',
            successField: 'dispatched',
          });
        }

        const activeBooking = await longTermService
          .getActiveBooking(context.corpId, context.userId)
          .catch(() => null);
        const workOrderId = activeBooking?.work_order_id ?? context.runtimeWorkOrderId ?? null;

        // 守卫：候选人要求"改期/取消"但根本没有已确认预约 → 这其实是首次约面意向。
        // 返回 shortCircuited:false（不短路），让 runtime 继续、Agent 按首次约面流程推进。
        if (reasonCode === 'modify_appointment' && workOrderId == null) {
          logger.log(
            `request_handoff(modify_appointment) 但无 active_booking，按首次约面继续: chatId=${chatId}`,
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

        const [recentMessages, sessionState] = await Promise.all([
          chatSessionService.getChatHistory(chatId, 10).catch(() => []),
          sessionService
            .getSessionState(context.corpId, context.userId, context.sessionId)
            .catch(() => null),
        ]);

        return {
          dispatched: true,
          shortCircuited: true,
          sideEffect: {
            kind: 'general_handoff',
            source: 'agent_tool',
            alertLabel: HANDOFF_REASON_LABELS[reasonCode] ?? '需人工跟进',
            reasonCode,
            reason: reason?.trim() || HANDOFF_REASON_LABELS[reasonCode] || '需要人工协助',
            actionAdvice: actionAdvice?.trim(),
            missingJobInfo: missingJobInfo?.map((item) => item.trim()).filter(Boolean),
            currentMessageContent: extractLatestUserMessage(recentMessages),
            recentMessages: recentMessages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: m.timestamp,
            })),
            sessionState,
            stage: context.currentStage ?? null,
            botImId: context.botImId,
            workOrderId,
            recordHandoff: true,
          },
          instruction:
            '本轮 runtime 已自动结束，托管将异步暂停，飞书人工告警将异步发送。禁止再生成任何文本或调用其他工具。',
        };
      },
    });
  };
}
