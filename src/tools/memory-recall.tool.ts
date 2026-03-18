import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import { ToolBuilder } from '@shared-types/tool.types';

/**
 * memory_recall 构建函数
 *
 * 对标 ZeroClaw src/tools/memory_recall.rs — 薄包装。
 * 对话开始时调用此工具获取历史记忆，避免重复提问。
 */
export function buildMemoryRecallTool(memoryService: MemoryService): ToolBuilder {
  return (context) => {
    const memoryKey = `wework_session:${context.corpId}:${context.userId}:${context.sessionId}`;

    return tool({
      description: '回忆候选人已知信息。对话开始时调用此工具获取历史记忆，避免重复提问。',
      inputSchema: z.object({}),
      execute: async () => {
        const entry = await memoryService.recall(memoryKey);
        if (!entry) return { found: false, message: '无历史记忆' };
        return { found: true, facts: entry.content, updatedAt: entry.updatedAt };
      },
    });
  };
}
