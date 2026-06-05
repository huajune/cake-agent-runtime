import { HostingMemberConfigRepository } from '@biz/hosting-config/repositories/hosting-member-config.repository';
import { HOSTING_MEMBER_CONFIG_KEY } from '@biz/hosting-config/types/hosting-member-config.types';
import { SupabaseService } from '@infra/supabase/supabase.service';

type RepositoryWithSelectOne = HostingMemberConfigRepository & {
  selectOne<T>(columns?: string, modifier?: (query: unknown) => unknown): Promise<T | null>;
};

describe('HostingMemberConfigRepository', () => {
  function buildRepository(isInitialized = true) {
    return new HostingMemberConfigRepository({
      getSupabaseClient: jest.fn(),
      isClientInitialized: jest.fn().mockReturnValue(isInitialized),
    } as unknown as SupabaseService);
  }

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('reads hosting_member_config from system_config.value', async () => {
    const repository = buildRepository();
    const selectOneSpy = jest
      .spyOn(repository as RepositoryWithSelectOne, 'selectOne')
      .mockResolvedValue({
        value: { members: { 'bot-1': { dulidayToken: 'token-1' } } },
      });

    await expect(repository.readConfig()).resolves.toEqual({
      members: { 'bot-1': { dulidayToken: 'token-1' } },
    });
    expect(selectOneSpy).toHaveBeenCalledWith('value', expect.any(Function));

    const query = { eq: jest.fn().mockReturnValue('filtered') };
    const modifier = selectOneSpy.mock.calls[0][1];
    expect(modifier?.(query)).toBe('filtered');
    expect(query.eq).toHaveBeenCalledWith('key', HOSTING_MEMBER_CONFIG_KEY);
  });

  it('returns null for missing, array, or unavailable config', async () => {
    const repository = buildRepository();
    jest.spyOn(repository as RepositoryWithSelectOne, 'selectOne').mockResolvedValue({ value: [] });
    await expect(repository.readConfig()).resolves.toBeNull();

    const unavailable = buildRepository(false);
    await expect(unavailable.readConfig()).resolves.toBeNull();
  });
});
