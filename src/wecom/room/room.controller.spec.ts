import { Test, TestingModule } from '@nestjs/testing';
import { RoomController } from './room.controller';
import { RoomService } from './room.service';

describe('RoomController', () => {
  let controller: RoomController;
  let service: RoomService;

  const mockRoomService = {
    getRoomSimpleList: jest.fn(),
    getRoomList: jest.fn(),
    getEnterpriseGroupChatList: jest.fn(),
    addMember: jest.fn(),
    addFriendFromRoom: jest.fn(),
    handleJoinedCallback: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoomController],
      providers: [
        {
          provide: RoomService,
          useValue: mockRoomService,
        },
      ],
    }).compile();

    controller = module.get<RoomController>(RoomController);
    service = module.get<RoomService>(RoomService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getRoomSimpleList', () => {
    it('should call roomService.getRoomSimpleList with all parameters', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 10;
      const wxid = 'room123';
      const mockResult = {
        data: [{ roomId: 'room1', name: 'Room 1' }],
        total: 1,
      };

      mockRoomService.getRoomSimpleList.mockResolvedValue(mockResult);

      const result = await controller.getRoomSimpleList(token, current, pageSize, wxid);

      expect(service.getRoomSimpleList).toHaveBeenCalledWith(token, current, pageSize, wxid);
      expect(result).toEqual(mockResult);
    });

    it('should call roomService.getRoomSimpleList without optional wxid', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 20;
      const mockResult = { data: [], total: 0 };

      mockRoomService.getRoomSimpleList.mockResolvedValue(mockResult);

      const result = await controller.getRoomSimpleList(token, current, pageSize);

      expect(service.getRoomSimpleList).toHaveBeenCalledWith(token, current, pageSize, undefined);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from roomService.getRoomSimpleList', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 10;
      const error = new Error('Service error');

      mockRoomService.getRoomSimpleList.mockRejectedValue(error);

      await expect(controller.getRoomSimpleList(token, current, pageSize)).rejects.toThrow(
        'Service error',
      );
    });
  });

  describe('getRoomList', () => {
    it('should call roomService.getRoomList with all parameters', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 10;
      const wxid = 'room123';
      const mockResult = {
        data: [
          {
            roomId: 'room1',
            name: 'Room 1',
            members: [{ wxid: 'user1', name: 'User 1' }],
          },
        ],
        total: 1,
      };

      mockRoomService.getRoomList.mockResolvedValue(mockResult);

      const result = await controller.getRoomList(token, current, pageSize, wxid);

      expect(service.getRoomList).toHaveBeenCalledWith(token, current, pageSize, wxid);
      expect(result).toEqual(mockResult);
    });

    it('should call roomService.getRoomList without optional wxid', async () => {
      const token = 'test-token';
      const current = 1;
      const pageSize = 5;
      const mockResult = { data: [], total: 0 };

      mockRoomService.getRoomList.mockResolvedValue(mockResult);

      const result = await controller.getRoomList(token, current, pageSize);

      expect(service.getRoomList).toHaveBeenCalledWith(token, current, pageSize, undefined);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from roomService.getRoomList', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 10;
      const error = new Error('Service error');

      mockRoomService.getRoomList.mockRejectedValue(error);

      await expect(controller.getRoomList(token, current, pageSize)).rejects.toThrow(
        'Service error',
      );
    });
  });

  describe('getEnterpriseGroupChatList', () => {
    it('should call roomService.getEnterpriseGroupChatList with all parameters', async () => {
      const token = 'test-enterprise-token';
      const current = 1;
      const pageSize = 20;
      const imBotId = 'bot123';
      const wecomUserId = 'user456';
      const mockResult = {
        errcode: 0,
        errmsg: 'ok',
        data: [
          {
            groupName: 'Enterprise Group 1',
            ownerId: 'owner1',
            createTime: '2024-01-01T00:00:00Z',
            members: [{ wxid: 'user1', name: 'User 1' }],
          },
        ],
        total: 1,
      };

      mockRoomService.getEnterpriseGroupChatList.mockResolvedValue(mockResult);

      const result = await controller.getEnterpriseGroupChatList(
        token,
        current,
        pageSize,
        imBotId,
        wecomUserId,
      );

      expect(service.getEnterpriseGroupChatList).toHaveBeenCalledWith(
        token,
        current,
        pageSize,
        imBotId,
        wecomUserId,
      );
      expect(result).toEqual(mockResult);
    });

    it('should call roomService.getEnterpriseGroupChatList with only token', async () => {
      const token = 'test-enterprise-token';
      const mockResult = {
        errcode: 0,
        errmsg: 'ok',
        data: [],
        total: 0,
      };

      mockRoomService.getEnterpriseGroupChatList.mockResolvedValue(mockResult);

      const result = await controller.getEnterpriseGroupChatList(token);

      expect(service.getEnterpriseGroupChatList).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should call roomService.getEnterpriseGroupChatList with pagination only', async () => {
      const token = 'test-enterprise-token';
      const current = 2;
      const pageSize = 50;
      const mockResult = {
        errcode: 0,
        errmsg: 'ok',
        data: [
          {
            groupName: 'Enterprise Group 2',
            ownerId: 'owner2',
            createTime: '2024-01-02T00:00:00Z',
          },
        ],
        total: 100,
      };

      mockRoomService.getEnterpriseGroupChatList.mockResolvedValue(mockResult);

      const result = await controller.getEnterpriseGroupChatList(token, current, pageSize);

      expect(service.getEnterpriseGroupChatList).toHaveBeenCalledWith(
        token,
        current,
        pageSize,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from roomService.getEnterpriseGroupChatList', async () => {
      const token = 'test-enterprise-token';
      const error = new Error('Enterprise API error');

      mockRoomService.getEnterpriseGroupChatList.mockRejectedValue(error);

      await expect(controller.getEnterpriseGroupChatList(token)).rejects.toThrow(
        'Enterprise API error',
      );
    });
  });

  describe('addMember', () => {
    it('should call roomService.addMember with correct body', async () => {
      const mockBody = {
        token: 'test-token',
        botUserId: 'bot123',
        contactWxid: 'user456',
        roomWxid: 'room789',
      };
      const mockResult = { success: true };

      mockRoomService.addMember.mockResolvedValue(mockResult);

      const result = await controller.addMember(mockBody);

      expect(service.addMember).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from roomService.addMember', async () => {
      const mockBody = {
        token: 'test-token',
        botUserId: 'bot123',
        contactWxid: 'user456',
        roomWxid: 'room789',
      };
      const error = new Error('Add member failed');

      mockRoomService.addMember.mockRejectedValue(error);

      await expect(controller.addMember(mockBody)).rejects.toThrow('Add member failed');
    });
  });

  describe('addFriendFromRoom', () => {
    it('should call roomService.addFriendFromRoom with all parameters', async () => {
      const mockBody = {
        token: 'test-token',
        roomId: 'room123',
        contactId: 'contact456',
        remark: 'New friend',
        helloMsg: 'Hello!',
        extraInfo: 'Extra info',
        userId: 'user789',
      };
      const mockResult = { success: true, requestId: 'req123' };

      mockRoomService.addFriendFromRoom.mockResolvedValue(mockResult);

      const result = await controller.addFriendFromRoom(mockBody);

      expect(service.addFriendFromRoom).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should call roomService.addFriendFromRoom without optional parameters', async () => {
      const mockBody = {
        token: 'test-token',
        roomId: 'room123',
        contactId: 'contact456',
        helloMsg: 'Hello!',
        userId: 'user789',
      };
      const mockResult = { success: true };

      mockRoomService.addFriendFromRoom.mockResolvedValue(mockResult);

      const result = await controller.addFriendFromRoom(mockBody);

      expect(service.addFriendFromRoom).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from roomService.addFriendFromRoom', async () => {
      const mockBody = {
        token: 'test-token',
        roomId: 'room123',
        contactId: 'contact456',
        helloMsg: 'Hello!',
        userId: 'user789',
      };
      const error = new Error('Add friend failed');

      mockRoomService.addFriendFromRoom.mockRejectedValue(error);

      await expect(controller.addFriendFromRoom(mockBody)).rejects.toThrow('Add friend failed');
    });
  });

  describe('handleJoinedCallback', () => {
    it('should call roomService.handleJoinedCallback with correct body', async () => {
      const mockBody = {
        token: 'test-token',
        botUserId: 'bot123',
        contactWxid: 'user456',
        roomWxid: 'room789',
        status: 'success',
        timestamp: 1234567890,
      };
      const mockResult = { received: true };

      mockRoomService.handleJoinedCallback.mockResolvedValue(mockResult);

      const result = await controller.handleJoinedCallback(mockBody);

      expect(service.handleJoinedCallback).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle failed join status', async () => {
      const mockBody = {
        token: 'test-token',
        botUserId: 'bot123',
        contactWxid: 'user456',
        roomWxid: 'room789',
        status: 'failed',
        timestamp: 1234567890,
      };
      const mockResult = { received: true };

      mockRoomService.handleJoinedCallback.mockResolvedValue(mockResult);

      const result = await controller.handleJoinedCallback(mockBody);

      expect(service.handleJoinedCallback).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from roomService.handleJoinedCallback', async () => {
      const mockBody = {
        token: 'test-token',
        botUserId: 'bot123',
        contactWxid: 'user456',
        roomWxid: 'room789',
        status: 'success',
        timestamp: 1234567890,
      };
      const error = new Error('Callback handling failed');

      mockRoomService.handleJoinedCallback.mockRejectedValue(error);

      await expect(controller.handleJoinedCallback(mockBody)).rejects.toThrow(
        'Callback handling failed',
      );
    });
  });
});
