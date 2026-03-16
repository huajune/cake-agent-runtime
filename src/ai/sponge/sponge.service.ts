import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobListQueryParams,
  JobListResult,
  InterviewBookingParams,
  InterviewBookingResult,
} from './sponge.types';

const JOB_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/job/list';
const INTERVIEW_BOOKING_API = 'https://k8s.duliday.com/persistence/a/supplier/entryUser';

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT = 'desc';
const DEFAULT_SORT_FIELD = 'create_time';

/**
 * 海绵数据服务 — 杜力岱业务数据 HTTP 客户端
 *
 * 负责调用海绵平台 API（岗位查询、面试预约等）。
 * Token 通过 ConfigService 内部管理，工具层无需关心认证。
 */
@Injectable()
export class SpongeService {
  private readonly logger = new Logger(SpongeService.name);
  private readonly token: string;

  constructor(private readonly configService: ConfigService) {
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
    if (data.code !== 0) {
      this.logger.warn('岗位查询返回非零: ' + (data.message || data.code));
      return { jobs: [], total: 0 };
    }

    return {
      jobs: data.data?.result || [],
      total: data.data?.total || 0,
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

    const data = await response.json();
    const isSuccess = data.code === 0;

    if (!isSuccess) {
      this.logger.warn('预约失败: ' + (data.message || '未知错误'));
    }

    return {
      success: isSuccess,
      code: data.code,
      message: data.message,
      notice: data.data?.notice ?? null,
      errorList: data.data?.errorList ?? null,
    };
  }
}
