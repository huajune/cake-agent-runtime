import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from './shared/tool-error-types';

const logger = new Logger('skip_reply');

const DESCRIPTION = `主动跳过本轮回复（什么都不发）。调用后 runtime 会短路消息发送，但仍记录本轮流水。

## 合法调用场景（满足任一场景即应调用）

### 场景一：确认词收尾（scene=confirmation_closure，三条全部满足）
1. 候选人本轮消息为纯确认词（好的/好/谢谢/嗯/收到/ok/okk/好吧 等），长度 < 10 字符，**不含问句结构**；
2. 上一轮你已完成明确推进动作：已推荐岗位 / 发了面试模板 / 已拉群 / 已发送面试确认；
3. 本轮没有新的待确认线索或候选人诉求变化。

### 场景二：真人招募经理正在沟通（scene=human_takeover）
候选人当前消息之前**最近一条经理侧消息**带【内部来源标记：真人招募经理手动发送】，且候选人本轮是在**回应这条真人消息**（如经理问"有餐饮经验吗"、候选人答"有的"），且未带出新的业务诉求（新问题/新地点/新岗位类型）→ 必须调用 skip_reply 把对话让给真人，不要插话。
边界：只看最近一条经理侧消息。你自己（Agent）回复过之后，候选人的下一条就是发给你的，更早历史里的真人标记不构成让位理由；runtime 会按消息来源校验该条件，不成立时本工具返回 \`skipped=false\` 并拒绝沉默，此时必须正常回复候选人，不得改用其他场景再次沉默。
注意：若候选人在回应真人的同时提出了需要你处理的新诉求（问岗位/要地址/要改约等），则正常接管回复，不适用本场景。

## 想沉默只有这一条通道
判断本轮不该回复时，**唯一**合法动作是调用本工具。**严禁**用文本形式表达沉默——不得输出"（本轮不回复）""（AI 保持静默）"之类的括号旁白或任何说明文字，那会被当成正文直接发给候选人。

## 禁止调用场景
- 候选人首句（没有上轮铺垫）
- 候选人提新问题 / 新诉求 / 新地点 / 新岗位类型
- 候选人表达情绪（不满、催促、质疑、粗口等）→ 用 raise_risk_alert
- 同轮还需要调用其它业务工具（duliday_* / invite_to_group / send_store_location 等）

## 硬规则
- 本轮调用 skip_reply 后，**不得再输出任何文本回复**，也不得再调用其它工具
- skip_reply 与 raise_risk_alert / request_handoff 互斥：有风险应走告警而非沉默
- scene 必填，只能是上述两个场景之一；reason 必填，简短说明为什么沉默（便于复盘）

## 执行效果
- 本轮不给候选人发任何消息
- 流水仍写入 message_processing_records（deliveryState=skipped_intentional）
- 监控可统计"主动沉默率"`;

export const SKIP_REPLY_SCENES = ['confirmation_closure', 'human_takeover'] as const;

const inputSchema = z.object({
  scene: z
    .enum(SKIP_REPLY_SCENES)
    .describe(
      '沉默场景：confirmation_closure=候选人纯确认词收尾；human_takeover=真人招募经理正在沟通（runtime 按消息来源校验）',
    ),
  reason: z
    .string()
    .min(1)
    .describe('为何沉默：简短中文描述触发条件（如"候选人回复好的，上轮已拉群"）'),
});

/**
 * skip_reply 工具
 *
 * 副作用型工具：调用后本轮不再生成对外消息。
 * 与 raise_risk_alert / request_handoff 同类——不产生对话回复，只落观测指标。
 *
 * 使用场景一：候选人回复仅为纯确认词（好的/好/谢谢/嗯/收到/ok），
 * 且上一轮你已完成明确推进（给岗位、发模板、拉群、面试确认），
 * 本轮继续主动回复反而显得生硬。
 *
 * 使用场景二：真人招募经理手动接管沟通、候选人正在回应真人时，通过本工具静默让位。
 * 没有这个合法出口时，模型会把"（AI 保持静默）"旁白当正文发给候选人。
 *
 * 场景二由 runtime 确定性校验：`turnInput.humanTakeoverActive`（候选人当前消息之前最近一条
 * 经理侧消息是否真人手动发送）不成立时拒绝沉默，返回 buildToolError（skipped=false、不短路），
 * 模型必须继续正常回复；generator 的 prepareStep 会在拒绝后屏蔽本工具，防止换场景再试。
 * 接受时返回 `skipped=true` + `shortCircuited=true`，生成链路据此短路，不再依赖工具名特判。
 */
export function buildSkipReplyTool(): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ scene, reason }) => {
        const chatId = context.session.chatId ?? context.session.sessionId;
        const trimmedReason = reason.trim();

        if (scene === 'human_takeover' && context.turnInput.humanTakeoverActive !== true) {
          logger.warn(
            `skip_reply 拒绝: scene=human_takeover 但最近一条经理侧消息非真人手动发送, chatId=${chatId}, userId=${context.session.userId}, reason=${trimmedReason}`,
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.SKIP_REPLY_HUMAN_TAKEOVER_NOT_ACTIVE,
            replyInstruction:
              '候选人当前消息之前最近一条经理侧消息是你自己（Agent）发出的，不存在真人正在沟通；候选人这条消息是发给你的，本轮必须正常回复，不得再次调用 skip_reply。',
            details: { skipped: false, scene, reason: trimmedReason },
          });
        }

        logger.log(
          `skip_reply: chatId=${chatId}, userId=${context.session.userId}, scene=${scene}, reason=${trimmedReason}`,
        );

        return {
          skipped: true,
          shortCircuited: true,
          scene,
          reason: trimmedReason,
          instruction: '本轮不得再输出任何文本，也不得调用其他工具；直接结束本轮。',
        };
      },
    });
  };
}
