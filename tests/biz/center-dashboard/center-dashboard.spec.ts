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
    expect(await service.handle('groups', req())).toEqual([{ id: 'own', name: '本组' }]);
    expect(await service.handle('blacklist', req())).toEqual({ chatIds: [], groupIds: ['own'] });
  });
  it('freshly checks only the submitted owned group and blocks foreign/global writes', async () => {
    await service.handle('group-switch', req({ id: 'own', type: 'groupId' }, 'POST'));
    expect(scopes.getScope).toHaveBeenCalledWith(true);
    expect(blacklist.setGroupBlacklisted).toHaveBeenCalledWith('own', true, expect.any(String));
    await service.handle('group-switch', req({ id: 'own', type: 'groupId' }, 'DELETE'));
    expect(blacklist.setGroupBlacklisted).toHaveBeenLastCalledWith(
      'own',
      false,
      expect.any(String),
    );
    await expect(
      service.handle('group-switch', req({ id: 'foreign', type: 'groupId' }, 'POST')),
    ).rejects.toThrow();
    await expect(
      service.handle('group-switch', req({ id: 'own', type: 'chatId' }, 'POST')),
    ).rejects.toThrow();
    await expect(
      service.handle('group-switch', req({ id: 'own', type: 'groupId', enabled: true }, 'POST')),
    ).rejects.toThrow();
    expect(blacklist.setGroupBlacklisted).toHaveBeenCalledTimes(2);
  });
  it('supplies server scope to every original analytics read; client bot parameters cannot expand it', async () => {
    for (const [path, kind] of Object.entries(CENTER_READ_ROUTES)) {
      if (!path.startsWith('/analytics') || kind === 'scenarios') continue;
      await service.handle(kind, req());
      expect(repository.read).toHaveBeenLastCalledWith(kind, ['bot'], expect.any(Object));
    }
    await service.handle('messages', {
      ...req(),
      params: { chatId: 'foreign-chat' },
    } as unknown as Request);
    expect(repository.read).toHaveBeenLastCalledWith(
      'messages',
      ['bot'],
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
    await db.read('processing', ['bot'], {
      startDate: today,
      endDate: today,
      botIds: 'foreign',
      limit: '50',
    });
    expect(rpc).toHaveBeenCalledWith(
      'center_dashboard_read',
      expect.objectContaining({ p_bot_ids: ['bot'], p_params: { limit: 50 } }),
    );
    abortSignal.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await expect(db.read('sessions', [], {})).rejects.toThrow('暂不可用');
    await expect(db.read('sessions', ['bot'], { limit: '999999' })).rejects.toThrow();
    await expect(
      db.read('sessions', ['bot'], { startDate: '2020-01-01', endDate: today }),
    ).rejects.toThrow();
  });
});
