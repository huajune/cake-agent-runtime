import type { ToolSet } from 'ai';
import type { ToolReplayEvidence, ToolReplayStatus } from '@shared-types/tool-replay.types';

/** Caller supplies semantics; the provider layer knows no business tool names. */
export interface ToolReplayPolicy {
  toolNames: readonly string[];
  classify: (result: unknown) => ToolReplayStatus | undefined;
  classifyAll?: (result: unknown) => Array<Pick<ToolReplayEvidence, 'status' | 'component'>>;
}

type CompletedStep = {
  toolResults?: Array<{ toolName?: string; toolCallId?: string; output?: unknown }>;
};

/** Per generate() scope, shared across model attempts and parallel calls in one SDK step. */
export class ToolReplayFence {
  private readonly evidenceByCall = new Map<string, ToolReplayEvidence[]>();
  private readonly blockedNames = new Set<string>();
  private anonymousCall = 0;

  constructor(private readonly policy?: ToolReplayPolicy) {}

  wrap(tools: ToolSet | undefined): ToolSet | undefined {
    if (!tools || !this.policy) return tools;
    const names = new Set(this.policy.toolNames);
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        if (!names.has(name) || !tool.execute) return [name, tool];
        const execute = tool.execute;
        return [
          name,
          {
            ...tool,
            execute: async (...args: Parameters<typeof execute>) => {
              if (this.blockedNames.has(name)) {
                return {
                  actionStatus: 'blocked',
                  actionDispatched: false,
                  actionReason: 'same_turn_action_replay_blocked',
                  replyInstruction:
                    '本轮已有动作正在执行、结果未知或已完成；禁止再次提交。请按原动作证据收敛，未知结果交统一核实恢复，不能宣称成功或失败。',
                };
              }
              // Set before awaiting: activeTools alone cannot stop two calls in the same SDK step.
              this.blockedNames.add(name);
              const toolCallId = args[1]?.toolCallId;
              const key = JSON.stringify([name, toolCallId ?? `anonymous:${++this.anonymousCall}`]);
              const evidence: ToolReplayEvidence = {
                toolName: name,
                toolCallId,
                status: 'executing',
              };
              this.evidenceByCall.set(key, [evidence]);
              try {
                const result = await execute(...args);
                const components = this.classify(result);
                if (components.length)
                  this.evidenceByCall.set(
                    key,
                    components.map((item) => ({ toolName: name, toolCallId, ...item })),
                  );
                else {
                  this.evidenceByCall.delete(key);
                  this.blockedNames.delete(name); // explicit no-effect failure; existing self-correction only
                }
                return result;
              } catch (error) {
                evidence.status = 'unknown';
                throw error;
              }
            },
          },
        ];
      }),
    );
  }

  /** Also capture completed results supplied by SDK hooks (including test/custom tool adapters). */
  observe(steps: CompletedStep[]): void {
    if (!this.policy) return;
    for (const step of steps) {
      for (const result of step.toolResults ?? []) {
        if (!result.toolName || !this.policy.toolNames.includes(result.toolName)) continue;
        const components = this.classify(result.output);
        if (!components.length) continue;
        const key = JSON.stringify([result.toolName, result.toolCallId ?? 'completed']);
        // A provider can reuse a toolCallId. A synthetic blocked duplicate must not erase
        // the original execution's success/unknown evidence.
        if (this.evidenceByCall.has(key)) continue;
        this.evidenceByCall.set(
          key,
          components.map((item) => ({
            toolName: result.toolName!,
            toolCallId: result.toolCallId,
            ...item,
          })),
        );
        this.blockedNames.add(result.toolName);
      }
    }
  }

  private classify(result: unknown): Array<Pick<ToolReplayEvidence, 'status' | 'component'>> {
    if (this.policy?.classifyAll) return this.policy.classifyAll(result);
    const status = this.policy?.classify(result);
    return status ? [{ status }] : [];
  }

  snapshot(): ToolReplayEvidence[] {
    return [...this.evidenceByCall.values()].flat().map((item) => ({ ...item }));
  }

  /** A started action without a complete tool response cannot be recovered by model retry. */
  hasUnresumableAction(steps: CompletedStep[]): boolean {
    const completed = new Set(
      steps.flatMap((step) =>
        (step.toolResults ?? [])
          .filter((result) => result.toolName && result.toolCallId)
          .map((result) => JSON.stringify([result.toolName, result.toolCallId])),
      ),
    );
    return this.snapshot().some(
      (item) =>
        !item.toolCallId || !completed.has(JSON.stringify([item.toolName, item.toolCallId])),
    );
  }
}
