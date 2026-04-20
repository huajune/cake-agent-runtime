import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('skip_reply');

/**
 * skip_reply 工具
 *
 * 副作用型工具：调用后本轮不再生成对外消息。
 * 与 raise_risk_alert / request_handoff 同类——不产生对话回复，只落观测指标。
 *
 * 使用场景：候选人回复仅为纯确认词（好的/好/谢谢/嗯/收到/ok），
 * 且上一轮你已完成明确推进（给岗位、发模板、拉群、面试确认），
 * 本轮继续主动回复反而显得生硬。
 */
export function buildSkipReplyTool(): ToolBuilder {
  return (context) => {
    return tool({
      description: `主动跳过本轮回复（什么都不发）。调用后 runtime 会短路消息发送，但仍记录本轮流水。

## 调用充要条件（全部满足才允许调用）
1. 候选人本轮消息为纯确认词（好的/好/谢谢/嗯/收到/ok/okk/好吧 等），长度 < 10 字符，**不含问句结构**；
2. 上一轮你已完成明确推进动作：已推荐岗位 / 发了面试模板 / 已拉群 / 已发送面试确认；
3. 本轮没有新的待确认线索或候选人诉求变化。

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
- 监控可统计"主动沉默率"`,
      inputSchema: z.object({
        reason: z
          .string()
          .min(1)
          .describe('为何沉默：简短中文描述触发条件（如"候选人回复好的，上轮已拉群"）'),
      }),
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
