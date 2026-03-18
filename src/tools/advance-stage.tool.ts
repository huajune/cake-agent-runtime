import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('advance_stage');

/**
 * advance_stage 构建函数
 *
 * 当主模型判断当前阶段目标已达成，调用此工具切换到下一阶段。
 * 阶段状态持久化在 Redis 中，下一轮对话将注入新阶段的策略配置。
 *
 * 设计要点：
 * - Stage key 独立于 session memory（stage:{corpId}:{userId}）
 * - reason 字段用于审计，便于追溯阶段变迁
 * - 模型跳过调用的后果：停留在当前阶段一轮 → 温和降级
 */
export function buildAdvanceStageTool(memoryService: MemoryService): ToolBuilder {
  return (context) => {
    return tool({
      description: '推进对话阶段。当你判断当前阶段目标已达成，调用此工具切换到下一阶段。',
      inputSchema: z.object({
        nextStage: z.string().describe('要切换到的阶段标识'),
        reason: z.string().describe('推进原因（简要说明为什么当前阶段目标已达成）'),
      }),
      execute: async ({ nextStage, reason }) => {
        const stageKey = `stage:${context.corpId}:${context.userId}:${context.sessionId}`;

        await memoryService.store(stageKey, {
          currentStage: nextStage,
          advancedAt: new Date().toISOString(),
          reason,
        });

        logger.log(`阶段推进: ${nextStage} (user=${context.userId}, reason=${reason})`);

        return { success: true, newStage: nextStage };
      },
    });
  };
}
