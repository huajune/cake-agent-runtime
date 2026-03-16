import { Test, TestingModule } from '@nestjs/testing';
import { CustomerService } from '@wecom/customer/customer.service';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

describe('CustomerService', () => {
  let service: CustomerService;

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      customer: {
        list: jest.fn().mockReturnValue('https://api.example.com/customer/list'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<CustomerService>(CustomerService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getCustomerListV2', () => {
    it('should return customer list with only token', async () => {
      const token = 'enterprise-token';
      const mockResult = {
        data: [{ customerId: 'c-1', name: 'Customer 1' }],
        total: 1,
      };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getCustomerListV2(token);

      expect(mockApiConfig.endpoints.customer.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/customer/list', {
        token,
      });
      expect(result).toEqual(mockResult);
    });

    it('should include wecomUserId when provided', async () => {
      const token = 'enterprise-token';
      const wecomUserId = 'user-123';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, wecomUserId);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, wecomUserId });
    });

    it('should include imBotId when provided', async () => {
      const token = 'enterprise-token';
      const imBotId = 'bot-456';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, imBotId);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, imBotId });
    });

    it('should include coworker when set to true', async () => {
      const token = 'enterprise-token';
      const coworker = true;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, undefined, coworker);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        coworker: true,
      });
    });

    it('should include coworker when set to false', async () => {
      const token = 'enterprise-token';
      const coworker = false;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, undefined, coworker);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        coworker: false,
      });
    });

    it('should include current page when provided', async () => {
      const token = 'enterprise-token';
      const current = 3;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, undefined, undefined, current);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, current });
    });

    it('should include pageSize when provided', async () => {
      const token = 'enterprise-token';
      const pageSize = 100;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, undefined, undefined, undefined, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, pageSize });
    });

    it('should include all parameters when all are provided', async () => {
      const token = 'enterprise-token';
      const wecomUserId = 'user-123';
      const imBotId = 'bot-456';
      const coworker = true;
      const current = 1;
      const pageSize = 20;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, wecomUserId, imBotId, coworker, current, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        wecomUserId,
        imBotId,
        coworker,
        current,
        pageSize,
      });
    });

    it('should not add wecomUserId to params when it is empty string', async () => {
      const token = 'enterprise-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, '');

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('wecomUserId');
    });

    it('should not add imBotId to params when it is empty string', async () => {
      const token = 'enterprise-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, '');

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('imBotId');
    });

    it('should not add current to params when it is undefined', async () => {
      const token = 'enterprise-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getCustomerListV2(token, undefined, undefined, undefined, undefined);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('current');
    });

    it('should throw error when API call fails', async () => {
      const token = 'enterprise-token';
      const error = new Error('Service unavailable');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getCustomerListV2(token)).rejects.toThrow('Service unavailable');
    });

    it('should re-throw the original error object', async () => {
      const token = 'enterprise-token';
      const originalError = new Error('Timeout');

      mockHttpService.get.mockRejectedValue(originalError);

      await expect(service.getCustomerListV2(token)).rejects.toBe(originalError);
    });
  });
});
