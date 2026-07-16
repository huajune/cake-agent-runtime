import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('skip_reply');

const DESCRIPTION = `主动跳过本轮回复（什么都不发）。调用后 runtime 会短路消息发送，但仍记录本轮流水。

## 合法调用场景（满足任一场景即应调用）

### 场景一：确认词收尾（三条全部满足）
1. 候选人本轮消息为纯确认词（好的/好/谢谢/嗯/收到/ok/okk/好吧 等），长度 < 10 字符，**不含问句结构**；
2. 上一轮你已完成明确推进动作：已推荐岗位 / 发了面试模板 / 已拉群 / 已发送面试确认；
3. 本轮没有新的待确认线索或候选人诉求变化。

### 场景二：真人招募经理正在沟通
历史消息中出现【真人招募经理手动发送】来源标记，且候选人本轮是在**回应真人经理的问话**（如经理问"有餐饮经验吗"、候选人答"有的"），且未带出新的业务诉求（新问题/新地点/新岗位类型）→ 必须调用 skip_reply 把对话让给真人，不要插话。
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
- reason 必填，简短说明为什么沉默（便于复盘）

## 执行效果
- 本轮不给候选人发任何消息
- 流水仍写入 message_processing_records（deliveryState=skipped_intentional）
- 监控可统计"主动沉默率"`;

const inputSchema = z.object({
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
 * 使用场景二：真人招募经理手动接管沟通、候选人正在回应真人时，通过本工具
 * 静默让位（badcase chat 6a5740ff…：模型有沉默意图却无合法出口，把
 * "（AI 保持静默）"旁白当正文发给了候选人，经理被迫撤回）。
 */
export function buildSkipReplyTool(): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ reason }) => {
        const chatId = context.chatId ?? context.sessionId;
        logger.log(
          `skip_reply: chatId=${chatId}, userId=${context.userId}, reason=${reason.trim()}`,
        );

        return {
          skipped: true,
          reason: reason.trim(),
          instruction: '本轮不得再输出任何文本，也不得调用其他工具；直接结束本轮。',
        };
      },
    });
  };
}
