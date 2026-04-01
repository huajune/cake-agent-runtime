import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobListQueryParams,
  JobListResult,
  InterviewBookingParams,
  InterviewBookingResult,
  BrandItem,
  RawBrandItem,
  BrandListApiResponseSchema,
  InterviewBookingApiResponseSchema,
  InterviewScheduleParams,
  InterviewScheduleItem,
  InterviewScheduleApiResponseSchema,
  BIOrderQueryParams,
  BIOrder,
  JobListApiResponseSchema,
} from './sponge.types';
import { SpongeBiService } from './sponge-bi.service';

const JOB_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/job/list';
const BRAND_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/brand/list';
const INTERVIEW_BOOKING_API = 'https://k8s.duliday.com/persistence/a/supplier/entryUser';
const INTERVIEW_SCHEDULE_API = 'https://k8s.duliday.com/persistence/ai/api/interview/schedule';

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT = 'desc';
const DEFAULT_SORT_FIELD = 'create_time';
const BRAND_LIST_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * 海绵数据服务 — 杜力岱业务数据 HTTP 客户端
 *
 * 负责调用海绵平台 API（岗位查询、面试预约等）。
 * Token 通过 ConfigService 内部管理，工具层无需关心认证。
 * BI 相关功能委托给 SpongeBiService。
 */
