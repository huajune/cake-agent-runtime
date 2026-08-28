import {
  extractDialogueTurns,
  isAffirmativeAnswer,
  normalizeShortAnswer,
} from '@resolution/signal/dialogue';
import { normalizedIncludes } from './text-normalization';

const CONFIRMATION_QUESTION_RE = /(?:对吧|对吗|对么|对不对|是吗|是么|是吧|确认|核对|[吗么？?])/u;

/**
 * 验证短答确实绑定真实相邻确认问句：问句存在、具有求证语气，且下一条 user 消息为肯定答复。
 */
export function isAssistantQuestionConfirmedInDialogue(
  assistantQuestionQuote: string,
  candidateAnswerQuote: string,
  messages: readonly unknown[],
): boolean {
  const question = assistantQuestionQuote.trim();
  const answer = candidateAnswerQuote.trim();
  if (!question || !answer || !CONFIRMATION_QUESTION_RE.test(question)) return false;

  const turns = extractDialogueTurns(messages);
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].role !== 'assistant' || !normalizedIncludes(turns[i].text, question)) continue;
    for (let j = i + 1; j < turns.length; j += 1) {
      if (turns[j].role !== 'user') continue;
      return (
        normalizedIncludes(turns[j].text, answer) &&
        isAffirmativeAnswer(normalizeShortAnswer(turns[j].text))
      );
    }
  }
  return false;
}
