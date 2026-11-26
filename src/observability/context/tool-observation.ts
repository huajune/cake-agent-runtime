import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentToolCall, AgentToolCallStatus } from '@shared-types/agent-telemetry.types';

export interface ToolExecutionObservation
  extends Pick<AgentToolCall, 'toolName' | 'resultCount' | 'durationMs' | 'decisions'> {
  status: AgentToolCallStatus;
}

/** 同一运行中 SDK 重用了 ID 时用 null 标记歧义，两次执行都保留独立的事件。 */
export type ToolExecutionObservations = Map<string, ToolExecutionObservation | null>;

interface ToolScope {
  toolCallId?: string;
  observation: ToolExecutionObservation;
  active: boolean;
}

const currentTool = new AsyncLocalStorage<ToolScope>();

export async function observeToolExecution<T>(
  toolCallId: string | undefined,
  observation: ToolExecutionObservation,
  execute: () => Promise<T>,
): Promise<T> {
  const scope = { toolCallId, observation, active: true };
  try {
    return await currentTool.run(scope, execute);
  } finally {
    // 工具返回后，后台定时器仍可能拥有同一异步上下文。
    scope.active = false;
  }
}

export function getObservedToolCallId(): string | undefined {
  const scope = currentTool.getStore();
  return scope?.active ? scope.toolCallId : undefined;
}

/** 在实际分支内调用。只传运行判断与短原因，不传请求正文、账号或完整外部回执。 */
export function recordToolDecision(label: string, detail: string): void {
  const scope = currentTool.getStore();
  if (!scope?.active) return;
  (scope.observation.decisions ??= []).push({ label, detail });
}
