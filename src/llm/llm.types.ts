export enum ModelRole {
  Chat = 'chat',
  Extract = 'extract',
  /** 简历字段抽取；独立于会话事实提取，允许 Dashboard 单独切换模型。 */
  ResumeExtract = 'resume_extract',
  Vision = 'vision',
  Evaluate = 'evaluate',
  /** 出站 LLM 守卫（OutputGuardrail 的 llm 档，只读、隔离上下文、强模型）。 */
  Review = 'review',
  /** 出站守卫修复器：只改写被拦截回复，不做业务规划。 */
  Repair = 'repair',
}

/**
 * 深度思考档位（各 provider 能力交集：anthropic effort / openai reasoningEffort /
 * google thinkingLevel / deepseek reasoningEffort / qwen reasoningEffort 均支持这三档）。
 * provider 专有的 minimal/xhigh/max 等档位刻意不纳入，保证配置可跨模型迁移。
 */
export const LLM_THINKING_EFFORTS = ['low', 'medium', 'high'] as const;
export type LlmThinkingEffort = (typeof LLM_THINKING_EFFORTS)[number];

export interface LlmThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens: number;
  /** 深度思考档位；仅 type='enabled' 时生效，缺省按 high（保持历史行为）。 */
  effort?: LlmThinkingEffort;
}
