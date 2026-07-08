import type { AgentToolCall } from '@agent/generator/generator.types';

export interface OutputRuleTransform {
  ruleId: string;
  apply(text: string, toolCalls: AgentToolCall[]): string | null;
}
