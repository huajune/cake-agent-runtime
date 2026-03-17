import { Injectable } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import { AiTool, ToolBuildContext, ToolFactory } from '@shared-types/tool.types';

/**
 * memory_recall — LLM 工具：回忆候选人已知信息
 *
 * 对标 ZeroClaw src/tools/memory_recall.rs — 薄包装。
 * 对话开始时调用此工具获取历史记忆，避免重复提问。
 */
@Injectable()
export class MemoryRecallToolService implements ToolFactory {
  readonly toolName = 'memory_recall';
  readonly toolDescription = '回忆候选人已知信息。对话开始时调用此工具获取历史记忆，避免重复提问。';

  constructor(private readonly memoryService: MemoryService) {}

  buildTool(context: ToolBuildContext): AiTool {
    const memoryKey = `wework_session:${context.corpId}:${context.userId}`;

    return tool({
      description: this.toolDescription,
      inputSchema: z.object({}),
      execute: async () => {
        const entry = await this.memoryService.recall(memoryKey);
        if (!entry) return { found: false, message: '无历史记忆' };
        return { found: true, facts: entry.content, updatedAt: entry.updatedAt };
      },
    });
  }
}
