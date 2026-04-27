import type { UIMessage } from 'ai';
import type { ToolCall } from '../types';

type UiPart = UIMessage['parts'][number];

interface AgentStepSummary {
  reasoning?: string;
  reasoningText?: string;
  text?: string;
  toolCalls?: unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildTextPart(text: string): UiPart {
  return { type: 'text', text } as UiPart;
}

function buildReasoningPart(text: string): UiPart {
  return { type: 'reasoning', text } as UiPart;
}

function getToolCallName(tool: unknown, fallbackIndex: number): string {
  const record = asRecord(tool);
  return (
    asNonEmptyString(record?.toolName) ||
    asNonEmptyString(record?.tool) ||
    asNonEmptyString(record?.name) ||
    `tool-${fallbackIndex + 1}`
  );
}

function buildToolPart(tool: unknown, index: number): UiPart {
  const record = asRecord(tool) || {};
  const toolName = getToolCallName(record, index);
  const errorText = asNonEmptyString(record.errorText) || asNonEmptyString(record.error);
  const output = record.output ?? record.result ?? (errorText ? { error: errorText } : undefined);
  const explicitState = asNonEmptyString(record.state);
  const state =
    errorText ||
    explicitState === 'error' ||
    explicitState === 'output-error' ||
    explicitState === 'input-error' ||
    explicitState === 'output-denied'
      ? 'output-error'
      : output !== undefined || explicitState === 'output-available'
        ? 'output-available'
        : 'input-available';

  return {
    type: `tool-${toolName}`,
    toolName,
    toolCallId: asNonEmptyString(record.toolCallId) || `${toolName}-${index}`,
    input: record.input ?? record.args ?? record.arguments,
    output,
    state,
    errorText,
  } as UiPart;
}

function normalizeAgentPart(part: unknown, index: number): UiPart | null {
  const record = asRecord(part);
  const partType = asNonEmptyString(record?.type);
  if (!record || !partType) return null;

  if (partType === 'text') {
    const text = asNonEmptyString(record.text);
    return text ? buildTextPart(text) : null;
  }

  if (partType === 'reasoning') {
    const text = asNonEmptyString(record.text);
    return text ? buildReasoningPart(text) : null;
  }

  if (partType === 'dynamic-tool' || partType.startsWith('tool-')) {
    return buildToolPart(
      {
        ...record,
        toolName: record.toolName || partType.replace(/^tool-/, ''),
      },
      index,
    );
  }

  if (partType === 'tool-call' || partType === 'tool-result' || partType === 'tool-error') {
    return buildToolPart(record, index);
  }

  return null;
}

function collectAgentStepParts(response: Record<string, unknown>): UiPart[] {
  const steps = Array.isArray(response.agentSteps) ? response.agentSteps : [];
  const parts: UiPart[] = [];

  steps.forEach((step, stepIndex) => {
    const record = asRecord(step) as AgentStepSummary | undefined;
    if (!record) return;

    const reasoning = asNonEmptyString(record.reasoning) || asNonEmptyString(record.reasoningText);
    if (reasoning) {
      parts.push(buildReasoningPart(reasoning));
    }

    if (Array.isArray(record.toolCalls)) {
      const toolBaseIndex = parts.length;
      record.toolCalls.forEach((tool, toolIndex) => {
        parts.push(buildToolPart(tool, toolBaseIndex + toolIndex));
      });
    }

    const text = asNonEmptyString(record.text);
    if (text) {
      parts.push(buildTextPart(text));
    }

    if (parts.length === 0 && stepIndex === steps.length - 1) {
      const fallbackText = asNonEmptyString(response.text);
      if (fallbackText) parts.push(buildTextPart(fallbackText));
    }
  });

  return parts;
}

function collectOrderedAgentParts(agentResponse: unknown): UiPart[] {
  const response = asRecord(agentResponse);
  if (!response) return [];

  const parts: UiPart[] = [];
  const pushParts = (value: unknown) => {
    if (!Array.isArray(value)) return;
    const baseIndex = parts.length;
    value.forEach((part, index) => {
      const normalized = normalizeAgentPart(part, baseIndex + index);
      if (normalized) parts.push(normalized);
    });
  };

  pushParts(response.parts);

  if (Array.isArray(response.messages)) {
    response.messages.forEach((message) => {
      const record = asRecord(message);
      if (!record || (record.role && record.role !== 'assistant')) return;
      pushParts(record.parts);
    });
  }

  if (parts.length === 0) {
    parts.push(...collectAgentStepParts(response));
  }

  return parts;
}

function hasPartType(parts: UiPart[], type: 'text' | 'reasoning') {
  return parts.some((part) => part.type === type);
}

function hasToolPart(parts: UiPart[]) {
  return parts.some((part) => typeof part.type === 'string' && part.type.startsWith('tool-'));
}

function hasEquivalentTextPart(parts: UiPart[], text: string) {
  const normalizedText = text.trim();
  if (!normalizedText) return true;

  return parts.some((part) => {
    if (part.type !== 'text') return false;
    const partText = (part as { text?: string }).text?.trim();
    return partText === normalizedText;
  });
}

function extractReasoningBlocks(agentResponse: unknown): string[] {
  const response = asRecord(agentResponse);
  if (!response) return [];

  const blocks: string[] = [];

  const pushReasoning = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text) blocks.push(text);
  };

  pushReasoning(response.reasoning);
  pushReasoning(response.reasoningPreview);

  if (response.reply && typeof response.reply === 'object') {
    pushReasoning((response.reply as Record<string, unknown>).reasoning);
  }

  const possibleSteps = Array.isArray(response.agentSteps)
    ? response.agentSteps
    : Array.isArray(response.steps)
      ? response.steps
      : [];

  possibleSteps.forEach((step) => {
    const record = asRecord(step);
    if (!record) return;
    pushReasoning(record.reasoning);
    pushReasoning(record.reasoningText);
  });

  if (Array.isArray(response.messages)) {
    response.messages.forEach((message) => {
      const record = asRecord(message);
      if (!record) return;
      const parts = record.parts;
      if (!Array.isArray(parts)) return;
      parts.forEach((part) => {
        const item = asRecord(part);
        if (item?.type === 'reasoning') pushReasoning(item.text);
      });
    });
  }

  return Array.from(new Set(blocks));
}

