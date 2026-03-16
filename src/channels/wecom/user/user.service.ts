import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

/**
 * 企业成员管理服务
 * 负责企业内部成员的查询和管理
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取企业成员列表
   * @param token - 小组级 token
   * @param current - 当前页码（可选）
   * @param pageSize - 每页大小（可选）
   * @returns 企业成员列表数据
   */
  async getUserList(token: string, current?: number, pageSize?: number) {
    try {
      const apiUrl = this.apiConfig.endpoints.user.list();

      const params: any = { token };

      if (current !== undefined) params.current = current;
      if (pageSize !== undefined) params.pageSize = pageSize;

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取企业成员列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取企业成员列表失败:', error);
      throw error;
    }
  }
}
