import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

/**
 * 小组查询参数接口
 */
interface GroupListParams {
  token: string;
  current?: number;
  pageSize?: number;
}

@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取小组列表
   * @param params - 查询参数
   * @returns 小组列表数据
   */
  async getGroupList(params: GroupListParams) {
    try {
      const apiUrl = this.apiConfig.endpoints.group.list();
      const result = await this.httpService.get(apiUrl, params);
      this.logger.log('获取小组列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取小组列表失败:', error);
      throw error;
    }
  }
}
