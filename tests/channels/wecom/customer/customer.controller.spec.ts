import { Test, TestingModule } from '@nestjs/testing';
import { CustomerController } from '@wecom/customer/customer.controller';
import { CustomerService } from '@wecom/customer/customer.service';

describe('CustomerController', () => {
  let controller: CustomerController;
  let service: CustomerService;

  const mockCustomerService = {
    getCustomerListV2: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CustomerController],
      providers: [
        {
          provide: CustomerService,
          useValue: mockCustomerService,
        },
      ],
    }).compile();

    controller = module.get<CustomerController>(CustomerController);
    service = module.get<CustomerService>(CustomerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getCustomerListV2', () => {
    it('should call customerService.getCustomerListV2 with all parameters', async () => {
      const token = 'test-token';
      const wecomUserId = 'user123';
      const imBotId = 'bot456';
      const coworker = true;
      const current = 0;
      const pageSize = 20;
      const mockResult = {
        data: [
          { customerId: 'customer1', name: 'Customer 1' },
          { customerId: 'customer2', name: 'Customer 2' },
        ],
        total: 2,
      };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(
        token,
        wecomUserId,
        imBotId,
        coworker,
        current,
        pageSize,
      );

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        wecomUserId,
        imBotId,
        coworker,
        current,
        pageSize,
      );
      expect(result).toEqual(mockResult);
    });

    it('should call customerService.getCustomerListV2 with only required token', async () => {
      const token = 'test-token';
      const mockResult = { data: [], total: 0 };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(token);

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should filter by wecomUserId when provided', async () => {
      const token = 'test-token';
      const wecomUserId = 'user123';
      const mockResult = {
        data: [{ customerId: 'customer1', name: 'Customer 1', wecomUserId: 'user123' }],
        total: 1,
      };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(token, wecomUserId);

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        wecomUserId,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should filter by imBotId when provided', async () => {
      const token = 'test-token';
      const imBotId = 'bot456';
      const mockResult = {
        data: [{ customerId: 'customer1', name: 'Customer 1', imBotId: 'bot456' }],
        total: 1,
      };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(token, undefined, imBotId);

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        undefined,
        imBotId,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should filter by coworker status', async () => {
      const token = 'test-token';
      const coworker = true;
      const mockResult = {
        data: [{ customerId: 'customer1', name: 'Coworker 1', isCoworker: true }],
        total: 1,
      };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(token, undefined, undefined, coworker);

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        coworker,
        undefined,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should handle pagination correctly', async () => {
      const token = 'test-token';
      const current = 1;
      const pageSize = 10;
      const mockResult = {
        data: [{ customerId: 'customer11', name: 'Customer 11' }],
        total: 25,
      };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(
        token,
        undefined,
        undefined,
        undefined,
        current,
        pageSize,
      );

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        undefined,
        undefined,
        undefined,
        current,
        pageSize,
      );
      expect(result).toEqual(mockResult);
    });

    it('should handle multiple filters combined', async () => {
      const token = 'test-token';
      const wecomUserId = 'user123';
      const imBotId = 'bot456';
      const coworker = false;
      const current = 0;
      const pageSize = 15;
      const mockResult = { data: [], total: 0 };

      mockCustomerService.getCustomerListV2.mockResolvedValue(mockResult);

      const result = await controller.getCustomerListV2(
        token,
        wecomUserId,
        imBotId,
        coworker,
        current,
        pageSize,
      );

      expect(service.getCustomerListV2).toHaveBeenCalledWith(
        token,
        wecomUserId,
        imBotId,
        coworker,
        current,
        pageSize,
      );
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from customerService.getCustomerListV2', async () => {
      const token = 'test-token';
      const error = new Error('Service error');

      mockCustomerService.getCustomerListV2.mockRejectedValue(error);

      await expect(controller.getCustomerListV2(token)).rejects.toThrow('Service error');
    });
  });
});
