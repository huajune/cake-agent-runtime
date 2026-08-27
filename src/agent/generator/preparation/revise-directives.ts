import { type GeneratorInvokeParams } from '../generator.types';

/**
 * reengagement 主动回合的 prompt 指令构建（纯函数）。
 *
 * 由 PreparationService 在组装 finalPrompt 时调用；被动回合返回空串，不产生任何影响。
 *
 * 现行修复链路由独立的 ReplyRepairAgent 承担，不经 generator 重生成；本文件只负责
 * 主动回合 directive。
 */

/**
 * reengagement 主动回合 directive 注入。
 *
 * 告诉模型本回合是系统发起的主动跟进、目标是什么；话术由模型按记忆/上下文实时生成。
 * 强调主动回合的边界：只提醒/答疑，不替候选人报名/拉群（副作用工具已由 toolMode:'readonly'
 * 物理移除，这里再用 prompt 重申，双保险）。被动回合不传，返回空串。
 */
export function buildProactiveDirective(params: GeneratorInvokeParams): string {
  const directive = params.proactiveDirective?.trim();
  if (!directive) return '';
  return (
    `\n\n# 主动跟进回合（reengagement）\n` +
    `本回合不是候选人发来的消息，而是系统按既定场景发起的主动跟进。跟进目标：${directive}\n` +
    `要求：① 自然、简短、不骚扰，像真人招募经理顺手关心一句；② 只做提醒/答疑，` +
    `严禁替候选人报名/拉群/改约（这些动作只能由候选人本人在后续对话里推进）；` +
    `③ 若记忆显示候选人已报名/已转人工/已明确拒绝，则不要发起跟进。`
  );
}
