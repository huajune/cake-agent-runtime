import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { MemoryService } from '@memory/memory.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { StageGoalConfig } from '@biz/strategy/types/strategy.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('advance_stage');

const DESCRIPTION = `推进对话阶段。当你判断本轮需要切到新阶段时调用。

## 触发时机
- 只有当你已经判断"本轮需要切阶段"时，才调用
- 若本轮判断仍停留在当前阶段，不要调用

## 执行规则
- 先完成本轮阶段预判，再决定是否调用
- 做阶段预判时，必须对照 [所有阶段概览]；它直接决定目标阶段是否选对
- 若判断仍应停留在当前阶段，不要调用
- 若判断应切到其他阶段，下一步必须立即且单独调用本工具：调用前不得输出任何候选人可见文本，不得在同一个 step 并行调用其他工具
- 必须等待本工具返回 effectiveStageStrategy，之后才能按目标阶段调用岗位查询、预约、拉群等业务工具并生成完整回复
- 阶段可以跳跃，不必按顺序逐级推进；但目标阶段必须来自动态注入的 [当前阶段策略] 和 [所有阶段概览]，不得自造阶段名
- 不要因为与当前问题无关的条件收集而阻断当前回复或阶段推进
- 不要自行附加与当前问题无关的阻塞条件，导致该推进时不推进

## 参数
- nextStage：本轮判断出的目标阶段，必须来自 [所有阶段概览]
- reason：必须写清触发信号，例如"当前阶段成功标准已达成"或"用户当前问题已明显进入面试预约相关阶段"

## 结果
- 工具会返回 newStage 对应的阶段策略快照（effectiveStageStrategy），可用于完成本轮后续回复
- 下一轮对话仍会自动注入新阶段的完整策略配置`;

const inputSchema = z.object({
  nextStage: z.string().describe('要切换到的阶段标识'),
  reason: z
    .string()
    .describe(
      '推进原因。必须写清触发信号，例如"当前阶段成功标准已达成"或"用户直接询问面试，因此切到 interview_scheduling"',
    ),
});

function buildEffectiveStageStrategy(
  stageConfig: StageGoalConfig | undefined,
): StageGoalConfig | null {
  if (!stageConfig) return null;
  return {
    stage: stageConfig.stage,
    label: stageConfig.label,
    description: stageConfig.description,
    primaryGoal: stageConfig.primaryGoal,
    successCriteria: [...stageConfig.successCriteria],
    ctaStrategy: [...stageConfig.ctaStrategy],
    disallowedActions: [...stageConfig.disallowedActions],
  };
}

/**
 * advance_stage 构建函数
 *
 * 当主模型判断当前阶段目标已达成，调用此工具切换到下一阶段。
 * 阶段状态持久化在 Redis 中，下一轮对话将注入新阶段的策略配置。
 *
 * 设计要点：
 * - 程序记忆（Procedural Memory）的唯一写入工具
 * - 允许跨阶段跳转，但 nextStage 必须是当前策略中的合法阶段
 * - 允许直接从当前阶段跳到更匹配的目标阶段，不要求线性推进
 * - advancedAt / reason 用于审计，便于追溯阶段变迁
 * - 模型跳过调用的后果：停留在当前阶段一轮 → 温和降级
 */
export function buildAdvanceStageTool(memoryService: MemoryService): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ nextStage, reason }) => {
        const stageGoals = context.stageGoals ?? {};
        const availableStages =
          context.availableStages && context.availableStages.length > 0
            ? context.availableStages
            : Object.keys(stageGoals);
        const currentStage = context.currentStage ?? null;

        // 只允许提交当前策略里真实存在的阶段，避免模型写入脏状态。
        if (availableStages.length > 0 && !availableStages.includes(nextStage)) {
          logger.warn(
            `非法阶段推进: ${nextStage} (user=${context.userId}, allowed=${availableStages.join(',')})`,
          );
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.STAGE_INVALID_TARGET,
            outcome: '阶段推进失败（目标阶段非法）',
            replyInstruction:
              '目标阶段不在策略允许列表内。基于 allowedStages 选择合法的下一阶段重试；这是工具自身的状态约束，不要向候选人提及。',
            details: {
              currentStage,
              allowedStages: availableStages,
              attemptedStage: nextStage,
            },
          });
        }

        // 如果模型把 nextStage 写成当前阶段，说明这不是"推进"，而是重复提交。
        if (currentStage && nextStage === currentStage) {
          logger.warn(`重复阶段推进: ${nextStage} (user=${context.userId})`);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.STAGE_ALREADY_AT_TARGET,
            outcome: '阶段推进失败（已处于目标阶段）',
            replyInstruction:
              '已经处于目标阶段，无需再推进。本轮按当前阶段策略继续对话，不要向候选人提及阶段状态。',
            details: { currentStage, attemptedStage: nextStage },
          });
        }

        const effectiveStageStrategy = buildEffectiveStageStrategy(stageGoals[nextStage]);

        // fromStage / currentStage / advancedAt / reason 一起落库，
        // 这样后面排查“为什么跳阶段”时，能看到完整的审计链。
        await memoryService.setStage(context.corpId, context.userId, context.sessionId, {
          currentStage: nextStage,
          fromStage: currentStage,
          advancedAt: new Date().toISOString(),
          reason,
        });

        logger.log(
          `阶段推进: ${currentStage ?? 'null'} -> ${nextStage} (user=${context.userId}, reason=${reason})`,
        );

        return {
          success: true,
          fromStage: currentStage,
          newStage: nextStage,
          effectiveStageStrategy,
        };
      },
    });
  };
}
