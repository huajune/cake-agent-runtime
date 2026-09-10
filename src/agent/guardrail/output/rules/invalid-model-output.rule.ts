import { createOutputRuleFinding } from '../output-rule-catalog';
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
 * 模拟工具往返的其余形态——只供 generator 零工具重生成消费，不进正文 BLOCK 判据
 * （XML 标记进正文已由 internal_output_leak 管）。
 *
 * 生产里模型把工具往返演在 reasoning 里的形态远不止 JSON 调用一种（14 天零工具轮：
 * JSON 调用 1 例、XML/方括号调用 4 例、回执形 JSON 3 例，后两类全部投递了假预约/假岗位）：
 * - 调用标记：`<function_calls>` / `<tool_calls>` / `<invoke name=` / `<function=…>` /
 *   `<tool_call>` / `[API 调用: geocode]`；
 * - 回执标记：`<function result>` / `</tool_response>` / `<tool_result` / `[API 返回:`；
 * - 回执形 JSON：数组内 ≥2 个对象共享 ≥3 个相同顶层键（chat 6aa0cf1e 的 `{"jobList":[…]}`）。
 *   思考不会长成同构记录表，只有工具回执会；不猜 `jobList`/`results` 之类键名。
 */
const SIMULATED_TOOL_CALL_MARKUP_PATTERN =
  /<function_calls>|<tool_calls>|<invoke\s+name=|<function[=\s][A-Za-z_]|<tool_call>|\[API 调用/u;
const SIMULATED_TOOL_RESULT_MARKUP_PATTERN =
  /<function result>|<\/tool_response>|<tool_result|\[API 返回/u;

/** 同构记录表：数组元素数与共享键数的下限。候选人贴的 proposal 数组只有单键 `properties`，不命中。 */
const RECORD_ARRAY_MIN_ITEMS = 2;
const RECORD_ARRAY_MIN_SHARED_KEYS = 3;

export function containsSimulatedToolExchange(content: string): boolean {
  const text = content?.trim() ?? '';
  if (!text) return false;
  if (containsLeakedToolCallBlob(text)) return true;
  if (SIMULATED_TOOL_CALL_MARKUP_PATTERN.test(text)) return true;
  if (SIMULATED_TOOL_RESULT_MARKUP_PATTERN.test(text)) return true;
  return containsHomogeneousRecordArray(text);
}

function containsHomogeneousRecordArray(text: string): boolean {
  const arrayStart = /\[\s*\{/gu;
  for (const match of text.matchAll(arrayStart)) {
    const start = match.index ?? 0;
    const end = findBalancedArrayEnd(text, start);
    if (end < 0) continue;
    if (isHomogeneousRecordArray(text.slice(start, end + 1))) return true;
  }
  return false;
}

/** 从 `[` 起按括号深度找到配对的 `]`（跳过字符串字面量）；不配对返回 -1。 */
function findBalancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return ch === ']' ? i : -1;
    }
  }
  return -1;
}

function isHomogeneousRecordArray(slice: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < RECORD_ARRAY_MIN_ITEMS) return false;
  const records = parsed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
  if (records.length !== parsed.length) return false;
  const shared = records
    .map((record) => new Set(Object.keys(record)))
    .reduce((acc, keys) => new Set([...acc].filter((key) => keys.has(key))));
  return shared.size >= RECORD_ARRAY_MIN_SHARED_KEYS;
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
    return createOutputRuleFinding(
      'invalid_model_output',
      '回复正文含 <think> 推理标签，属于模型/Provider 输出格式异常，必须拦截',
    );
  }

  if (containsLeakedToolCallBlob(text)) {
    return createOutputRuleFinding(
      'invalid_model_output',
      '回复正文含工具调用 JSON（协议名字键 + 入参键），说明模型把 tool-call 当文本输出；' +
        '它既不是候选人可读文本，也意味着该工具本轮并未真正执行',
    );
  }

  if (CONTROL_MARKER_ONLY_PATTERN.test(text)) {
    return createOutputRuleFinding(
      'invalid_model_output',
      '整条回复只是模型自造的「本轮不回复」控制标记（如 [NO_REPLY]），不是候选人可读文本；' +
        '沉默必须走 skip_reply 工具，标记本身绝不能投递',
    );
  }

  if (OPAQUE_NUMERIC_REPLY_PATTERN.test(text)) {
    return createOutputRuleFinding(
      'invalid_model_output',
      '回复只有 12 位以上数字标识符，不构成可发送的候选人回复，必须拦截',
    );
  }

  return null;
}
