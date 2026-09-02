import { decideLaborFormIntent, type LaborFormIntentDecision } from '@resolution/labor-form';
import type { GeneratorInputMessage, GeneratorInvokeParams } from '../generator.types';
import {
  trailingUserContent,
  trailingUserMessages,
  truncateToCharBudget,
} from './conversation-normalizer';

/** 无 IO 的本轮输入视图；后续 Loader、Resolver 与工具运行时共享同一份结果。 */
export interface NormalizedTurnInput {
  truncatedMessages: GeneratorInputMessage[];
  currentUserMessage: string | undefined;
  currentTurnTexts: string[];
  laborFormIntent: LaborFormIntentDecision;
}

/**
 * 统一完成字符预算和“当前轮”识别。
 *
 * 当前轮不是最后一条消息，而是上一条 assistant 之后连续出现的全部 user 消息；企微
 * debounce/replay 与测试套件多条连发都依赖这个定义。
 */
export function normalizeTurnInput(
  params: Pick<GeneratorInvokeParams, 'messages'>,
  sessionWindowMaxChars: number,
): NormalizedTurnInput {
  const truncatedMessages = truncateToCharBudget(params.messages, sessionWindowMaxChars);
  const currentUserMessage = trailingUserContent(truncatedMessages);
  return {
    truncatedMessages,
    currentUserMessage,
    currentTurnTexts: trailingUserMessages(truncatedMessages),
    laborFormIntent: decideLaborFormIntent(currentUserMessage),
  };
}
