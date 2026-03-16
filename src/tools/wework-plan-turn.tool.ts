/**
 * 企微对话阶段规划工具
 *
 * 识别当前对话阶段（stage）、检测回复需求（needs）、标记风险因子（riskFlags），
 * 并从 stageGoals 配置中查找当前阶段的运营目标（stageGoal）。
 *
 * 迁移自 agent/tools/wework-plan-turn.tool.ts + agent/services/classification-agent.service.ts
 * 改造：实现 ToolFactory 接口，classification 逻辑内联
 */

import { Injectable, Logger } from '@nestjs/common';
import { tool, generateText, Output } from 'ai';
import { z } from 'zod';
import { RouterService } from '@providers/router.service';
import { AiTool, ToolBuildContext, ToolFactory } from './tool.types';
import {
  FunnelStageSchema,
  ChannelTypeSchema,
  TurnPlanSchema,
  STAGE_DEFINITIONS,
  NEED_RULES,
  type TurnPlan,
  type ReplyNeed,
  type FunnelStage,
  type ChannelType,
  type StageGoals,
  type WeworkPlanTurnOutput,
} from '@channels/wecom/types/wework.types';

// ==================== 辅助函数（内联自 classification-agent） ====================

function normalizeChannelType(channelType: unknown): ChannelType {
  const parsed = ChannelTypeSchema.safeParse(channelType);
  return parsed.success ? parsed.data : 'public';
}

function getActiveStages(channelType: unknown = 'public'): FunnelStage[] {
  const normalized = normalizeChannelType(channelType);
  const activeStages = FunnelStageSchema.options.filter((stage) =>
    STAGE_DEFINITIONS[stage].applicableChannels.includes(normalized),
  );
  return activeStages.length > 0 ? activeStages : [...FunnelStageSchema.options];
}

function buildDynamicPlanningSchema(activeStages: FunnelStage[]) {
  return z.object({
    stage: z.enum(activeStages as [FunnelStage, ...FunnelStage[]]),
    subGoals: TurnPlanSchema.shape.subGoals,
    needs: TurnPlanSchema.shape.needs,
    riskFlags: TurnPlanSchema.shape.riskFlags,
    confidence: TurnPlanSchema.shape.confidence,
    extractedInfo: TurnPlanSchema.shape.extractedInfo,
    reasoningText: TurnPlanSchema.shape.reasoningText,
  });
}

function detectRuleNeeds(message: string, history: string[]): Set<ReplyNeed> {
  const text = `${history.slice(-4).join(' ')} ${message}`;
  const needs = new Set<ReplyNeed>();

  for (const rule of NEED_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      needs.add(rule.need);
    }
  }

  if (needs.size === 0) {
    needs.add('none');
  } else {
    needs.delete('none');
  }

  return needs;
}

function sanitizePlan(plan: TurnPlan, ruleNeeds: Set<ReplyNeed>): TurnPlan {
  const mergedNeeds = new Set<ReplyNeed>([...plan.needs, ...Array.from(ruleNeeds)]);
  if (mergedNeeds.size > 1 && mergedNeeds.has('none')) {
    mergedNeeds.delete('none');
  }

  return {
    ...plan,
    needs: Array.from(mergedNeeds),
    confidence: Number.isFinite(plan.confidence) ? Math.max(0, Math.min(1, plan.confidence)) : 0.5,
  };
}

interface PlanningPromptOptions {
  message: string;
  history: string[];
  channelType: ChannelType;
  stageGoals?: StageGoals;
}

function buildPlanningPrompt(opts: PlanningPromptOptions): { system: string; prompt: string } {
  const { message, history, channelType, stageGoals } = opts;

  const system = [
    '你是招聘对话回合规划器，不直接回复候选人。',
    '你只输出结构化规划结果，用于后续回复生成。',
    '规划目标：确定阶段目标(stage)、子目标(subGoals)、事实需求(needs)、风险标记(riskFlags)。',
  ].join('\n');

  const activeStages = getActiveStages(channelType);

  const stageLines = activeStages.map((stage) => {
    const def = STAGE_DEFINITIONS[stage];
    const desc = stageGoals?.[stage]?.description ?? def.description;
    return `- ${stage}: ${desc} (转入条件: ${def.transitionSignal})`;
  });

  const needsLine =
    channelType === 'private'
      ? '- stores, location, salary, schedule, policy, availability, requirements, interview, none'
      : '- stores, location, salary, schedule, policy, availability, requirements, interview, wechat, none';

  const prompt = [
    '[阶段枚举与定义]',
    ...stageLines,
    '',
    '[needs枚举]',
    needsLine,
    '',
    '[riskFlags枚举]',
    '- insurance_promise_risk, age_sensitive, confrontation_emotion, urgency_high, qualification_mismatch',
    '',
    '[规则]',
    '- 优先判断本轮主阶段(stage)；subGoals 可多项。',
    '- 候选人追问事实时，必须打开对应 needs。',
    '- 不确定时 confidence 降低，不要臆断。',
    '- 根据转入条件判断阶段转化，不要停留在不匹配的阶段。',
    '',
    '[历史对话]',
    history.slice(-8).join('\n') || '无',
    '',
    '[候选人消息]',
    message,
  ].join('\n');

  return { system, prompt };
}

