import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BIOrderQueryParams, BIOrder, BI_FIELD_NAMES, BI_FILTER_TYPES } from './sponge.types';

const BI_PAGE_LIMIT = 200;
const BI_MAX_PAGES = 10;
const BI_PAGE_DELAY_MS = 500;

/**
 * 观远BI 数据服务
 *
 * 负责：登录认证、数据源刷新、分页查询、数据解析。
 * 从 SpongeService 中提取，遵循 SRP 原则。
 */
@Injectable()
export class SpongeBiService {
  private readonly logger = new Logger(SpongeBiService.name);

  /** BI token 缓存 */
  private biToken: string | null = null;
  private biTokenExpiry = 0;
  /** 防止并发登录创建多个 session */
  private tokenPromise: Promise<string> | null = null;

  private readonly biBaseUrl: string;
  private readonly biCardId: string;
  private readonly biRefreshSourceId: string;
  private readonly biRefreshWaitMs: number;

  constructor(private readonly configService: ConfigService) {
    this.biBaseUrl = this.configService.get<string>(
      'GUANYUAN_BI_BASE_URL',
      'https://bi.duliday.com/public-api',
    );
    this.biCardId = this.configService.get<string>(
      'GUANYUAN_BI_CARD_ID',
      'd88707004062545199330960',
    );
    this.biRefreshSourceId = this.configService.get<string>(
      'GUANYUAN_BI_REFRESH_SOURCE_ID',
      'sa02db85d1ae64d699f6fd4e',
    );
    this.biRefreshWaitMs = parseInt(
      this.configService.get<string>('GUANYUAN_BI_REFRESH_WAIT_MS', '35000'),
      10,
    );
  }

  /**
   * 获取观远BI订单数据
   *
   * 完整链路：刷新数据源(可选) → 登录 → 分页获取 → 解析 → 本地排序
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
        await this.refreshBIDataSourceAndWait();
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
   */
  async refreshBIDataSource(): Promise<boolean> {
    try {
      const refreshToken = this.configService.get<string>('GUANYUAN_REFRESH_TOKEN', '');
      if (!refreshToken) {
        this.logger.warn('缺少 GUANYUAN_REFRESH_TOKEN，无法刷新 BI 数据源');
        return false;
      }
      const url = `${this.biBaseUrl}/data-source/${this.biRefreshSourceId}/refresh?token=${refreshToken}`;
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
   * 刷新 BI 数据源并等待刷新结果落地
   */
  async refreshBIDataSourceAndWait(): Promise<boolean> {
    const refreshed = await this.refreshBIDataSource();
    if (!refreshed) return false;

    await this.delay(this.biRefreshWaitMs);
    return true;
  }

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

  private async fetchAllBIPages(
    token: string,
    filters: Array<{ name: string; filterType: string; filterValue: string[] }>,
  ): Promise<BIOrder[]> {
    const allOrders: BIOrder[] = [];
    let offset = 0;

    for (let page = 0; page < BI_MAX_PAGES; page++) {
      this.logger.debug(`[BI] 获取第 ${page + 1} 页数据 (offset: ${offset})...`);

      const response = await fetch(`${this.biBaseUrl}/card/${this.biCardId}/data`, {
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

      if (!chartMain?.hasMoreData) {
        this.logger.debug(`[BI] 已获取所有数据，共 ${allOrders.length} 条`);
        break;
      }

      offset += orders.length;

      if (page < BI_MAX_PAGES - 1) {
        await this.delay(BI_PAGE_DELAY_MS);
      }
    }

    this.logger.log(`[BI] 共获取 ${allOrders.length} 条订单`);
    return allOrders;
  }

  private sortBIOrders(orders: BIOrder[], sortBy: string, sortOrder: 'ASC' | 'DESC'): BIOrder[] {
    return [...orders].sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      if (sortBy === BI_FIELD_NAMES.EXPECTED_REVENUE) {
        aVal = this.parseMoney(aVal);
        bVal = this.parseMoney(bVal);
      }

      const dateFields: string[] = [BI_FIELD_NAMES.ORDER_DATE, BI_FIELD_NAMES.SERVICE_DATE];
      if (dateFields.includes(sortBy)) {
        aVal = new Date(String(aVal || '')).getTime();
        bVal = new Date(String(bVal || '')).getTime();
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'ASC' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = Number(aVal) || 0;
      const numB = Number(bVal) || 0;
      return sortOrder === 'ASC' ? numA - numB : numB - numA;
    });
  }

  private parseMoney(input: unknown): number {
    if (input == null) return 0;
    const normalized = String(input)
      .replace(/[,\s¥￥，]/g, '')
      .trim();
    const value = Number(normalized);
    return Number.isFinite(value) ? value : 0;
  }

  private async getBIToken(loginId: string, password: string): Promise<string> {
    if (this.biToken && Date.now() < this.biTokenExpiry) {
      return this.biToken;
    }

    // 防止并发请求同时发起登录
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.doGetBIToken(loginId, password);
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async doGetBIToken(loginId: string, password: string): Promise<string> {
    const resp = await fetch(`${this.biBaseUrl}/sign-in`, {
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
    this.biTokenExpiry = Date.now() + 3600_000;
    this.logger.log('BI Token 已刷新');
    return this.biToken!;
  }

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
}
