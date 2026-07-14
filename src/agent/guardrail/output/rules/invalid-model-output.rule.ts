import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/** Provider/model artifacts that can never be a valid candidate-facing reply. */
const THINK_TAG_PATTERN = /<\/?think\s*>/i;
const OPAQUE_NUMERIC_REPLY_PATTERN = /^\d{12,}$/;

/**
 * Detect malformed model output before the outbound sanitizer removes evidence.
 *
 * `reasoning_content` is separated by the AI SDK. A `<think>` tag in visible text therefore
 * means the provider/model put reasoning markup in `content`, or returned a malformed completion.
 * Long, bare numeric identifiers are likewise not a meaningful recruiter reply.
 */
export function detectInvalidModelOutput(content: string): RuleContradiction | null {
  const text = content?.trim() ?? '';
  if (!text) return null;

  if (THINK_TAG_PATTERN.test(text)) {
    return {
      ruleId: 'invalid_model_output',
      label: '回复正文含 <think> 推理标签，属于模型/Provider 输出格式异常，必须拦截',
      action: GUARDRAIL_ACTION.BLOCK,
    };
  }

  if (OPAQUE_NUMERIC_REPLY_PATTERN.test(text)) {
    return {
      ruleId: 'invalid_model_output',
      label: '回复只有 12 位以上数字标识符，不构成可发送的候选人回复，必须拦截',
      action: GUARDRAIL_ACTION.BLOCK,
    };
  }

  return null;
}
