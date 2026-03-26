import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JobListQueryParams,
  JobListResult,
  InterviewBookingParams,
  InterviewBookingResult,
  BrandItem,
  RawBrandItem,
  InterviewScheduleParams,
  InterviewScheduleItem,
} from './sponge.types';
import {
  BIOrderQueryParams,
  BIOrder,
  BI_FIELD_NAMES,
  BI_FILTER_TYPES,
} from '@biz/group-task/group-task.types';

const JOB_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/job/list';
const BRAND_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/brand/list';
const INTERVIEW_BOOKING_API = 'https://k8s.duliday.com/persistence/a/supplier/entryUser';
const INTERVIEW_SCHEDULE_API = 'https://k8s.duliday.com/persistence/ai/api/interview/schedule';

// 观远BI 常量
const BI_BASE_URL = 'https://bi.duliday.com/public-api';
const BI_CARD_ID = 'd88707004062545199330960';
const BI_REFRESH_SOURCE_ID = 'sa02db85d1ae64d699f6fd4e';
const BI_PAGE_LIMIT = 200;
const BI_MAX_PAGES = 10;
const BI_PAGE_DELAY_MS = 500;

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

  /** 观远BI token 缓存 */
  private biToken: string | null = null;
  private biTokenExpiry = 0;

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

  /**
   * 获取品牌列表（含别名）
   *
   * 返回 { name, aliases }[] 格式，供事实提取时品牌别名映射使用。
   * API 不可用时返回空数组（graceful 降级）。
   */
  async fetchBrandList(): Promise<BrandItem[]> {
    if (!this.token) {
      this.logger.warn('缺少 DULIDAY_API_TOKEN，品牌列表不可用');
      return [];
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
        return [];
      }

      const data = await response.json();
      if (data.code !== 0 || !data.data?.result) {
        this.logger.warn('品牌列表返回非零: ' + (data.message || data.code));
        return [];
      }

      return (data.data.result as RawBrandItem[]).map((item) => ({
        name: item.name,
        aliases: (item.aliases ?? []).filter((a: string) => a !== item.name),
      }));
    } catch (err) {
      this.logger.warn('品牌列表获取失败，降级为空列表', err);
      return [];
    }
  }

  // ==================== 观远BI ====================

  /**
   * 获取观远BI订单数据
   *
   * 完整链路：刷新数据源(可选) → 登录 → 分页获取 → 解析 → 本地排序
   * 参考 agent-computer-user/lib/tools/duliday/bi-report-tool.ts
   */
  async fetchBIOrders(params: BIOrderQueryParams): Promise<BIOrder[]> {
    const biLoginId = this.configService.get<string>('GUANYUAN_LOGIN_ID', '');
    const biPassword = this.configService.get<string>('GUANYUAN_PASSWORD', '');

    if (!biLoginId || !biPassword) {
      this.logger.warn('缺少 GUANYUAN_LOGIN_ID/PASSWORD，BI 订单不可用');
      return [];
    }

    try {
      // 0. 刷新数据源（可选）
      if (params.refreshBeforeQuery) {
        await this.refreshBIDataSource();
        // 等待刷新完成（BI 刷新通常需要 30s+）
        await this.delay(35_000);
      }

      // 1. 登录获取 token
      const token = await this.getBIToken(biLoginId, biPassword);

      // 2. 构建过滤条件
      const filters = this.buildBIFilters(params);

      // 3. 分页获取全部数据
      const allOrders = await this.fetchAllBIPages(token, filters);

      // 4. 本地排序
      if (params.sortBy) {
        return this.sortBIOrders(allOrders, params.sortBy, params.sortOrder || 'DESC');
      }

      return allOrders;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取 BI 订单失败: ${message}`);
      throw new Error(`BI 数据获取失败: ${message}`);
    }
  }

  /**
   * 刷新 BI 数据源
   *
   * 触发异步刷新任务，通常需要 30s+ 才能完成。
   */
  async refreshBIDataSource(): Promise<boolean> {
    try {
      const refreshToken = this.configService.get<string>('GUANYUAN_REFRESH_TOKEN', '');
      if (!refreshToken) {
        this.logger.warn('缺少 GUANYUAN_REFRESH_TOKEN，无法刷新 BI 数据源');
        return false;
      }
      const url = `${BI_BASE_URL}/data-source/${BI_REFRESH_SOURCE_ID}/refresh?token=${refreshToken}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        this.logger.error(`BI 数据源刷新请求失败: ${response.status}`);
        return false;
      }

      const data = await response.json();
      if (data.result !== 'ok') {
        this.logger.error(`BI 数据源刷新失败: ${data.message || '未知错误'}`);
        return false;
      }

      this.logger.log(`BI 数据源刷新已触发，任务ID: ${data.response?.taskId || '未返回'}`);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`BI 数据源刷新异常: ${message}`);
      return false;
    }
  }

  /**
   * 构建 BI 过滤条件
   */
  private buildBIFilters(
    params: BIOrderQueryParams,
  ): Array<{ name: string; filterType: string; filterValue: string[] }> {
    const filters: Array<{ name: string; filterType: string; filterValue: string[] }> = [];

    if (params.startDate) {
      filters.push({
        name: BI_FIELD_NAMES.ORDER_DATE,
        filterType: BI_FILTER_TYPES.GREATER_EQUAL,
        filterValue: [params.startDate],
      });
    }
    if (params.endDate) {
      filters.push({
        name: BI_FIELD_NAMES.ORDER_DATE,
        filterType: BI_FILTER_TYPES.LESS_EQUAL,
        filterValue: [params.endDate],
      });
    }
    if (params.regionName) {
      filters.push({
        name: BI_FIELD_NAMES.CITY,
        filterType: BI_FILTER_TYPES.CONTAINS,
        filterValue: [params.regionName],
      });
    }
    if (params.companyName) {
      filters.push({
        name: BI_FIELD_NAMES.COMPANY_NAME,
        filterType: BI_FILTER_TYPES.CONTAINS,
        filterValue: [params.companyName],
      });
    }
    if (params.orderStatus) {
      filters.push({
        name: BI_FIELD_NAMES.ORDER_STATUS,
        filterType: BI_FILTER_TYPES.EQUAL,
        filterValue: [params.orderStatus],
      });
    }

    return filters;
  }

  /**
   * 分页获取全部 BI 数据（最多 BI_MAX_PAGES 页）
   *
   * 每页间隔 BI_PAGE_DELAY_MS，避免请求过快。
   */
  private async fetchAllBIPages(
    token: string,
    filters: Array<{ name: string; filterType: string; filterValue: string[] }>,
  ): Promise<BIOrder[]> {
    const allOrders: BIOrder[] = [];
    let offset = 0;

    for (let page = 0; page < BI_MAX_PAGES; page++) {
      this.logger.debug(`[BI] 获取第 ${page + 1} 页数据 (offset: ${offset})...`);

      const response = await fetch(`${BI_BASE_URL}/card/${BI_CARD_ID}/data`, {
        method: 'POST',
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          limit: BI_PAGE_LIMIT,
          view: 'GRAPH',
          filters,
          dynamicParams: [],
        }),
      });

      if (!response.ok) {
        throw new Error(`BI API 请求失败: ${response.status}`);
      }

      const data = await response.json();
      if (data.result !== 'ok') {
        throw new Error(`BI API 返回错误: ${data.message || '未知错误'}`);
      }

      const chartMain = (data.response as Record<string, unknown>)?.chartMain as
        | Record<string, unknown>
        | undefined;
      const orders = this.parseBIChartMain(chartMain);

      if (orders.length === 0) break;

      allOrders.push(...orders);

      // 检查是否还有更多数据
      if (!chartMain?.hasMoreData) {
        this.logger.debug(`[BI] 已获取所有数据，共 ${allOrders.length} 条`);
        break;
      }

      offset += orders.length;

      // 页间延迟
      if (page < BI_MAX_PAGES - 1) {
        await this.delay(BI_PAGE_DELAY_MS);
      }
    }

    this.logger.log(`[BI] 共获取 ${allOrders.length} 条订单`);
    return allOrders;
  }

  /**
   * 本地排序（API 不支持 headerSortings）
   */
  private sortBIOrders(orders: BIOrder[], sortBy: string, sortOrder: 'ASC' | 'DESC'): BIOrder[] {
    return [...orders].sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      // 金额排序
      if (sortBy === BI_FIELD_NAMES.EXPECTED_REVENUE) {
        aVal = this.parseMoney(aVal);
        bVal = this.parseMoney(bVal);
      }

      // 日期排序
      const dateFields: string[] = [BI_FIELD_NAMES.ORDER_DATE, BI_FIELD_NAMES.SERVICE_DATE];
      if (dateFields.includes(sortBy)) {
        aVal = new Date(String(aVal || '')).getTime();
        bVal = new Date(String(bVal || '')).getTime();
      }

      // 字符串比较
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'ASC' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      // 数字比较
      const numA = Number(aVal) || 0;
      const numB = Number(bVal) || 0;
      return sortOrder === 'ASC' ? numA - numB : numB - numA;
    });
  }

  /**
   * 解析金额字符串
   */
  private parseMoney(input: unknown): number {
    if (input == null) return 0;
    const normalized = String(input)
      .replace(/[,\s¥￥，]/g, '')
      .trim();
    const value = Number(normalized);
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * 获取 BI Token（带内存缓存，1h TTL）
   */
  private async getBIToken(loginId: string, password: string): Promise<string> {
    if (this.biToken && Date.now() < this.biTokenExpiry) {
      return this.biToken;
    }

    const resp = await fetch(`${BI_BASE_URL}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'guanbi', loginId, password }),
    });

    if (!resp.ok) {
      throw new Error(`BI 登录失败: ${resp.status}`);
    }

    const data = await resp.json();
    if (data.result !== 'ok' || !data.response?.token) {
      throw new Error(`BI 登录失败: ${data.message || '未知错误'}`);
    }

    this.biToken = data.response.token;
    this.biTokenExpiry = Date.now() + 3600_000; // 1h
    this.logger.log('BI Token 已刷新');
    return this.biToken!;
  }

  /**
   * 解析 BI chartMain 为行式对象
   */
  private parseBIChartMain(chartMain: Record<string, unknown> | undefined): BIOrder[] {
    if (!chartMain) return [];

    const columnValues = (chartMain.column as Record<string, unknown>)?.values as
      | Array<Array<{ title: string }>>
      | undefined;
    const rows = chartMain.data as Array<Array<{ v: unknown } | null>> | undefined;

    if (!columnValues || !rows) return [];

    const columns = columnValues.map((col) => col?.[0]?.title || '未知');

    return rows.map((row) => {
      const order: BIOrder = {};
      if (Array.isArray(row)) {
        row.forEach((cell, idx) => {
          if (idx < columns.length) {
            order[columns[idx]] = cell?.v ?? null;
          }
        });
      }
      return order;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        date: params.date,
        pageNum: params.pageNum ?? 1,
        pageSize: params.pageSize ?? 100,
        queryParam: {
          ...(params.cityName && { cityName: params.cityName }),
          ...(params.brandName && { brandName: params.brandName }),
          ...(params.storeId && { storeId: params.storeId }),
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

      const data = await response.json();
      if (data.code !== 0) {
        this.logger.warn('面试名单查询返回非零: ' + (data.message || data.code));
        return [];
      }

      return (data.data?.result as InterviewScheduleItem[]) || [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`获取面试名单失败: ${message}`);
      throw new Error(`面试名单获取失败: ${message}`);
    }
  }
}
