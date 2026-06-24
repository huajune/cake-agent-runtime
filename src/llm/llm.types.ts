export enum ModelRole {
  Chat = 'chat',
  Extract = 'extract',
  Vision = 'vision',
  Evaluate = 'evaluate',
  /** 出站 LLM 守卫（OutputGuardrail 的 llm 档，只读、隔离上下文、强模型）。 */
  Review = 'review',
}

export interface LlmThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens: number;
}
