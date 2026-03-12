import { Test, TestingModule } from '@nestjs/testing';
import { RoomService } from './room.service';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

describe('RoomService', () => {
  let service: RoomService;

  const mockHttpService = {
    get: jest.fn(),
    post: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      room: {
        list: jest.fn().mockReturnValue('https://api.example.com/room/list'),
        simpleList: jest.fn().mockReturnValue('https://api.example.com/room/simpleList'),
        addMember: jest.fn().mockReturnValue('https://api.example.com/room/addMember'),
        addFriendSend: jest.fn().mockReturnValue('https://api.example.com/addFriend/room/send'),
      },
      groupChat: {
        list: jest.fn().mockReturnValue('https://enterprise-api.example.com/groupChat/list'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<RoomService>(RoomService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getRoomSimpleList', () => {
    it('should return simple room list with required params', async () => {
      const token = 'group-token';
      const current = 1;
      const pageSize = 20;
      const mockResult = { data: [{ wxid: 'room-1', name: 'Room 1' }], total: 1 };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getRoomSimpleList(token, current, pageSize);

      expect(mockApiConfig.endpoints.room.simpleList).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/room/simpleList', {
        token,
        current,
        pageSize,
      });
      expect(result).toEqual(mockResult);
    });

    it('should include wxid filter when provided', async () => {
      const token = 'group-token';
      const current = 1;
      const pageSize = 20;
      const wxid = 'room-wxid-specific';

      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getRoomSimpleList(token, current, pageSize, wxid);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        current,
        pageSize,
        wxid,
      });
    });

    it('should not include wxid when not provided', async () => {
      const token = 'group-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getRoomSimpleList(token, 1, 10);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('wxid');
    });

    it('should throw error when API call fails', async () => {
      const token = 'group-token';
      mockHttpService.get.mockRejectedValue(new Error('Timeout'));

      await expect(service.getRoomSimpleList(token, 1, 10)).rejects.toThrow('Timeout');
    });
  });

  describe('getRoomList', () => {
    it('should return room list with pagination when no wxid', async () => {
      const token = 'group-token';
      const current = 1;
      const pageSize = 20;
      const mockResult = { data: [{ wxid: 'room-1', members: [] }], total: 1 };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getRoomList(token, current, pageSize);

      expect(mockApiConfig.endpoints.room.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/room/list', {
        token,
        current,
        pageSize,
      });
      expect(result).toEqual(mockResult);
    });

    it('should use wxid-only params when wxid is provided', async () => {
      const token = 'group-token';
      const wxid = 'specific-room-wxid';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getRoomList(token, 1, 20, wxid);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, wxid });
    });

    it('should not include current and pageSize when wxid is provided', async () => {
      const token = 'group-token';
      const wxid = 'specific-room-wxid';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getRoomList(token, 1, 20, wxid);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('current');
      expect(callArgs).not.toHaveProperty('pageSize');
    });

    it('should throw error when API call fails', async () => {
      mockHttpService.get.mockRejectedValue(new Error('Unauthorized'));

      await expect(service.getRoomList('token', 1, 10)).rejects.toThrow('Unauthorized');
    });
  });

  describe('getEnterpriseGroupChatList', () => {
    it('should return enterprise group chat list with token only', async () => {
      const token = 'enterprise-token';
      const mockResult = { data: [{ groupChatId: 'gc-1' }], total: 1 };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getEnterpriseGroupChatList(token);

      expect(mockApiConfig.endpoints.groupChat.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith(
        'https://enterprise-api.example.com/groupChat/list',
        { token },
      );
      expect(result).toEqual(mockResult);
    });

    it('should include current when provided', async () => {
      const token = 'enterprise-token';
      const current = 2;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getEnterpriseGroupChatList(token, current);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, current });
    });

    it('should include pageSize when provided', async () => {
      const token = 'enterprise-token';
      const pageSize = 100;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getEnterpriseGroupChatList(token, undefined, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, pageSize });
    });

    it('should include imBotId when provided', async () => {
      const token = 'enterprise-token';
      const imBotId = 'bot-123';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getEnterpriseGroupChatList(token, undefined, undefined, imBotId);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, imBotId });
    });

    it('should include wecomUserId when provided', async () => {
      const token = 'enterprise-token';
      const wecomUserId = 'user-456';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getEnterpriseGroupChatList(token, undefined, undefined, undefined, wecomUserId);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, wecomUserId });
    });

    it('should include all params when all provided', async () => {
      const token = 'enterprise-token';
      const current = 1;
      const pageSize = 50;
      const imBotId = 'bot-1';
      const wecomUserId = 'user-1';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getEnterpriseGroupChatList(token, current, pageSize, imBotId, wecomUserId);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        current,
        pageSize,
        imBotId,
        wecomUserId,
      });
    });

    it('should throw error when API call fails', async () => {
      mockHttpService.get.mockRejectedValue(new Error('Service error'));

      await expect(service.getEnterpriseGroupChatList('token')).rejects.toThrow('Service error');
    });
  });

  describe('addMember', () => {
    it('should add member to room successfully', async () => {
      const data = {
        token: 'group-token',
        botUserId: 'bot-1',
        contactWxid: 'wxid_contact',
        roomWxid: 'wxid_room',
      };
      const mockResult = { success: true };

      mockHttpService.post.mockResolvedValue(mockResult);

      const result = await service.addMember(data);

      expect(mockApiConfig.endpoints.room.addMember).toHaveBeenCalled();
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'https://api.example.com/room/addMember',
        data,
      );
      expect(result).toEqual(mockResult);
    });

    it('should throw error when add member fails', async () => {
      const data = {
        token: 'group-token',
        botUserId: 'bot-1',
        contactWxid: 'wxid_contact',
        roomWxid: 'wxid_room',
      };
      mockHttpService.post.mockRejectedValue(new Error('Add member failed'));

      await expect(service.addMember(data)).rejects.toThrow('Add member failed');
    });
  });

  describe('addFriendFromRoom', () => {
    it('should send add friend request from room successfully', async () => {
      const data = {
        token: 'group-token',
        roomId: 'room-1',
        contactId: 'contact-1',
        helloMsg: 'Hello, let us be friends!',
        userId: 'user-1',
      };
      const mockResult = { success: true, requestId: 'req-001' };

      mockHttpService.post.mockResolvedValue(mockResult);

      const result = await service.addFriendFromRoom(data);

      expect(mockApiConfig.endpoints.room.addFriendSend).toHaveBeenCalled();
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'https://api.example.com/addFriend/room/send',
        data,
      );
      expect(result).toEqual(mockResult);
    });

    it('should include optional remark and extraInfo when provided', async () => {
      const data = {
        token: 'group-token',
        roomId: 'room-1',
        contactId: 'contact-1',
        remark: 'Business contact',
        helloMsg: 'Hi there!',
        extraInfo: 'some-extra',
        userId: 'user-1',
      };
      mockHttpService.post.mockResolvedValue({ success: true });

      await service.addFriendFromRoom(data);

      expect(mockHttpService.post).toHaveBeenCalledWith(expect.any(String), data);
    });

    it('should throw error when add friend request fails', async () => {
      const data = {
        token: 'group-token',
        roomId: 'room-1',
        contactId: 'contact-1',
        helloMsg: 'Hi!',
        userId: 'user-1',
      };
      mockHttpService.post.mockRejectedValue(new Error('Friend request failed'));

      await expect(service.addFriendFromRoom(data)).rejects.toThrow('Friend request failed');
    });
  });

  describe('handleJoinedCallback', () => {
    it('should return success message when processing joined callback', async () => {
      const callbackData = {
        roomWxid: 'room-1',
        contactWxid: 'wxid_contact',
        joinType: 1,
      };

      const result = await service.handleJoinedCallback(callbackData);

      expect(result).toEqual({
        success: true,
        message: '加入群聊回调处理成功',
      });
    });

    it('should handle any data shape in joined callback', async () => {
      const result = await service.handleJoinedCallback({ arbitraryKey: 'value' });

      expect(result.success).toBe(true);
    });

    it('should handle null data without throwing', async () => {
      const result = await service.handleJoinedCallback(null);

      expect(result.success).toBe(true);
    });
  });

  describe('handleLeftCallback', () => {
    it('should return success message when processing left callback', async () => {
      const callbackData = {
        roomWxid: 'room-1',
        contactWxid: 'wxid_contact',
        leaveType: 2,
      };

      const result = await service.handleLeftCallback(callbackData);

      expect(result).toEqual({
        success: true,
        message: '退出群聊回调处理成功',
      });
    });

    it('should handle any data shape in left callback', async () => {
      const result = await service.handleLeftCallback({ someKey: 'value' });

      expect(result.success).toBe(true);
    });

    it('should handle null data without throwing', async () => {
      const result = await service.handleLeftCallback(null);

      expect(result.success).toBe(true);
    });
  });
});
