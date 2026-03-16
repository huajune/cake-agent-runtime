import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SpongeService } from './sponge.service';

describe('SpongeService', () => {
  let service: SpongeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpongeService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-token') },
        },
      ],
    }).compile();

    service = module.get<SpongeService>(SpongeService);
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
        age: '22',
        genderId: 1,
        jobId: 100,
        interviewTime: '2026-04-01 10:00:00',
        educationId: 5,
        hasHealthCertificate: 1,
      });

      expect(result.success).toBe(true);
      expect(result.notice).toBe('预约成功');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
