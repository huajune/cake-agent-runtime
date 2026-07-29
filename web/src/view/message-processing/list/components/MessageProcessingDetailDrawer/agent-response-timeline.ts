export interface AgentTimelineToolCall {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: string;
}

export interface AgentTimelineStep {
  stepIndex: number;
  reasoning?: string;
  toolCalls?: AgentTimelineToolCall[];
}

export type AgentTimelinePart =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | {
      type: `tool-${string}`;
      toolName: string;
      toolCallId: string;
      input?: unknown;
      output?: unknown;
      state: 'input-available' | 'output-available' | 'output-error';
    };

function buildToolPart(
  toolCall: AgentTimelineToolCall,
  stepIndex: number | string,
  toolIndex: number,
): AgentTimelinePart {
  const output = toolCall.result;
  return {
    type: `tool-${toolCall.toolName}`,
    toolName: toolCall.toolName,
    toolCallId: `${toolCall.toolName}-${stepIndex}-${toolIndex}`,
    input: toolCall.args,
    output,
    state:
      toolCall.status === 'error'
        ? 'output-error'
        : output !== undefined
          ? 'output-available'
          : 'input-available',
  };
}

function buildStepParts(steps: AgentTimelineStep[]): AgentTimelinePart[] {
  return [...steps]
    .sort((left, right) => left.stepIndex - right.stepIndex)
    .flatMap<AgentTimelinePart>((step) => {
      const parts: AgentTimelinePart[] = [];
      if (step.reasoning?.trim()) {
        parts.push({ type: 'reasoning', text: step.reasoning });
      }
      (step.toolCalls ?? []).forEach((toolCall, toolIndex) => {
        parts.push(buildToolPart(toolCall, step.stepIndex, toolIndex));
      });
      return parts;
    });
}

function hasToolPart(parts: AgentTimelinePart[]): boolean {
  return parts.some((part) => part.type.startsWith('tool-'));
}

function insertToolsBeforeFinalReasoning(
  parts: AgentTimelinePart[],
  toolParts: AgentTimelinePart[],
): void {
  let finalReasoningIndex = -1;
  parts.forEach((part, index) => {
    if (part.type === 'reasoning') finalReasoningIndex = index;
  });
  const insertAt = finalReasoningIndex >= 0 ? finalReasoningIndex : parts.length;
  parts.splice(insertAt, 0, ...toolParts);
}

export function buildAgentResponseTimeline(params: {
  steps?: AgentTimelineStep[];
  responseParts?: AgentTimelinePart[];
  directToolCalls?: AgentTimelineToolCall[];
  finalReasoning?: string;
  finalText?: string;
}): AgentTimelinePart[] {
  const stepParts = buildStepParts(params.steps ?? []);
  const responseParts = params.responseParts ?? [];
  const processParts =
    stepParts.length > 0 ? stepParts : responseParts.filter((part) => part.type !== 'text');
  const fallbackTextParts = responseParts.filter((part) => part.type === 'text');
  const parts = [...processParts];

  if (!hasToolPart(parts) && params.directToolCalls?.length) {
    const directToolParts = params.directToolCalls.map((toolCall, toolIndex) =>
      buildToolPart(toolCall, 'direct', toolIndex),
    );
    insertToolsBeforeFinalReasoning(parts, directToolParts);
  }

  if (
    params.finalReasoning?.trim() &&
    !parts.some((part) => part.type === 'reasoning' && part.text === params.finalReasoning)
  ) {
    parts.push({ type: 'reasoning', text: params.finalReasoning });
  }

  if (params.finalText?.trim()) {
    parts.push({ type: 'text', text: params.finalText });
  } else {
    parts.push(...fallbackTextParts);
  }

  return parts;
}
