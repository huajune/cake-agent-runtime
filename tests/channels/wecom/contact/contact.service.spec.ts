import { Test, TestingModule } from '@nestjs/testing';
import { ContactService } from '@wecom/contact/contact.service';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

describe('ContactService', () => {
  let service: ContactService;

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      contact: {
        list: jest.fn().mockReturnValue('https://api.example.com/contact/list'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<ContactService>(ContactService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getContactList', () => {
    it('should return contact list with only token', async () => {
      const token = 'test-token';
      const mockResult = { data: [{ wxid: 'wxid_1', nickname: 'User 1' }], total: 1 };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getContactList(token);

      expect(mockApiConfig.endpoints.contact.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/contact/list', {
        token,
      });
      expect(result).toEqual(mockResult);
    });

    it('should include current page number when provided', async () => {
      const token = 'test-token';
      const current = 2;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, current);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, current });
    });

    it('should include pageSize when provided', async () => {
      const token = 'test-token';
      const pageSize = 50;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, undefined, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, pageSize });
    });

    it('should include wxid filter when provided', async () => {
      const token = 'test-token';
      const wxid = 'wxid_specific_user';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, undefined, undefined, wxid);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, wxid });
    });

    it('should include includeStranger when set to true', async () => {
      const token = 'test-token';
      const includeStranger = true;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, undefined, undefined, undefined, includeStranger);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        includeStranger: true,
      });
    });

    it('should include includeStranger when set to false', async () => {
      const token = 'test-token';
      const includeStranger = false;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, undefined, undefined, undefined, includeStranger);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        includeStranger: false,
      });
    });

    it('should include all parameters when all are provided', async () => {
      const token = 'test-token';
      const current = 1;
      const pageSize = 20;
      const wxid = 'wxid_123';
      const includeStranger = true;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, current, pageSize, wxid, includeStranger);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        current,
        pageSize,
        wxid,
        includeStranger,
      });
    });

    it('should not add wxid to params when wxid is empty string', async () => {
      const token = 'test-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, undefined, undefined, '');

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('wxid');
    });

    it('should not add includeStranger to params when it is undefined', async () => {
      const token = 'test-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getContactList(token, undefined, undefined, undefined, undefined);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('includeStranger');
    });

    it('should throw error when API call fails', async () => {
      const token = 'test-token';
      const error = new Error('Connection refused');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getContactList(token)).rejects.toThrow('Connection refused');
    });

    it('should re-throw the original error', async () => {
      const token = 'test-token';
      const originalError = new Error('API rate limit exceeded');

      mockHttpService.get.mockRejectedValue(originalError);

      await expect(service.getContactList(token)).rejects.toBe(originalError);
    });
  });
});