function buildSyntheticAgentParts(
  agentResponse: unknown,
  toolCalls: ToolCall[],
  actualOutput: string,
): UiPart[] {
  const parts: UiPart[] = [];
  const reasoningBlocks = extractReasoningBlocks(agentResponse);
  let nextToolIndex = 0;

  reasoningBlocks.forEach((reasoning) => {
    parts.push(buildReasoningPart(reasoning));
    if (nextToolIndex < toolCalls.length) {
      parts.push(buildToolPart(toolCalls[nextToolIndex], nextToolIndex));
      nextToolIndex += 1;
    }
  });

  while (nextToolIndex < toolCalls.length) {
    parts.push(buildToolPart(toolCalls[nextToolIndex], nextToolIndex));
    nextToolIndex += 1;
  }

  if (actualOutput.trim()) {
    parts.push(buildTextPart(actualOutput.trim()));
  }

  return parts;
}

export function buildAgentRenderableMessage(
  agentResponse: unknown,
  toolCalls: ToolCall[],
  actualOutput: string,
  executionId: string,
): UIMessage | undefined {
  const orderedParts = collectOrderedAgentParts(agentResponse);
  const directToolParts = toolCalls.map((tool, index) => buildToolPart(tool, index));
  const replyText = actualOutput.trim();

  if (orderedParts.length > 0) {
    const enrichedParts = [...orderedParts];

    if (directToolParts.length > 0 && !hasToolPart(enrichedParts)) {
      const firstTextIndex = enrichedParts.findIndex((part) => part.type === 'text');
      if (firstTextIndex >= 0) {
        enrichedParts.splice(firstTextIndex, 0, ...directToolParts);
      } else {
        enrichedParts.push(...directToolParts);
      }
    }

    if (replyText && !hasEquivalentTextPart(enrichedParts, replyText)) {
      enrichedParts.push(buildTextPart(replyText));
    }

    return {
      id: `test-suite-agent-${executionId}`,
      role: 'assistant',
      parts: enrichedParts,
    } as UIMessage;
  }

  const syntheticParts = buildSyntheticAgentParts(agentResponse, toolCalls, replyText);
  if (syntheticParts.length === 0) return undefined;

  if (!hasPartType(syntheticParts, 'text') && replyText) {
    syntheticParts.push(buildTextPart(replyText));
  }

  return {
    id: `test-suite-agent-${executionId}`,
    role: 'assistant',
    parts: syntheticParts,
  } as UIMessage;
}
