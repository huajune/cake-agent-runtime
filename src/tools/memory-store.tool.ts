import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import { ToolBuilder } from '@shared-types/tool.types';

/**
 * memory_store 构建函数
 *
 * 对标 ZeroClaw src/tools/memory_store.rs — 薄包装。
 * 底层调用 MemoryService.store()，自动 deepMerge 已有值。
 */
export function buildMemoryStoreTool(memoryService: MemoryService): ToolBuilder {
  return (context) => {
    const memoryKey = `wework_session:${context.corpId}:${context.userId}:${context.sessionId}`;

    return tool({
      description:
        '存储候选人信息到记忆。当你从对话中发现新的事实信息时调用此工具。' +
        '支持增量存储：新信息会与已有记忆自动合并，不会覆盖已有信息。',
      inputSchema: z.object({
        facts: z
          .record(z.string(), z.unknown())
          .describe('要存储的事实，如 { "name": "张三", "age": "22" }'),
      }),
      execute: async ({ facts }) => {
        await memoryService.store(memoryKey, facts as Record<string, unknown>);
        return { success: true, stored: Object.keys(facts).length };
      },
    });
  };
}
