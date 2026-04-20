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
      description: `查询用户的历史求职记录。追溯本次会话之外更早期的求职历史。

## 两种情况必须调用
1. 对话开始时，若 [用户档案] 非空，说明是回访用户
2. 用户提到"上次"、"之前面试"、"以前聊过"等内容

## 参数
- 无参数，直接调用

## 返回
- recent：近期详细摘要（数组）
- archive：更早期压缩总结（字符串）

## 用途边界
- [用户档案] 和 [会话记忆] 中已有的信息属于本次会话上下文，不要重复调用本工具来获取
- 本工具专用于追溯更早的历史会话`,
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