@Injectable()
export class SpongeService {
  private readonly logger = new Logger(SpongeService.name);
  private readonly token: string;
  private brandListCache: { data: BrandItem[]; fetchedAt: number } | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly biService: SpongeBiService,
  ) {
    this.token = this.configService.get<string>('DULIDAY_API_TOKEN', '');
  }

  /** 查询在招岗位列表 */
  async fetchJobs(params: JobListQueryParams): Promise<JobListResult> {
    if (!this.token) {
      throw new Error('缺少 DULIDAY_API_TOKEN');
    }

    const requestBody = {
      pageNum: params.pageNum ?? DEFAULT_PAGE_NUM,
      pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
      sort: params.sort ?? DEFAULT_SORT,
      sortField: params.sortField ?? DEFAULT_SORT_FIELD,
      queryParam: {
        ...(params.cityNameList?.length && { cityNameList: params.cityNameList }),
        ...(params.regionNameList?.length && { regionNameList: params.regionNameList }),
        ...(params.brandAliasList?.length && { brandAliasList: params.brandAliasList }),
        ...(params.brandIdList?.length && { brandIdList: params.brandIdList }),
        ...(params.projectNameList?.length && { projectNameList: params.projectNameList }),
        ...(params.projectIdList?.length && { projectIdList: params.projectIdList }),
        ...(params.storeNameList?.length && { storeNameList: params.storeNameList }),
        ...(params.jobCategoryList?.length && { jobCategoryList: params.jobCategoryList }),
        ...(params.jobIdList?.length && { jobIdList: params.jobIdList }),
      },
      options: params.options ?? { includeBasicInfo: true },
    };

    const response = await fetch(JOB_LIST_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Duliday-Token': this.token,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const parsed = JobListApiResponseSchema.safeParse(data);
    if (!parsed.success) {
      this.logger.warn(
        `岗位查询返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { jobs: [], total: 0 };
    }

    if (parsed.data.code !== 0) {
      this.logger.warn('岗位查询返回非零: ' + (data.message || data.code));
      return { jobs: [], total: 0 };
    }

    return {
      jobs: parsed.data.data?.result ?? [],
      total: parsed.data.data?.total ?? 0,
    };
  }

  /** 预约面试 */
  async bookInterview(params: InterviewBookingParams): Promise<InterviewBookingResult> {
    if (!this.token) {
      throw new Error('缺少 DULIDAY_API_TOKEN');
    }

    this.logger.log(`预约面试: ${params.name}, jobId=${params.jobId}`);

    const response = await fetch(INTERVIEW_BOOKING_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'duliday-token': this.token,
      },
      body: JSON.stringify({
        name: params.name,
        age: params.age,
        phone: params.phone,
        genderId: params.genderId,
        educationId: params.educationId,
        hasHealthCertificate: params.hasHealthCertificate,
        interviewTime: params.interviewTime,
        customerLabelList: [],
        jobId: params.jobId,
        operateType: 6,
      }),
    });

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const parsed = InterviewBookingApiResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      this.logger.warn(
        `预约接口返回结构异常: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return {
        success: false,
        code: -1,
        message: '预约接口返回结构异常',
        notice: null,
        errorList: null,
      };
    }

    const isSuccess = parsed.data.code === 0;

    if (!isSuccess) {
      this.logger.warn('预约失败: ' + (parsed.data.message || '未知错误'));
    }

    return {
      success: isSuccess,
      code: parsed.data.code,
      message: parsed.data.message,
      notice: parsed.data.data?.notice ?? null,
      errorList: parsed.data.data?.errorList ?? null,
    };
  }

  /**
   * 获取品牌列表（含别名）
   *
   * 返回 { name, aliases }[] 格式，供事实提取时品牌别名映射使用。
   * API 不可用时返回空数组（graceful 降级）。
   */
  async fetchBrandList(): Promise<BrandItem[]> {
    const now = Date.now();
    if (
      this.brandListCache &&
      now - this.brandListCache.fetchedAt < BRAND_LIST_CACHE_TTL_MS &&
      this.brandListCache.data.length > 0
    ) {
      return this.brandListCache.data;
    }

    if (!this.token) {
      this.logger.warn('缺少 DULIDAY_API_TOKEN，品牌列表不可用');
      return this.brandListCache?.data ?? [];
    }

    try {
      const response = await fetch(BRAND_LIST_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Duliday-Token': this.token,
        },
        body: JSON.stringify({ pageNum: 1, pageSize: 1000 }),
      });

      if (!response.ok) {
        this.logger.warn(`品牌列表 API 返回 ${response.status}`);
        return this.brandListCache?.data ?? [];
      }

      const rawData = await response.json();
      const parsed = BrandListApiResponseSchema.safeParse(rawData);
      if (!parsed.success) {
        this.logger.warn(
          `品牌列表返回结构异常: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        );
        return this.brandListCache?.data ?? [];
      }

      if (parsed.data.code !== 0 || !parsed.data.data?.result) {
        this.logger.warn('品牌列表返回非零: ' + (parsed.data.message || parsed.data.code));
        return this.brandListCache?.data ?? [];
      }

      const brandList = (parsed.data.data.result as RawBrandItem[]).map((item) => ({
        name: item.name,
        aliases: (item.aliases ?? []).filter((a: string) => a !== item.name),
      }));

      this.brandListCache = {
        data: brandList,
        fetchedAt: now,
      };

      return brandList;
    } catch (err) {
      this.logger.warn('品牌列表获取失败，降级为空列表', err);
      return this.brandListCache?.data ?? [];
    }
  }

  // ==================== 观远BI（委托 SpongeBiService）====================

  async fetchBIOrders(params: BIOrderQueryParams): Promise<BIOrder[]> {
    return this.biService.fetchBIOrders(params);
  }

  async refreshBIDataSource(): Promise<boolean> {
    return this.biService.refreshBIDataSource();
  }

  // ==================== 海绵面试名单 ====================

  /**
   * 获取面试名单
   *
   * POST /persistence/ai/api/interview/schedule
   * 认证方式与岗位接口一致（Duliday-Token）
   */
  async fetchInterviewSchedule(params: InterviewScheduleParams): Promise<InterviewScheduleItem[]> {
    if (!this.token) {
      this.logger.warn('缺少 DULIDAY_API_TOKEN，面试名单不可用');
      return [];
    }

    try {
      const requestBody: Record<string, unknown> = {
        pageNum: params.pageNum ?? 1,
        pageSize: params.pageSize ?? 100,
        queryParam: {
          interviewStartTime: params.interviewStartTime,
          interviewEndTime: params.interviewEndTime,
          ...(params.cityName && { cityName: params.cityName }),
          ...(params.brandName && { brandName: params.brandName }),
        },
      };

      const response = await fetch(INTERVIEW_SCHEDULE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Duliday-Token': this.token,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
      }

      const rawData = await response.json();
      const parsed = InterviewScheduleApiResponseSchema.safeParse(rawData);
      if (!parsed.success) {
        this.logger.warn(
          `面试名单返回结构异常: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        );
        return [];
      }

      if (parsed.data.code !== 0) {
        this.logger.warn('面试名单查询返回非零: ' + (parsed.data.message || parsed.data.code));
        return [];
      }

      return (parsed.data.data?.result as InterviewScheduleItem[]) || [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取面试名单失败: ${message}`);
      throw new Error(`面试名单获取失败: ${message}`);
    }
  }
}
