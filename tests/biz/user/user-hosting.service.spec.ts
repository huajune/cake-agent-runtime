import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { UserHostingRepository } from '@biz/user/repositories/user-hosting.repository';
import { RedisService } from '@infra/redis/redis.service';

describe('UserHostingService', () => {
  let service: UserHostingService;
  let mockRepository: jest.Mocked<UserHostingRepository>;
  let mockRedisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    mockRepository = {
      expirePausedUsers: jest.fn().mockResolvedValue([]),
      findPausedUserIds: jest.fn().mockResolvedValue([]),
      findUserProfiles: jest.fn().mockResolvedValue([]),
      upsertPause: jest.fn(),
      updateResume: jest.fn(),
      findActiveUsersByDateRange: jest.fn(),
      upsertUserActivity: jest.fn(),
      cleanupUserActivity: jest.fn(),
    } as unknown as jest.Mocked<UserHostingRepository>;

    mockRedisService = {
      setNx: jest.fn().mockResolvedValue(true),
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as jest.Mocked<RedisService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: { get: jest.fn((_k: string, d?: unknown) => d) } },
        UserHostingService,
        { provide: UserHostingRepository, useValue: mockRepository },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<UserHostingService>(UserHostingService);
  });

  it('skips the cron run when another replica already holds the Redis lock', async () => {
    mockRedisService.setNx.mockResolvedValue(false);

    await service.expireOverduePausedUsers();

    expect(mockRepository.expirePausedUsers).not.toHaveBeenCalled();
    expect(mockRedisService.eval).not.toHaveBeenCalled();
  });

  it('refreshes cache under lock and releases the lock safely after processing', async () => {
    mockRepository.expirePausedUsers.mockResolvedValue(['user-1']);
    const refreshSpy = jest.spyOn(service, 'refreshCache').mockResolvedValue(undefined);

    await service.expireOverduePausedUsers();

    expect(mockRepository.expirePausedUsers).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(mockRedisService.eval).toHaveBeenCalledWith(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      ['hosting:paused-users:expire-lock:v1'],
      [expect.any(String)],
    );
  });
  it('手动恢复托管后触发已注册的恢复监听器（fire-and-forget，监听器失败不影响恢复）', async () => {
    mockRepository.updateResume = jest.fn().mockResolvedValue(undefined);
    mockRepository.findPausedUserIds = jest.fn().mockResolvedValue([]);
    const listener = jest.fn().mockRejectedValue(new Error('boom'));
    const okListener = jest.fn().mockResolvedValue(undefined);
    service.registerResumeListener(listener);
    service.registerResumeListener(okListener);

    await expect(service.resumeUser('chat-1')).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(listener).toHaveBeenCalledWith('chat-1');
    expect(okListener).toHaveBeenCalledWith('chat-1');
  });
});
