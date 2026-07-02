export enum ModelRole {
  Chat = 'chat',
  Extract = 'extract',
  Vision = 'vision',
  Evaluate = 'evaluate',
  /** 出站 LLM 守卫（OutputGuardrail 的 llm 档，只读、隔离上下文、强模型）。 */
  Review = 'review',
  /** 出站守卫修复器：只改写被拦截回复，不做业务规划。 */
  Repair = 'repair',
}

export interface LlmThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens: number;
}
