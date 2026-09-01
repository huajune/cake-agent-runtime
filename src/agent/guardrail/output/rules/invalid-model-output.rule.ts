import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/** Provider/model artifacts that can never be a valid candidate-facing reply. */
const THINK_TAG_PATTERN = /<\/?think\s*>/i;
const OPAQUE_NUMERIC_REPLY_PATTERN = /^\d{12,}$/;
/**
 * 模型自造的「本轮不回复」控制标记。沉默的唯一合法出口是 skip_reply 工具；模型改用
 * 一个方括号标记表达同样意图时，它会被当正文整段投递给候选人（候选人只看到一句乱码）。
 *
 * 只认整条回复就是该标记的形态——正文里出现方括号内容属正常话术，不命中。
 */
const CONTROL_MARKER_ONLY_PATTERN =
  /^[[［【(（]\s*(?:no[\s_-]*reply|no[\s_-]*response|skip(?:[\s_-]*reply)?|silence|silent|empty|none|null)\s*[\]］】)）]$/i;

/**
 * 工具调用协议的文本化泄漏：模型没走 tool-call 通道，把调用当 JSON 文本写了出来。
 *
 * 判据取协议专属的**键名对**（名字键 + 入参键落在同一 blob 内），不取工具名清单——
 * 清单会随注册表漂移，MCP 动态工具也不在任何静态表里。裸 `name` 刻意不收：普通 JSON
 * 里太常见，会误伤候选人贴进来的结构化文本。
 *
 * 两个消费点共用本判据：出站守卫查正文（泄漏进候选人可见文本即 BLOCK），generator
 * 查 reasoning（零工具调用时说明该调用根本没发生，需重生成）。
 */
const TOOL_CALL_NAME_KEY_PATTERN =
  /"(?:tool_name|toolName|tool_use|function_call|recipient_name)"\s*:\s*"[A-Za-z_][\w.-]{2,63}"/gu;
const TOOL_CALL_ARGS_KEY_PATTERN = /"(?:arguments|parameters|args|tool_input|input)"\s*:\s*[{[]/u;

/** 名字键与入参键必须同属一个 blob；相隔整段各出现一次不算泄漏。 */
const TOOL_CALL_BLOB_SPAN = 400;

export function containsLeakedToolCallBlob(content: string): boolean {
  const text = content?.trim() ?? '';
  if (!text) return false;

  for (const match of text.matchAll(TOOL_CALL_NAME_KEY_PATTERN)) {
    const start = match.index ?? 0;
    const span = text.slice(
      Math.max(0, start - TOOL_CALL_BLOB_SPAN),
      start + match[0].length + TOOL_CALL_BLOB_SPAN,
    );
    if (TOOL_CALL_ARGS_KEY_PATTERN.test(span)) return true;
  }
  return false;
}

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

  if (containsLeakedToolCallBlob(text)) {
    return {
      ruleId: 'invalid_model_output',
      label:
        '回复正文含工具调用 JSON（协议名字键 + 入参键），说明模型把 tool-call 当文本输出；' +
        '它既不是候选人可读文本，也意味着该工具本轮并未真正执行',
      action: GUARDRAIL_ACTION.BLOCK,
    };
  }

  if (CONTROL_MARKER_ONLY_PATTERN.test(text)) {
    return {
      ruleId: 'invalid_model_output',
      label:
        '整条回复只是模型自造的「本轮不回复」控制标记（如 [NO_REPLY]），不是候选人可读文本；' +
        '沉默必须走 skip_reply 工具，标记本身绝不能投递',
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
