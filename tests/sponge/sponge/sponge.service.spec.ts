import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SpongeService } from '@sponge/sponge.service';
import { SpongeBiService } from '@sponge/sponge-bi.service';
import { RedisService } from '@infra/redis/redis.service';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';

describe('SpongeService', () => {
  let service: SpongeService;
  let biService: {
    fetchBIOrders: jest.Mock;
    refreshBIDataSource: jest.Mock;
    refreshBIDataSourceAndWait: jest.Mock;
  };
  let hostingMemberConfigService: {
    resolveDulidayToken: jest.Mock;
  };
  let redisService: { get: jest.Mock; setex: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    hostingMemberConfigService = {
      resolveDulidayToken: jest.fn().mockResolvedValue(null),
    };

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
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            setex: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          // token→null：默认回退 DULIDAY_API_TOKEN（ConfigService mock 返回 'test-token'）。
          provide: HostingMemberConfigService,
          useValue: hostingMemberConfigService,
        },
      ],
    }).compile();

    service = module.get<SpongeService>(SpongeService);
    biService = module.get(SpongeBiService);
    redisService = module.get(RedisService);
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

    it('should throw on non-zero code (do not silently swallow API errors)', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 1, message: '失败' }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await expect(service.fetchJobs({})).rejects.toThrow('岗位查询失败: 失败');
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

    it('resolves the Duliday token from hosting_member_config by botImId', async () => {
      hostingMemberConfigService.resolveDulidayToken.mockResolvedValueOnce('member-token');
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: { result: [], total: 0 },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await service.fetchJobs({}, { botImId: 'bot-im-1' });

      expect(hostingMemberConfigService.resolveDulidayToken).toHaveBeenCalledWith('bot-im-1');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('job/list'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Duliday-Token': 'member-token',
          }),
        }),
      );
    });

    it('falls back to DULIDAY_API_TOKEN when hosting_member_config has no token', async () => {
      // hostingMemberConfigService.resolveDulidayToken 默认 mock 返回 null
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: { result: [], total: 0 },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await service.fetchJobs({}, { botImId: 'bot-im-1' });

      expect(hostingMemberConfigService.resolveDulidayToken).toHaveBeenCalledWith('bot-im-1');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('job/list'),
        expect.objectContaining({
          headers: expect.objectContaining({
            // ConfigService mock 对所有 key 返回 'test-token'（即 DULIDAY_API_TOKEN 兜底）
            'Duliday-Token': 'test-token',
          }),
        }),
      );
    });
  });

  describe('fetchSelfSignupWorkOrders', () => {
    it('uses the hosting-member Duliday token and posts only time filters', async () => {
      hostingMemberConfigService.resolveDulidayToken.mockResolvedValueOnce('member-token');
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: {
            total: 1,
            workOrders: [
              {
                workOrderId: 9001,
                candidateName: '张三',
                phone: '13800138000',
                signUpTime: '2026-06-09 20:10:00',
              },
            ],
          },
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchSelfSignupWorkOrders(
        {
          queryParam: {
            signUpStartTime: '2026-06-09 00:00:00',
            signUpEndTime: '2026-06-09 23:59:59',
          },
        },
        { botImId: 'bot-im-1' },
      );

      expect(result.total).toBe(1);
      expect(result.workOrders[0].candidateName).toBe('张三');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ai/api/workorder/signup/self/list'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Duliday-Token': 'member-token',
          }),
          body: JSON.stringify({
            queryParam: {
              signUpStartTime: '2026-06-09 00:00:00',
              signUpEndTime: '2026-06-09 23:59:59',
            },
          }),
        }),
      );
    });

    it('does not fall back to the global token for self/list', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(
        service.fetchSelfSignupWorkOrders(
          {
            queryParam: {
              signUpStartTime: '2026-06-09 00:00:00',
              signUpEndTime: '2026-06-09 23:59:59',
            },
          },
          { botImId: 'unknown-bot' },
        ),
      ).rejects.toThrow('缺少 DULIDAY_API_TOKEN');

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('bookInterview', () => {
    it('should call booking API and return result', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers({ Traceid: 'trace-success-1' }),
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
      expect(result.traceId).toBe('trace-success-1');
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
        headers: new Headers({ Traceid: 'trace-invalid-1' }),
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
      // traceId 在结构解析失败时仍要带出来，方便后端定位是哪次海绵请求返回了坏结构。
      expect(result.traceId).toBe('trace-invalid-1');
    });

    it('should carry traceId from response header into failure result', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers({ Traceid: 'trace-fail-1' }),
        json: jest.fn().mockResolvedValue({
          code: 500,
          message: '麻麻呀，服务器暂时跑丢了～',
          data: null,
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
      expect(result.message).toBe('麻麻呀，服务器暂时跑丢了～');
      expect(result.traceId).toBe('trace-fail-1');
    });
  });

  describe('uploadAttachmentFromUrl', () => {
    it('should download the source file, upload multipart attachment, and return cloudStorageKey', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4\nfake resume');
      const downloadResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => {
            if (name.toLowerCase() === 'content-length') return String(pdfBuffer.byteLength);
            if (name.toLowerCase() === 'content-type') return 'application/pdf';
            return null;
          },
        },
        arrayBuffer: jest
          .fn()
          .mockResolvedValue(
            pdfBuffer.buffer.slice(
              pdfBuffer.byteOffset,
              pdfBuffer.byteOffset + pdfBuffer.byteLength,
            ),
          ),
      };
      const uploadResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue({
          code: 0,
          message: 'success',
          data: {
            fileName: '张三简历.pdf',
            cloudStorageKey: 'resume/cloud/key.pdf',
          },
        }),
      };
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(downloadResponse as unknown as Response)
        .mockResolvedValueOnce(uploadResponse as unknown as Response);

      const result = await service.uploadAttachmentFromUrl({
        fileUrl: 'https://wecom.example.com/file/resume.pdf',
        fileName: '张三简历.pdf',
      });

      expect(result).toEqual({
        fileName: '张三简历.pdf',
        cloudStorageKey: 'resume/cloud/key.pdf',
      });
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'https://wecom.example.com/file/resume.pdf',
        expect.objectContaining({
          method: 'GET',
        }),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/a/supplier/uploadAttachment'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Duliday-Token': 'test-token',
          },
        }),
      );

      const uploadBody = (global.fetch as jest.Mock).mock.calls[1][1].body as FormData;
      const file = uploadBody.get('file') as File;
      expect(file.name).toBe('张三简历.pdf');
      expect(file.type).toBe('application/pdf');
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

  describe('cancelWorkOrder', () => {
    it('posts to the cancel endpoint and invalidates the work order cache on success', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 0, message: 'ok', data: 'done' }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.cancelWorkOrder({
        workOrderId: 88001,
        cancelReasonId: 12001,
        cancelReasonDesc: '当天有事',
      });

      expect(result).toEqual({ success: true, code: 0, message: 'ok' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ai/api/workorder/cancel'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            workOrderId: 88001,
            cancelReasonId: 12001,
            cancelReasonDesc: '当天有事',
          }),
        }),
      );
      expect(redisService.del).toHaveBeenCalledWith('sponge:workorder:88001');
    });

    it('returns success:false (no cache invalidation) on business code != 0', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 500, message: 'busy' }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.cancelWorkOrder({ workOrderId: 88001, cancelReasonId: 12001 });

      expect(result).toEqual({ success: false, code: 500, message: 'busy' });
      expect(redisService.del).not.toHaveBeenCalled();
    });

    it('throws when the cancel endpoint returns non-2xx', async () => {
      const mockResponse = { ok: false, status: 502, statusText: 'Bad Gateway' };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await expect(
        service.cancelWorkOrder({ workOrderId: 88001, cancelReasonId: 12001 }),
      ).rejects.toThrow('取消工单失败');
    });
  });

  describe('modifyInterviewTime', () => {
    it('posts to the modify endpoint and invalidates the work order cache on success', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 0, message: 'ok' }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.modifyInterviewTime({
        workOrderId: 88001,
        newInterviewTime: '2026-06-20 14:00',
      });

      expect(result).toEqual({ success: true, code: 0, message: 'ok' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ai/api/workorder/interviewTime/modify'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ workOrderId: 88001, newInterviewTime: '2026-06-20 14:00' }),
        }),
      );
      expect(redisService.del).toHaveBeenCalledWith('sponge:workorder:88001');
    });
  });

  describe('fetchFailureReasonsByPids', () => {
    it('flattens leaf reasons from grouped dictionary response', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: [
            {
              pid: 12001,
              info: '约面取消',
              failureReasonsDTOList: [
                { id: 12010, info: '候选人主动取消' },
                { id: 12011, info: '时间冲突' },
              ],
            },
          ],
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchFailureReasonsByPids([12001]);

      expect(result).toEqual([
        { id: 12010, info: '候选人主动取消' },
        { id: 12011, info: '时间冲突' },
      ]);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ai/api/workorder/failureReasons/byPids'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ pidList: [12001] }),
        }),
      );
    });

    it('serves the second call from cache (no second fetch)', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: [{ pid: 12001, failureReasonsDTOList: [{ id: 12010, info: '候选人主动取消' }] }],
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      await service.fetchFailureReasonsByPids([12001]);
      await service.fetchFailureReasonsByPids([12001]);

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('clears the local failure-reasons cache when pid combinations exceed the cap', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: [{ pid: 1, failureReasonsDTOList: [{ id: 12010, info: '候选人主动取消' }] }],
        }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      for (let pid = 1; pid <= 51; pid++) {
        await service.fetchFailureReasonsByPids([pid]);
      }
      await service.fetchFailureReasonsByPids([1]);

      expect(global.fetch).toHaveBeenCalledTimes(52);
    });

    it('returns [] on business code != 0', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 1, message: 'bad' }),
      };
      jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

      const result = await service.fetchFailureReasonsByPids([99999]);

      expect(result).toEqual([]);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
