export enum ModelRole {
  Chat = 'chat',
  Extract = 'extract',
  Vision = 'vision',
  Evaluate = 'evaluate',
}

export interface LlmThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens: number;
}
