import { ConfigService } from '@nestjs/config';
import { DelegatedTaskAssignmentService } from '@notification/feishu-task/delegated-task-assignment.service';
import { fetchWithTimeout } from '@infra/utils/fetch-timeout.util';
import type { FeishuTaskMember } from '@notification/feishu-task/feishu-task.types';
jest.mock('@infra/utils/fetch-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));
const fetchMock = jest.mocked(fetchWithTimeout);
describe('DelegatedTaskAssignmentService', () => {
  const config = new ConfigService({
    FEISHU_TASK_TASKLIST_GUID: 'hq',
    HENAN_FEISHU_TASK_TASKLIST_GUID: 'henan',
    FEISHU_TASK_DELEGATOR_OPEN_ID: 'jiang',
  });
  const tokens = { getToken: jest.fn() };
  const failures = { report: jest.fn() };
  const service = new DelegatedTaskAssignmentService(config, tokens as never, failures as never);
  const members: FeishuTaskMember[] = [{ id: 'yang', type: 'user', role: 'assignee' }];
  beforeEach(() => {
    jest.resetAllMocks();
    tokens.getToken.mockResolvedValue('secret-user-token');
  });
  it('rejects HQ targets, missing recipients, and changed delegator identity', async () => {
    expect(service.isRequired('hq')).toBe(false);
    await expect(service.prepare('hq', members)).rejects.toThrow();
    await expect(service.prepare('henan', [])).rejects.toThrow();
    await expect(service.assign('guid', 'henan', 'other', members)).rejects.toThrow('changed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires returned assignees, not just an HTTP success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { task: { members: [] } } }),
    } as Response);
    await expect(service.assign('guid', 'henan', 'jiang', members)).rejects.toThrow(
      'assignment failed',
    );
  });
  it('uses user authorization and confirms every assignee', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { task: { members } } }),
    } as Response);
    await expect(service.assign('guid', 'henan', 'jiang', members)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/guid/add_members'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-user-token' }),
      }),
    );
  });
  it('does not expose provider errors containing credentials', async () => {
    fetchMock.mockRejectedValue(new Error('secret-user-token'));
    await expect(service.assign('guid', 'henan', 'jiang', members)).rejects.toThrow(
      'assignment failed',
    );
  });
  it('renews idle authorization and reports failures without token details', async () => {
    await service.maintainAuthorization();
    expect(tokens.getToken).toHaveBeenCalledTimes(1);
    tokens.getToken.mockRejectedValue(new Error('secret-user-token'));
    await service.maintainAuthorization();
    expect(failures.report).toHaveBeenCalledWith(
      'feishu.task_delegation_authorization',
      'henan-task-delegator',
      expect.objectContaining({ message: '河南任务用户授权不可用，请检查凭据配置或重新授权' }),
    );
  });
});
