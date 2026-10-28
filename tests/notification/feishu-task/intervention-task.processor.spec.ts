import { InterventionTaskProcessor } from '@notification/feishu-task/intervention-task.processor';
import type { InterventionTaskJob } from '@notification/feishu-task/intervention-task-job';

describe('InterventionTaskProcessor', () => {
  const client = { createTask: jest.fn() };
  const delegation = { isRequired: jest.fn(), prepare: jest.fn(), assign: jest.fn() };
  const preparation = { prepareRequest: jest.fn() };
  const processor = new InterventionTaskProcessor(
    {} as never,
    client as never,
    {} as never,
    preparation as never,
    delegation as never,
  );
  const data = (): InterventionTaskJob => ({
    payload: {} as never,
    clientToken: 'stable-token',
    triggeredAt: '2026-10-21T00:00:00Z',
  });

  beforeEach(() => {
    jest.resetAllMocks();
    delegation.isRequired.mockReturnValue(false);
    delegation.prepare.mockResolvedValue('jiang');
    delegation.assign.mockResolvedValue(undefined);
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
  function delegatedJob() {
    const members = [{ id: 'yang', type: 'user', role: 'assignee' }];
    delegation.isRequired.mockReturnValue(true);
    preparation.prepareRequest.mockResolvedValue({
      summary: 'task',
      tasklistGuid: 'henan',
      members,
    });
    const job = {
      data: data(),
      update: jest.fn(async (next: InterventionTaskJob) => {
        job.data = next;
      }),
    };
    return job;
  }
  it('checks authorization before creating a Henan task', async () => {
    const job = delegatedJob();
    delegation.prepare.mockRejectedValue(new Error('authorization missing'));
    await expect(processor.process(job as never)).rejects.toThrow('authorization missing');
    expect(client.createTask).not.toHaveBeenCalled();
    expect(job.update).not.toHaveBeenCalled();
  });
  it('retries assignment only, preserving the GUID and recipient after a failed assignment', async () => {
    const job = delegatedJob();
    delegation.assign.mockRejectedValueOnce(new Error('rate limit'));
    await expect(processor.process(job as never)).rejects.toThrow('rate limit');
    expect(job.data.taskGuid).toBe('task-guid');
    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ members: undefined, tasklistGuid: 'henan' }),
    );
    await processor.process(job as never);
    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(delegation.assign).toHaveBeenCalledTimes(2);
    expect(job.data.assignment?.completedAt).toBeDefined();
    await processor.process(job as never);
    expect(delegation.assign).toHaveBeenCalledTimes(2);
  });
  it('does not assign if saving the created GUID failed', async () => {
    const job = delegatedJob();
    job.update.mockImplementation(async (next) => {
      if (next.taskGuid) throw new Error('save failed');
      job.data = next;
    });
    await expect(processor.process(job as never)).rejects.toThrow('save failed');
    expect(delegation.assign).not.toHaveBeenCalled();
    await expect(processor.process(job as never)).rejects.toThrow('result unknown');
  });
  it('retries idempotent member addition if saving assignment completion failed', async () => {
    const job = delegatedJob();
    job.update.mockImplementation(async (next) => {
      if (next.assignment?.completedAt) throw new Error('completion save failed');
      job.data = next;
    });
    await expect(processor.process(job as never)).rejects.toThrow('completion save failed');
    job.update.mockImplementation(async (next) => {
      job.data = next;
    });
    await processor.process(job as never);
    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(delegation.assign).toHaveBeenCalledTimes(2);
  });
  it('keeps completed legacy jobs untouched', async () => {
    await processor.process({ data: { ...data(), taskGuid: 'legacy' } } as never);
    expect(client.createTask).not.toHaveBeenCalled();
    expect(delegation.assign).not.toHaveBeenCalled();
  });
});
