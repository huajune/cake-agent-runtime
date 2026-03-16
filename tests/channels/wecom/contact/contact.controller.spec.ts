import { Test, TestingModule } from '@nestjs/testing';
import { ContactController } from '@wecom/contact/contact.controller';
import { ContactService } from '@wecom/contact/contact.service';

describe('ContactController', () => {
  let controller: ContactController;
  let service: ContactService;

  const mockContactService = {
    getContactList: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContactController],
      providers: [
        {
          provide: ContactService,
          useValue: mockContactService,
        },
      ],
    }).compile();

    controller = module.get<ContactController>(ContactController);
    service = module.get<ContactService>(ContactService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getContactList', () => {
    it('should call contactService.getContactList with all parameters', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 20;
      const wxid = 'wxid_123';
      const includeStranger = true;
      const mockResult = { data: [], total: 0 };

      mockContactService.getContactList.mockResolvedValue(mockResult);

      const result = await controller.getContactList(
        token,
        current,
        pageSize,
        wxid,
        includeStranger,
      );

      expect(service.getContactList).toHaveBeenCalledWith(
        token,
        current,
        pageSize,
        wxid,
        includeStranger,
      );
      expect(result).toEqual(mockResult);
    });

    it('should call contactService.getContactList with only required token', async () => {
      const token = 'test-token';
      const mockResult = { data: [], total: 0 };

      mockContactService.getContactList.mockResolvedValue(mockResult);

      const result = await controller.getContactList(token);

      expect(service.getContactList).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should call contactService.getContactList with pagination', async () => {
      const token = 'test-token';
      const current = 1;
      const pageSize = 10;
      const mockResult = {
        data: [
          { wxid: 'user1', nickname: 'User 1' },
          { wxid: 'user2', nickname: 'User 2' },
        ],
        total: 20,
      };

      mockContactService.getContactList.mockResolvedValue(mockResult);

      const result = await controller.getContactList(token, current, pageSize);

      expect(service.getContactList).toHaveBeenCalledWith(
        token,
        current,
        pageSize,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should filter by wxid when provided', async () => {
      const token = 'test-token';
      const wxid = 'wxid_specific';
      const mockResult = {
        data: [{ wxid: 'wxid_specific', nickname: 'Specific User' }],
        total: 1,
      };

      mockContactService.getContactList.mockResolvedValue(mockResult);

      const result = await controller.getContactList(token, undefined, undefined, wxid);

      expect(service.getContactList).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        wxid,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should include strangers when includeStranger is true', async () => {
      const token = 'test-token';
      const includeStranger = true;
      const mockResult = { data: [], total: 0 };

      mockContactService.getContactList.mockResolvedValue(mockResult);

      const result = await controller.getContactList(
        token,
        undefined,
        undefined,
        undefined,
        includeStranger,
      );

      expect(service.getContactList).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        undefined,
        includeStranger,
      );
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from contactService.getContactList', async () => {
      const token = 'test-token';
      const error = new Error('Service error');

      mockContactService.getContactList.mockRejectedValue(error);

      await expect(controller.getContactList(token)).rejects.toThrow('Service error');
    });
  });
});