// ==================== 服务 ====================

@Injectable()
export class WeworkPlanTurnToolService implements ToolFactory {
  readonly toolName = 'wework_plan_turn';
  readonly toolDescription =
    '企微智能化：识别当前对话阶段、检测回复需求、标记风险因子，并返回当前阶段的运营目标配置';

  private readonly logger = new Logger(WeworkPlanTurnToolService.name);

  constructor(private readonly router: RouterService) {}

  buildTool(context: ToolBuildContext): AiTool {
    const stageGoals = (context.stageGoals ?? {}) as StageGoals;

    return tool({
      description: this.toolDescription,
      inputSchema: z.object({}),
      execute: async (): Promise<WeworkPlanTurnOutput> => {
        // 从 messages 提取对话历史
        const allHistory = context.messages
          .filter(
            (m): m is { role: string; content: unknown } =>
              typeof m === 'object' &&
              m !== null &&
              'role' in m &&
              ((m as { role: string }).role === 'user' ||
                (m as { role: string }).role === 'assistant'),
          )
          .map((m) => {
            const parts = m.content;
            const text =
              typeof parts === 'string'
                ? parts
                : Array.isArray(parts)
                  ? parts
                      .filter(
                        (p): p is { type: 'text'; text: string } =>
                          typeof p === 'object' && p !== null && 'type' in p && p.type === 'text',
                      )
                      .map((p) => p.text)
                      .join('')
                  : '';
            return `${m.role === 'user' ? '用户' : '助手'}: ${text}`;
          })
          .filter((s) => s.trim().length > 0);

        const message = allHistory.at(-1) ?? '';
        const conversationHistory = allHistory.slice(0, -1);

        const fullPlan = await this.planTurn({
          message,
          conversationHistory,
          channelType: normalizeChannelType(context.channelType),
          stageGoals,
        });

        const currentStageGoal = stageGoals[fullPlan.stage];

        if (!currentStageGoal) {
          this.logger.warn('Stage goal not found: ' + fullPlan.stage);
        }

        return {
          stage: fullPlan.stage,
          needs: fullPlan.needs,
          riskFlags: fullPlan.riskFlags,
          confidence: fullPlan.confidence,
          reasoning: fullPlan.reasoningText,
          stageGoal: currentStageGoal ?? {
            primaryGoal: '保持对话',
            successCriteria: ['候选人愿意继续沟通'],
            ctaStrategy: '用轻量提问引导需求细化',
          },
        };
      },
    });
  }

  /**
   * 回合规划：规则优先 + LLM 补充（内联自 ClassificationAgentService）
   */
  private async planTurn(opts: {
    message: string;
    conversationHistory: string[];
    channelType: ChannelType;
    stageGoals?: StageGoals;
  }): Promise<TurnPlan> {
    const { message, conversationHistory = [], channelType = 'private', stageGoals } = opts;

    const normalizedChannelType = normalizeChannelType(channelType);
    const ruleNeeds = detectRuleNeeds(message, conversationHistory);

    this.logger.debug('规则检测: ' + Array.from(ruleNeeds).join(', '));

    const activeStages = getActiveStages(normalizedChannelType);
    const dynamicSchema = buildDynamicPlanningSchema(activeStages);
    const prompts = buildPlanningPrompt({
      message,
      history: conversationHistory,
      channelType: normalizedChannelType,
      stageGoals,
    });

    try {
      const classifyModel = this.router.resolveByRole('classify');

      const result = await generateText({
        model: classifyModel,
        system: prompts.system,
        prompt: prompts.prompt,
        output: Output.object({
          schema: dynamicSchema,
          name: 'TurnPlanningOutput',
        }),
      });

      const plan = result.output as TurnPlan;
      const sanitized = sanitizePlan(plan, ruleNeeds);

      this.logger.log(
        `规划完成: stage=${sanitized.stage}, needs=[${sanitized.needs.join(',')}], ` +
          `confidence=${sanitized.confidence}`,
      );

      return sanitized;
    } catch (err) {
      this.logger.warn('LLM分类失败，使用规则降级', err);

      return {
        stage: 'trust_building',
        subGoals: ['保持对话并澄清需求'],
        needs: Array.from(ruleNeeds),
        riskFlags: [],
        confidence: 0.35,
        extractedInfo: {
          mentionedBrand: null,
          city: null,
          mentionedLocations: null,
          mentionedDistricts: null,
          specificAge: null,
          hasUrgency: null,
          preferredSchedule: null,
        },
        reasoningText: '规划模型失败，使用规则降级策略',
      };
    }
  }
}
