import { tool, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ReliableService } from '@providers/reliable.service';
import { replayBlockingStatus } from '@agent/generator/tool-call-analysis';
import type { AgentError } from '@shared-types/agent-error.types';

const toolName = 'duliday_interview_booking';
const toolReplayPolicy = { toolNames: [toolName], classify: replayBlockingStatus };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const call = (id: string) => ({
  type: 'tool-call' as const,
  toolCallId: id,
  toolName,
  input: '{}',
});
const toolReply = (ids: string[]) => ({
  content: ids.map(call),
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
});
const textReply = {
  content: [{ type: 'text' as const, text: '根据现有记录核实中' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
};

function executor(model: MockLanguageModelV3) {
  const registry = { resolve: () => model };
  return new LlmExecutorService(
    { resolveRoute: () => ({ modelId: 'test/runtime', fallbacks: [] }) } as never,
    registry as never,
    new ReliableService(registry as never),
  );
}

describe('real AI SDK / local fake provider fault injection (no network)', () => {
  it('parallel duplicate tool calls dispatch once', async () => {
    const model = new MockLanguageModelV3({ doGenerate: [toolReply(['a', 'b']), textReply] });
    const execute = jest
      .fn()
      .mockResolvedValue({ actionStatus: 'succeeded', localSync: 'pending' });
    const result = await executor(model).generate({
      messages: [{ role: 'user', content: '报名' }],
      tools: { [toolName]: tool({ inputSchema: z.object({}), execute }) },
      toolReplayPolicy,
      stopWhen: stepCountIs(4),
      config: { baseBackoffMs: 0 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.steps[0].toolResults.map((item) => item.output)).toContainEqual(
      expect.objectContaining({ actionStatus: 'blocked' }),
    );
  });

  it.each(['unknown', 'succeeded'])(
    'provider retry resumes %s result and rejects a repeated model action',
    async (actionStatus) => {
      let generation = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          generation += 1;
          if (generation === 1) return toolReply(['first']);
          if (generation === 2) throw new Error('provider timeout after complete tool step');
          if (generation === 3) return toolReply(['retry']);
          return textReply;
        },
      });
      const execute = jest.fn().mockResolvedValue({ actionStatus, localSync: 'pending' });
      const result = await executor(model).generate({
        messages: [{ role: 'user', content: '报名' }],
        tools: { [toolName]: tool({ inputSchema: z.object({}), execute }) },
        toolReplayPolicy,
        stopWhen: stepCountIs(5),
        config: { baseBackoffMs: 0 },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.steps[0].toolResults[0].output).toMatchObject({ actionStatus });
      expect(result.steps[1].toolResults[0].output).toMatchObject({ actionStatus: 'blocked' });
      expect(result.stepAttempts).toEqual([1, 2, 2]);
    },
  );

  it('all model attempts fail after successful tool: error preserves success and local-pending is never resent', async () => {
    let generation = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        if (++generation === 1) return toolReply(['first']);
        throw new Error('provider timeout');
      },
    });
    const execute = jest
      .fn()
      .mockResolvedValue({ actionStatus: 'succeeded', localSync: 'pending' });
    let error: AgentError;
    try {
      await executor(model).generate({
        messages: [{ role: 'user', content: '报名' }],
        tools: { [toolName]: tool({ inputSchema: z.object({}), execute }) },
        toolReplayPolicy,
        stopWhen: stepCountIs(5),
        config: { baseBackoffMs: 0, maxRetries: 8 },
      });
    } catch (failure) {
      error = failure as AgentError;
    }
    expect(error.agentMeta.replayBlockedBy).toEqual([
      { toolName, toolCallId: 'first', status: 'succeeded' },
    ]);
    expect(error.agentMeta.totalAttempts).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generation).toBe(4); // first tool step + three failed provider text generations
  });

  it('tool result serialization fails before onStepFinish: no provider retry or fallback', async () => {
    const model = new MockLanguageModelV3({ doGenerate: toolReply(['first']) });
    const execute = jest.fn().mockResolvedValue({ actionStatus: 'succeeded' });
    await expect(
      executor(model).generate({
        messages: [{ role: 'user', content: '报名' }],
        tools: {
          [toolName]: tool({
            inputSchema: z.object({}),
            execute,
            toModelOutput: () => {
              throw new Error('serializer offline');
            },
          }),
        },
        toolReplayPolicy,
        stopWhen: stepCountIs(5),
        config: { baseBackoffMs: 0 },
      }),
    ).rejects.toMatchObject({
      agentMeta: {
        totalAttempts: 1,
        replayBlockedBy: [{ toolName, toolCallId: 'first', status: 'succeeded' }],
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
