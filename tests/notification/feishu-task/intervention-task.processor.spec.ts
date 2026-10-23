import { InterventionTaskProcessor } from '@notification/feishu-task/intervention-task.processor';
import type { InterventionTaskJob } from '@notification/feishu-task/intervention-task-job';

describe('InterventionTaskProcessor', () => {
  const client = { createTask: jest.fn() };
  const preparation = { prepareRequest: jest.fn() };
  const processor = new InterventionTaskProcessor(
    {} as never,
    client as never,
    {} as never,
    preparation as never,
  );
  const data = (): InterventionTaskJob => ({
    payload: {} as never,
    clientToken: 'stable-token',
    triggeredAt: '2026-10-21T00:00:00Z',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    preparation.prepareRequest.mockResolvedValue({ summary: 'task', clientToken: 'stable-token' });
    client.createTask.mockResolvedValue({ guid: 'task-guid' });
  });

  it('does not dispatch if it cannot durably mark the immutable request', async () => {
    await expect(
      processor.process({
        data: data(),
        update: jest.fn().mockRejectedValue(new Error('redis down')),
      } as never),
    ).rejects.toThrow('redis down');
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it('retries preparation, but never creates again after an unknown external result', async () => {
    preparation.prepareRequest.mockRejectedValueOnce(new Error('preparation failed'));
    const job = {
      data: data(),
      update: jest.fn(async (value: InterventionTaskJob) => {
        job.data = value;
      }),
    };
    await expect(processor.process(job as never)).rejects.toThrow('preparation failed');
    client.createTask.mockResolvedValue(null);
    await expect(processor.process(job as never)).rejects.toThrow('no authoritative success');
    await expect(processor.process(job as never)).rejects.toThrow('result unknown');
    expect(client.createTask).toHaveBeenCalledTimes(1);
  });

  it('does not repeat external success when saving the task GUID fails', async () => {
    const job = {
      data: data(),
      update: jest.fn(async (value: InterventionTaskJob) => {
        if (value.taskGuid) throw new Error('accounting failed');
        job.data = value;
      }),
    };
    await expect(processor.process(job as never)).rejects.toThrow('accounting failed');
    await expect(processor.process(job as never)).rejects.toThrow('result unknown');
    expect(client.createTask).toHaveBeenCalledTimes(1);
  });
});
