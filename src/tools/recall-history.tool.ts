import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { LongTermService } from '@memory/long-term.service';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('recall_history');

/**
 * recall_history 构建函数
 *
 * LLM 按需检索用户的历史求职摘要。
 * 当用户提到"上次"、"之前"、"以前"等关键词时，LLM 主动调用此工具。
 *
 * 返回分层压缩的摘要数据（recent + archive），格式化为可读文本。
 */
export function buildRecallHistoryTool(longTermService: LongTermService): ToolBuilder {
  return (context) => {
    return tool({
      description:
        '查询用户的历史求职记录。当用户提到"上次"、"之前面试"、"以前聊过"等内容时调用此工具，了解用户过往求职经历。',
      inputSchema: z.object({}),
      execute: async () => {
        const summaryData = await longTermService.getSummaryData(context.corpId, context.userId);

        if (!summaryData || (summaryData.recent.length === 0 && !summaryData.archive)) {
          logger.debug(`无历史摘要: userId=${context.userId}`);
          return { found: false, message: '该用户无历史求职记录' };
        }

        const formatted = longTermService.formatSummaryForPrompt(summaryData);
        logger.debug(`返回历史摘要: userId=${context.userId}, recent=${summaryData.recent.length}`);

        return {
          found: true,
          recentCount: summaryData.recent.length,
          hasArchive: !!summaryData.archive,
          content: formatted,
        };
      },
    });
  };
}
