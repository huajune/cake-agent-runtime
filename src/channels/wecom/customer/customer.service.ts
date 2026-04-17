import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

export interface CustomerDetailRequest {
  token: string;
  imBotId?: string;
  imContactId?: string;
  wecomUserId?: string;
  externalUserId?: string;
}

export interface CustomerDetailResponse {
  errcode?: number;
  errmsg?: string;
  data?: {
    gender?: number | string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * 客户管理服务
 * 专注于客户关系管理（CRM）功能
 */
@Injectable()
export class CustomerService {
  private readonly logger = new Logger(CustomerService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取客户列表 v2
   * @param token - 企业级 token
   * @param wecomUserId - 企微用户 ID（可选）
   * @param imBotId - 机器人 ID（可选）
   * @param coworker - 是否包含同事（可选）
   * @param current - 当前页码（可选）
   * @param pageSize - 每页大小（可选）
   * @returns 客户列表数据
   */
  async getCustomerListV2(
    token: string,
    wecomUserId?: string,
    imBotId?: string,
    coworker?: boolean,
    current?: number,
    pageSize?: number,
  ) {
    try {
      const apiUrl = this.apiConfig.endpoints.customer.list();

      const params: any = { token };

      if (wecomUserId) params.wecomUserId = wecomUserId;
      if (imBotId) params.imBotId = imBotId;
      if (coworker !== undefined) params.coworker = coworker;
      if (current !== undefined) params.current = current;
      if (pageSize !== undefined) params.pageSize = pageSize;

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取客户列表 v2 成功');
      return result;
    } catch (error) {
      this.logger.error('获取客户列表 v2 失败:', error);
      throw error;
    }
  }

  /**
   * 查询客户详情 v2（企业级）
   *
   * 优先使用系统定位信息（imBotId + imContactId），
   * 若调用方同时提供企微侧标识（wecomUserId + externalUserId），也一并透传给上游做兜底匹配。
   */
  async getCustomerDetailV2(params: CustomerDetailRequest): Promise<CustomerDetailResponse> {
    const { token, imBotId, imContactId, wecomUserId, externalUserId } = params;

    try {
      const apiUrl = `${this.apiConfig.endpoints.customer.detail()}?token=${encodeURIComponent(token)}`;
      const body: Record<string, unknown> = {};

      if (imBotId && imContactId) {
        body.systemData = {
          imBotId,
          imContactId,
        };
      }

      if (wecomUserId && externalUserId) {
        body.wecomData = {
          wecomUserId,
          externalUserId,
        };
      }

      if (Object.keys(body).length === 0) {
        throw new Error('查询客户详情缺少定位参数');
      }

      const result = await this.httpService.post(apiUrl, body);

      this.logger.log('查询客户详情 v2 成功');
      return result as CustomerDetailResponse;
    } catch (error) {
      this.logger.error('查询客户详情 v2 失败:', error);
      throw error;
    }
  }
}
