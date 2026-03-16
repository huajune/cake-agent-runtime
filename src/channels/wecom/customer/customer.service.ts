import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

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
}
