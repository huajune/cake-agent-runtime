import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import type { SummaryData } from '@memory/types/long-term.types';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('recall_history');

function formatSummaryForTool(data: SummaryData | null): string {
  if (!data) return '';

  const parts: string[] = [];

  if (data.archive) {
    parts.push(`### 历史总结\n${data.archive}`);
  }

  if (data.recent.length > 0) {
    const recentLines = data.recent.map(
      (e) => `- [${e.startTime?.substring(0, 10) ?? '?'}] ${e.summary}`,
    );
    parts.push(`### 近期求职记录\n${recentLines.join('\n')}`);
  }

  if (parts.length === 0) return '';
  return `\n\n[历史摘要]\n\n${parts.join('\n\n')}`;
}

/**
 * recall_history 构建函数
 *
 * LLM 按需检索用户的历史求职摘要。
 * 当用户提到"上次"、"之前"、"以前"等关键词时，LLM 主动调用此工具。
 *
 * 返回分层压缩的摘要数据（recent + archive），格式化为可读文本。
 */
export function buildRecallHistoryTool(memoryService: MemoryService): ToolBuilder {
  return (context) => {
    return tool({
      description:
        '查询用户的历史求职记录。当用户提到"上次"、"之前面试"、"以前聊过"等内容时调用此工具，了解用户过往求职经历。',
      inputSchema: z.object({}),
      execute: async () => {
        const summaryData = await memoryService.getSummaryData(context.corpId, context.userId);

        if (!summaryData || (summaryData.recent.length === 0 && !summaryData.archive)) {
          logger.debug(`无历史摘要: userId=${context.userId}`);
          return { found: false, message: '该用户无历史求职记录' };
        }

        const formatted = formatSummaryForTool(summaryData);
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
