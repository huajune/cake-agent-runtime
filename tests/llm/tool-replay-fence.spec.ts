import { tool } from 'ai';
import { z } from 'zod';
import { ToolReplayFence } from '@/llm/tool-replay-fence';
import {
  replayBlockingStatus,
  replayBlockingComponents,
  collectToolReplayEvidence,
} from '@agent/generator/tool-call-analysis';

const name = 'duliday_interview_booking';
const options = (toolCallId: string) => ({ toolCallId, messages: [], context: undefined });
const policy = {
  toolNames: [name],
  classify: replayBlockingStatus,
  classifyAll: replayBlockingComponents,
};

describe('SDK execution fence', () => {
  it('concurrent same-step calls cannot both enter the actual tool', async () => {
    let complete: (value: unknown) => void;
    const execute = jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const fence = new ToolReplayFence(policy);
    const wrapped = fence.wrap({ [name]: tool({ inputSchema: z.object({}), execute }) });
    const first = wrapped[name].execute({}, options('first'));
    const second = await wrapped[name].execute({}, options('second'));
    expect(second).toMatchObject({ actionStatus: 'blocked', actionDispatched: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fence.hasUnresumableAction([])).toBe(true);
    complete({ actionStatus: 'succeeded', localSync: 'pending' });
    await first;
    expect(fence.snapshot()).toEqual([
      { toolName: name, toolCallId: 'first', status: 'succeeded' },
    ]);
  });

  it('a repeated provider callId cannot overwrite the original success with synthetic blocked', async () => {
    const execute = jest.fn().mockResolvedValue({ actionStatus: 'succeeded' });
    const fence = new ToolReplayFence(policy);
    const wrapped = fence.wrap({ [name]: tool({ inputSchema: z.object({}), execute }) });
    await wrapped[name].execute({}, options('same-id'));
    const duplicate = await wrapped[name].execute({}, options('same-id'));
    fence.observe([
      { toolResults: [{ toolName: name, toolCallId: 'same-id', output: duplicate }] },
    ]);
    expect(fence.snapshot()).toEqual([
      { toolName: name, toolCallId: 'same-id', status: 'succeeded' },
    ]);
    expect(
      fence.hasUnresumableAction([
        { toolResults: [{ toolName: 'other_tool', toolCallId: 'same-id' }] },
      ]),
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('throw after dispatch stays unknown and cannot be retried with different arguments', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('response timeout'));
    const fence = new ToolReplayFence(policy);
    const wrapped = fence.wrap({
      [name]: tool({ inputSchema: z.object({ job: z.number() }), execute }),
    });
    await expect(wrapped[name].execute({ job: 1 }, options('first'))).rejects.toThrow('timeout');
    await expect(wrapped[name].execute({ job: 2 }, options('second'))).resolves.toMatchObject({
      actionStatus: 'blocked',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fence.snapshot()[0].status).toBe('unknown');
  });

  it('definite no-effect rejection allows the existing bounded correction', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ actionStatus: 'failed' })
      .mockResolvedValueOnce({ actionStatus: 'succeeded' });
    const fence = new ToolReplayFence(policy);
    const wrapped = fence.wrap({ [name]: tool({ inputSchema: z.object({}), execute }) });
    await wrapped[name].execute({}, options('first'));
    await wrapped[name].execute({}, options('second'));
    await wrapped[name].execute({}, options('third'));
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('mixed action receipts', () => {
  it('preserves booking success and unknown invite through SDK and collector', async () => {
    const result = {
      success: true,
      actionStatus: 'succeeded',
      groupInvite: { actionStatus: 'unknown' },
    };
    const fence = new ToolReplayFence(policy);
    const wrapped = fence.wrap({
      [name]: tool({ inputSchema: z.object({}), execute: async () => result }),
    });
    await wrapped[name].execute({}, options('mixed'));
    const expected = [
      { toolName: name, toolCallId: 'mixed', status: 'succeeded' },
      { toolName: name, toolCallId: 'mixed', status: 'unknown', component: 'groupInvite' },
    ];
    expect(fence.snapshot()).toEqual(expected);
    expect(collectToolReplayEvidence([{ toolName: name, toolCallId: 'mixed', result }])).toEqual(
      expected,
    );
    const observed = new ToolReplayFence(policy);
    observed.observe([{ toolResults: [{ toolName: name, toolCallId: 'mixed', output: result }] }]);
    expect(observed.snapshot()).toEqual(expected);
  });
});
