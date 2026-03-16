import { Injectable } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import { AiTool, ToolBuildContext, ToolFactory } from './tool.types';

/**
 * memory_store — LLM 工具：存储候选人事实信息到记忆
 *
 * 对标 ZeroClaw src/tools/memory_store.rs — 薄包装。
 * 底层调用 MemoryService.store()，自动 deepMerge 已有值。
 */
@Injectable()
export class MemoryStoreToolService implements ToolFactory {
  readonly toolName = 'memory_store';
  readonly toolDescription =
    '存储候选人信息到记忆。当你从对话中发现新的事实信息时调用此工具。' +
    '支持增量存储：新信息会与已有记忆自动合并，不会覆盖已有信息。';

  constructor(private readonly memoryService: MemoryService) {}

  buildTool(context: ToolBuildContext): AiTool {
    const memoryKey = `wework_session:${context.corpId}:${context.userId}`;

    return tool({
      description: this.toolDescription,
      inputSchema: z.object({
        facts: z
          .record(z.string(), z.unknown())
          .describe('要存储的事实，如 { "name": "张三", "age": "22" }'),
      }),
      execute: async ({ facts }) => {
        await this.memoryService.store(memoryKey, facts as Record<string, unknown>);
        return { success: true, stored: Object.keys(facts).length };
      },
    });
  }
}
