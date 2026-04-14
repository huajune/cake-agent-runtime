import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SpongeService } from '@sponge/sponge.service';
import { SpongeBiService } from '@sponge/sponge-bi.service';

describe('SpongeService', () => {
  let service: SpongeService;
  let biService: {
    fetchBIOrders: jest.Mock;
    refreshBIDataSource: jest.Mock;
    refreshBIDataSourceAndWait: jest.Mock;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpongeService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-token') },
        },
        {
          provide: SpongeBiService,
          useValue: {
            fetchBIOrders: jest.fn(),
            refreshBIDataSource: jest.fn(),
            refreshBIDataSourceAndWait: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SpongeService>(SpongeService);
    biService = module.get(SpongeBiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('fetchJobs', () => {
    it('should call job list API and return results', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: { result: [{ basicInfo: { jobId: 1 } }], total: 1 },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchJobs({ cityNameList: ['上海'] });

      expect(result.jobs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('job/list'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should pass location filter in job list request body', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: { result: [], total: 0 },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await service.fetchJobs({
        cityNameList: ['上海'],
        location: {
          longitude: 121.4996,
          latitude: 31.2397,
          range: 10000,
        },
      });

      const [, requestInit] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(requestInit.body));

      expect(body.queryParam).toEqual(
        expect.objectContaining({
          cityNameList: ['上海'],
          location: {
            longitude: 121.4996,
            latitude: 31.2397,
            range: 10000,
          },
        }),
      );
    });

    it('should tolerate null optional fields in job list response', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: {
            result: [
              {
                basicInfo: {
                  jobId: 1,
                  jobName: '测试岗位',
                  jobNickName: null,
                  jobCategoryName: '餐饮/服务员',
                  brandName: '必胜客',
                  cityName: '上海',
                },
              },
            ],
            total: 1,
          },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchJobs({ cityNameList: ['上海'] });

      expect(result.jobs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.jobs[0].basicInfo?.jobNickName).toBeNull();
    });

    it('should return empty result on non-zero code', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 1, message: '失败' }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchJobs({});

      expect(result.jobs).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should throw on HTTP error', async () => {
      const mockResponse = { ok: false, status: 500, statusText: 'Server Error' };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await expect(service.fetchJobs({})).rejects.toThrow('API请求失败');
    });

    it('should return empty result when API response shape is invalid', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: { result: 'invalid', total: 'bad' },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchJobs({});

      expect(result).toEqual({ jobs: [], total: 0 });
    });
  });

  describe('bookInterview', () => {
    it('should call booking API and return result', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          message: 'success',
          data: { notice: '预约成功', errorList: null },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.bookInterview({
        name: '张三',
        phone: '13800138000',
        age: 22,
        genderId: 1,
        jobId: 100,
        interviewTime: '2026-04-01 10:00:00',
        operateType: 6,
        educationId: 5,
        hasHealthCertificate: 1,
      });

      expect(result.success).toBe(true);
      expect(result.notice).toBe('预约成功');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/a/supplier/entryUser'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Duliday-Token': 'test-token',
          }),
          body: JSON.stringify({
            jobId: 100,
            interviewTime: '2026-04-01 10:00:00',
            name: '张三',
            phone: '13800138000',
            age: 22,
            genderId: 1,
            hasHealthCertificate: 1,
            educationId: 5,
            operateType: 6,
          }),
        }),
      );
    });

    it('should return failure result when booking response shape is invalid', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: '0',
          data: 'invalid',
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.bookInterview({
        name: '张三',
        phone: '13800138000',
        age: 22,
        genderId: 1,
        jobId: 100,
        interviewTime: '2026-04-01 10:00:00',
        operateType: 6,
        educationId: 5,
        hasHealthCertificate: 1,
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('预约接口返回结构异常');
    });
  });

  describe('fetchInterviewSchedule', () => {
    it('should tolerate missing gender and age fields in interview schedule response', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: {
            result: [
              {
                name: '张三',
                phone: '13800138000',
                interviewTime: '2026-04-08 10:00',
                jobName: '店员',
                storeName: '春熙路店',
                brandName: '成都你六姐',
              },
            ],
          },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchInterviewSchedule({
        interviewStartTime: '2026-04-08 00:00:00',
        interviewEndTime: '2026-04-08 23:59:59',
      });

      expect(result).toEqual([
        {
          name: '张三',
          phone: '13800138000',
          gender: undefined,
          age: undefined,
          interviewTime: '2026-04-08 10:00',
          jobName: '店员',
          storeName: '春熙路店',
          brandName: '成都你六姐',
        },
      ]);
    });
  });

  describe('fetchBrandList', () => {
    it('should cache brand list results for repeated calls', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: {
            result: [{ name: '来伊份', aliases: ['来一份'], projectIdList: [1] }],
          },
        }),
      };
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(mockResponse as unknown as Response);

      const first = await service.fetchBrandList();
      const second = await service.fetchBrandList();

      expect(first).toEqual([{ name: '来伊份', aliases: ['来一份'] }]);
      expect(second).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should fall back to empty list when brand response shape is invalid', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: { result: [{ aliases: ['缺少 name'] }] },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchBrandList();

      expect(result).toEqual([]);
    });
  });

  describe('refreshBIDataSourceAndWait', () => {
    it('should delegate to SpongeBiService.refreshBIDataSourceAndWait', async () => {
      biService.refreshBIDataSourceAndWait.mockResolvedValue(true);

      const result = await service.refreshBIDataSourceAndWait();

      expect(result).toBe(true);
      expect(biService.refreshBIDataSourceAndWait).toHaveBeenCalledTimes(1);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
