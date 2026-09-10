import { ConfigService } from '@nestjs/config';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { RoomService } from '@channels/wecom/room/room.service';
import { RedisService } from '@infra/redis/redis.service';

describe('GroupMembershipService', () => {
  let service: GroupMembershipService;
  let redisService: jest.Mocked<RedisService>;
  let roomService: jest.Mocked<RoomService>;
  let configService: jest.Mocked<ConfigService>;
  let setStore: Map<string, Set<string>>;

  const createRedisMock = (): jest.Mocked<RedisService> =>
    ({
      exists: jest.fn(async (...keys: string[]) =>
        keys.reduce((count, key) => count + (setStore.has(key) ? 1 : 0), 0),
      ),
      sismember: jest.fn(async (key: string, member: string) =>
        setStore.get(key)?.has(member) ? 1 : 0,
      ),
      sadd: jest.fn(async (key: string, ...members: (string | number)[]) => {
        const existing = setStore.get(key) ?? new Set<string>();
        members.forEach((member) => existing.add(String(member)));
        setStore.set(key, existing);
        return existing.size;
      }),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (...keys: string[]) => {
        keys.forEach((key) => setStore.delete(key));
        return keys.length;
      }),
    }) as unknown as jest.Mocked<RedisService>;

  const createRoomServiceMock = (): jest.Mocked<RoomService> =>
    ({
      getEnterpriseGroupChatList: jest.fn(),
    }) as unknown as jest.Mocked<RoomService>;

  beforeEach(() => {
    setStore = new Map<string, Set<string>>();
    redisService = createRedisMock();
    roomService = createRoomServiceMock();
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'enterprise-token';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    service = new GroupMembershipService(redisService, roomService, configService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('isUserInRoom', () => {
    it('should skip when target room is not in whitelist', async () => {
      const result = await service.isUserInRoom('room-1', 'user-1', ['room-2']);

      expect(result).toBe(false);
      expect(redisService.exists).not.toHaveBeenCalled();
      expect(roomService.getEnterpriseGroupChatList).not.toHaveBeenCalled();
    });

    it('should return true from cached room members without hydrating', async () => {
      setStore.set('room:members:room-1', new Set(['user-1']));

      const result = await service.isUserInRoom('room-1', 'user-1', ['room-1']);

      expect(result).toBe(true);
      expect(roomService.getEnterpriseGroupChatList).not.toHaveBeenCalled();
    });

    it('should hydrate missing cache, filter by whitelist, and return membership result', async () => {
      roomService.getEnterpriseGroupChatList.mockResolvedValue({
        data: [
          {
            imRoomId: 'room-1',
            memberList: [{ imContactId: 'user-1' }, { imContactId: 'user-2' }],
          },
          {
            imRoomId: 'room-ignored',
            memberList: [{ imContactId: 'user-1' }],
          },
        ],
      });

      const result = await service.isUserInRoom('room-1', 'user-1', ['room-1']);

      expect(result).toBe(true);
      expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledTimes(1);
      expect(redisService.del).toHaveBeenCalledWith('room:members:room-1');
      expect(setStore.get('room:members:room-1')).toEqual(new Set(['user-1', 'user-2']));
      expect(setStore.has('room:members:room-ignored')).toBe(false);
      expect(redisService.expire).toHaveBeenCalledWith('room:members:room-1', 600);
    });

    it('should dedupe in-flight hydrate requests', async () => {
      roomService.getEnterpriseGroupChatList.mockImplementation(async () => {
        await Promise.resolve();
        return {
          data: [
            {
              imRoomId: 'room-1',
              memberList: [{ imContactId: 'user-1' }],
            },
          ],
        };
      });

      const first = service.isUserInRoom('room-1', 'user-1', ['room-1']);
      const second = service.isUserInRoom('room-1', 'user-1', ['room-1']);

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledTimes(1);
    });

    it('should re-hydrate when target key has expired before local cooldown ends', async () => {
      roomService.getEnterpriseGroupChatList.mockResolvedValue({
        data: [
          {
            imRoomId: 'room-1',
            memberList: [{ imContactId: 'user-1' }],
          },
        ],
      });

      await expect(service.isUserInRoom('room-1', 'user-1', ['room-1'])).resolves.toBe(true);

      setStore.delete('room:members:room-1');

      await expect(service.isUserInRoom('room-1', 'user-1', ['room-1'])).resolves.toBe(true);
      expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledTimes(2);
    });

    it('should fail open when hydration throws', async () => {
      roomService.getEnterpriseGroupChatList.mockRejectedValue(new Error('boom'));

      const result = await service.isUserInRoom('room-1', 'user-1', ['room-1']);

      expect(result).toBe(false);
    });
  });

  describe('listUserRooms', () => {
    it('should return rooms the user belongs to from warm cache without hydrating', async () => {
      setStore.set('room:members:room-1', new Set(['user-1']));
      setStore.set('room:members:room-2', new Set(['user-2']));

      const result = await service.listUserRooms('user-1', ['room-1', 'room-2']);

      expect(result).toEqual(['room-1']);
      expect(roomService.getEnterpriseGroupChatList).not.toHaveBeenCalled();
    });

    it('should return empty array for empty inputs without touching redis', async () => {
      await expect(service.listUserRooms('', ['room-1'])).resolves.toEqual([]);
      await expect(service.listUserRooms('user-1', [])).resolves.toEqual([]);
      expect(redisService.exists).not.toHaveBeenCalled();
    });

    it('should hydrate once when any whitelisted room cache is missing', async () => {
      setStore.set('room:members:room-1', new Set(['user-1']));
      roomService.getEnterpriseGroupChatList.mockResolvedValue({
        data: [
          {
            imRoomId: 'room-2',
            memberList: [{ imContactId: 'user-1' }, { imContactId: 'user-2' }],
          },
        ],
      });

      const result = await service.listUserRooms('user-1', ['room-1', 'room-2']);

      expect(result).toEqual(expect.arrayContaining(['room-1', 'room-2']));
      expect(result).toHaveLength(2);
      expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledTimes(1);
      expect(setStore.get('room:members:room-2')).toEqual(new Set(['user-1', 'user-2']));
    });

    it('should report verified=false with redis_error when redis throws', async () => {
      redisService.exists.mockRejectedValue(new Error('redis down'));

      await expect(service.lookupUserRooms('user-1', ['room-1'])).resolves.toEqual({
        rooms: [],
        verified: false,
        reason: 'redis_error',
      });
    });

    it('should report verified=true with the rooms the user is in', async () => {
      setStore.set('room:members:room-1', new Set(['user-1']));
      setStore.set('room:members:room-2', new Set(['user-2']));

      await expect(service.lookupUserRooms('user-1', ['room-1', 'room-2'])).resolves.toEqual({
        rooms: ['room-1'],
        verified: true,
      });
    });

    it('should degrade to empty array when redis throws', async () => {
      redisService.exists.mockRejectedValue(new Error('redis down'));

      await expect(service.listUserRooms('user-1', ['room-1'])).resolves.toEqual([]);
    });
  });

  describe('markUserInRoom', () => {
    it('should write user into room cache and refresh ttl', async () => {
      await service.markUserInRoom('room-1', 'user-1');

      expect(setStore.get('room:members:room-1')).toEqual(new Set(['user-1']));
      expect(redisService.sadd).toHaveBeenCalledWith('room:members:room-1', 'user-1');
      expect(redisService.expire).toHaveBeenCalledWith('room:members:room-1', 600);
    });
  });
  describe('bounded hydrate wait', () => {
    const buildService = (waitMs: string) =>
      new GroupMembershipService(
        redisService,
        roomService,
        {
          get: jest.fn((key: string) => {
            if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'enterprise-token';
            if (key === 'GROUP_MEMBERSHIP_HYDRATE_WAIT_MS') return waitMs;
            return undefined;
          }),
        } as unknown as jest.Mocked<ConfigService>,
      );

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should give up waiting after the bound, keep hydrating in background, then reuse the warm cache', async () => {
      let finishHydrate!: () => void;
      roomService.getEnterpriseGroupChatList.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishHydrate = () =>
              resolve({ data: [{ imRoomId: 'room-1', memberList: [{ imContactId: 'user-1' }] }] });
          }),
      );
      const bounded = buildService('50');

      const pending = bounded.lookupUserRooms('user-1', ['room-1']);
      await jest.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({
        rooms: [],
        verified: false,
        reason: 'hydrate_timeout',
      });
      expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledTimes(1);

      // 预热没有被超时中断：API 返回后缓存落地，下一次查询不再触发预热。
      finishHydrate();
      await jest.advanceTimersByTimeAsync(0);
      await expect(bounded.lookupUserRooms('user-1', ['room-1'])).resolves.toEqual({
        rooms: ['room-1'],
        verified: true,
      });
      expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledTimes(1);
    });

    it('should fail open in isUserInRoom when hydrate exceeds the wait bound', async () => {
      roomService.getEnterpriseGroupChatList.mockImplementation(() => new Promise(() => undefined));
      const bounded = buildService('50');

      const pending = bounded.isUserInRoom('room-1', 'user-1', ['room-1']);
      await jest.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBe(false);
    });

    it('should treat a non-positive wait as never blocking on hydrate', async () => {
      roomService.getEnterpriseGroupChatList.mockImplementation(() => new Promise(() => undefined));
      const bounded = buildService('0');

      await expect(bounded.lookupUserRooms('user-1', ['room-1'])).resolves.toEqual({
        rooms: [],
        verified: false,
        reason: 'hydrate_timeout',
      });
    });
  });

});
