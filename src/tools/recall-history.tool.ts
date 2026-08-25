import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import type { SummaryEntry } from '@memory/long-term/long-term.types';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('recall_history');

const DESCRIPTION = `查询用户的历史求职记录。追溯本次会话之外更早期的求职历史。

## 两种情况必须调用
1. 对话开始时，若 [用户档案] 非空，说明是回访用户
2. 用户提到"上次"、"之前面试"、"以前聊过"等内容

## 参数
- 无参数，直接调用

## 返回
- sessionSummaries：历史咨询段摘要数组，按时间从旧到新排列，最多 20 段

## 用途边界
- [用户档案] 和 [会话记忆] 中已有的信息属于本次会话上下文，不要重复调用本工具来获取
- 本工具专用于追溯更早的历史会话`;

const inputSchema = z.object({});

function formatSummaryForTool(data: SummaryEntry[] | null): string {
  if (!data) return '';
  if (data.length === 0) return '';

  const summaryLines = data.map(
    (entry) =>
      `- [${entry.startTime?.substring(0, 10) || '历史'}] ${entry.summary}${entry.coverageNote ? `（${entry.coverageNote}）` : ''}`,
  );
  return `\n\n[历史摘要]\n\n### 历次求职记录\n${summaryLines.join('\n')}`;
}

/**
 * recall_history 构建函数
 *
 * LLM 按需检索用户的历史求职摘要。
 * 当用户提到"上次"、"之前"、"以前"等关键词时，LLM 主动调用此工具。
 *
 * 返回按时间排列的单层 sessionSummaries 数组，格式化为可读文本。
 */
export function buildRecallHistoryTool(memoryService: MemoryService): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async () => {
        const botUserId = context.session.botUserId?.trim();
        if (!botUserId) {
          logger.warn(`缺少稳定 botUserId，拒绝读取长期摘要: userId=${context.session.userId}`);
          return { found: false, message: '当前账号身份未就绪，无法读取历史求职记录' };
        }
        const sessionSummaries = await memoryService.getSessionSummaries(
          context.session.corpId,
          context.session.userId,
          botUserId,
        );

        if (!sessionSummaries || sessionSummaries.length === 0) {
          logger.debug(`无历史摘要: userId=${context.session.userId}`);
          return { found: false, message: '该用户无历史求职记录' };
        }

        const formatted = formatSummaryForTool(sessionSummaries);
        logger.debug(
          `返回历史摘要: userId=${context.session.userId}, count=${sessionSummaries.length}`,
        );

        return {
          found: true,
          summaryCount: sessionSummaries.length,
          content: formatted,
        };
      },
    });
  };
}
