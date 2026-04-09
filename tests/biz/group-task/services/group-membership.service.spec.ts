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
    } as unknown as jest.Mocked<RedisService>);

  const createRoomServiceMock = (): jest.Mocked<RoomService> =>
    ({
      getEnterpriseGroupChatList: jest.fn(),
      getRoomList: jest.fn(),
    } as unknown as jest.Mocked<RoomService>);

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

  describe('markUserInRoom', () => {
    it('should write user into room cache and refresh ttl', async () => {
      await service.markUserInRoom('room-1', 'user-1');

      expect(setStore.get('room:members:room-1')).toEqual(new Set(['user-1']));
      expect(redisService.sadd).toHaveBeenCalledWith('room:members:room-1', 'user-1');
      expect(redisService.expire).toHaveBeenCalledWith('room:members:room-1', 600);
    });
  });

  describe('refreshRoomCacheByToken', () => {
    it('should refresh a single room cache from room/list', async () => {
      roomService.getRoomList.mockResolvedValue({
        data: [
          {
            wxid: 'room-1',
            memberList: [{ imContactId: 'user-1' }, { contactWxid: 'user-2' }],
          },
        ],
      });

      await service.refreshRoomCacheByToken('room-1', 'group-token');

      expect(roomService.getRoomList).toHaveBeenCalledWith('group-token', 0, 1, 'room-1');
      expect(setStore.get('room:members:room-1')).toEqual(new Set(['user-1', 'user-2']));
      expect(redisService.expire).toHaveBeenCalledWith('room:members:room-1', 600);
    });

    it('should dedupe concurrent single-room refreshes', async () => {
      roomService.getRoomList.mockImplementation(async () => {
        await Promise.resolve();
        return {
          data: [
            {
              wxid: 'room-1',
              memberList: [{ imContactId: 'user-1' }],
            },
          ],
        };
      });

      await Promise.all([
        service.refreshRoomCacheByToken('room-1', 'group-token'),
        service.refreshRoomCacheByToken('room-1', 'group-token'),
      ]);

      expect(roomService.getRoomList).toHaveBeenCalledTimes(1);
    });
  });
});
