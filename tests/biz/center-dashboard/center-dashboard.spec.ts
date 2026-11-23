import { CenterDashboardService } from '@biz/center-dashboard/center-dashboard.service';
import { CenterScopeService } from '@biz/center-dashboard/center-scope.service';
import { CenterDashboardRepository } from '@biz/center-dashboard/center-dashboard.repository';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { CENTER_READ_ROUTES } from '@infra/server/dashboard-access/center-routes';
import type { Request } from 'express';
import type { SupabaseService } from '@infra/supabase/supabase.service';

describe('Existing dashboard contracts under a center scope', () => {
  const scopes = { getScope: jest.fn() };
  const blacklist = { getGroupBlacklistStrict: jest.fn(), setGroupBlacklisted: jest.fn() };
  const repository = { read: jest.fn() };
  const service = new CenterDashboardService(
    scopes as unknown as CenterScopeService,
    blacklist as unknown as GroupBlacklistService,
    repository as unknown as CenterDashboardRepository,
  );
  const req = (body = {}, method = 'GET') =>
    ({ query: { botIds: 'foreign' }, params: {}, body, method }) as unknown as Request;
  beforeEach(() => {
    jest.resetAllMocks();
    scopes.getScope.mockResolvedValue({
      groups: [{ id: 'own', name: '本组' }],
      bots: [{ wxid: 'bot', groupId: 'own' }],
      botIds: ['bot'],
    });
    blacklist.getGroupBlacklistStrict.mockResolvedValue([
      { group_id: 'own' },
      { group_id: 'foreign' },
    ]);
  });
  it('filters existing group and blacklist responses without exposing global state', async () => {
    expect(await service.handle('groups', req(), 'henan')).toEqual([
      { id: 'own', name: '本组', tenantId: 'henan' },
    ]);
    expect(await service.handle('blacklist', req(), 'henan')).toEqual({
      chatIds: [],
      groupIds: ['own'],
    });
  });
  it('freshly checks only the submitted owned group and blocks foreign/global writes', async () => {
    await service.handle('group-switch', req({ id: 'own', type: 'groupId' }, 'POST'), 'henan');
    expect(scopes.getScope).toHaveBeenCalledWith(true, 'henan');
    expect(blacklist.setGroupBlacklisted).toHaveBeenCalledWith(
      'own',
      true,
      expect.any(String),
      'henan',
    );
    await service.handle('group-switch', req({ id: 'own', type: 'groupId' }, 'DELETE'), 'henan');
    expect(blacklist.setGroupBlacklisted).toHaveBeenLastCalledWith(
      'own',
      false,
      expect.any(String),
      'henan',
    );
    await expect(
      service.handle('group-switch', req({ id: 'foreign', type: 'groupId' }, 'POST'), 'henan'),
    ).rejects.toThrow();
    await expect(
      service.handle('group-switch', req({ id: 'own', type: 'chatId' }, 'POST'), 'henan'),
    ).rejects.toThrow();
    await expect(
      service.handle(
        'group-switch',
        req({ id: 'own', type: 'groupId', enabled: true }, 'POST'),
        'henan',
      ),
    ).rejects.toThrow();
    expect(blacklist.setGroupBlacklisted).toHaveBeenCalledTimes(2);
  });
  it('supplies server scope to every original analytics read; client bot parameters cannot expand it', async () => {
    for (const [path, kind] of Object.entries(CENTER_READ_ROUTES)) {
      if (!path.startsWith('/analytics') || kind === 'scenarios') continue;
      await service.handle(kind, req(), 'henan');
      expect(repository.read).toHaveBeenLastCalledWith(kind, 'henan', expect.any(Object));
    }
    await service.handle(
      'messages',
      {
        ...req(),
        params: { chatId: 'foreign-chat' },
      } as unknown as Request,
      'henan',
    );
    expect(repository.read).toHaveBeenLastCalledWith(
      'messages',
      'henan',
      expect.objectContaining({ chatId: 'foreign-chat' }),
    );
  });
  it('passes only bounded filters to SQL and never falls back to unscoped reads', async () => {
    const abortSignal = jest.fn().mockResolvedValue({ data: [], error: null });
    const rpc = jest.fn().mockReturnValue({ abortSignal });
    const db = new CenterDashboardRepository({
      getSupabaseClient: () => ({ rpc }),
    } as unknown as SupabaseService);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    await db.read('processing', 'henan', {
      startDate: today,
      endDate: today,
      botIds: 'foreign',
      limit: '50',
    });
    expect(rpc).toHaveBeenCalledWith(
      'tenant_dashboard_read',
      expect.objectContaining({ p_tenant_id: 'henan', p_params: { limit: 50 } }),
    );
    abortSignal.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await expect(db.read('sessions', 'henan', {})).rejects.toThrow('暂不可用');
    expect(rpc).toHaveBeenLastCalledWith(
      'tenant_dashboard_read',
      expect.objectContaining({ p_tenant_id: 'henan' }),
    );
    await expect(db.read('sessions', 'henan', { limit: '999999' })).rejects.toThrow();
    await expect(db.read('users', 'henan', { afterChatId: 'chat' })).rejects.toThrow(
      '游标必须完整',
    );
    await expect(
      db.read('sessions', 'henan', { startDate: '2020-01-01', endDate: today }),
    ).rejects.toThrow();
  });
  it('reads historical chats by the signed-in organization even when its Bot has moved', async () => {
    scopes.getScope.mockRejectedValue(new Error('directory unavailable'));
    const request = {
      query: { tenantId: 'headquarters' },
      params: { chatId: 'old-chat' },
    } as unknown as Request;
    await service.handle('messages', request, 'shanghai_recruitment');
    expect(scopes.getScope).not.toHaveBeenCalled();
    expect(repository.read).toHaveBeenCalledWith(
      'messages',
      'shanghai_recruitment',
      expect.objectContaining({ chatId: 'old-chat' }),
    );
  });
});
