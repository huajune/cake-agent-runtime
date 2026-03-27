import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

/**
 * 小组查询参数接口
 */
interface GroupListParams {
  current?: number;
  pageSize?: number;
}

@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 获取小组列表
   * @param params - 查询参数
   * @returns 小组列表数据
   */
  async getGroupList(params: GroupListParams) {
    try {
      const token = this.configService.get<string>('STRIDE_ENTERPRISE_TOKEN');
      if (!token) {
        throw new InternalServerErrorException(
          'STRIDE_ENTERPRISE_TOKEN 环境变量未配置，无法获取企业小组列表',
        );
      }

      const apiUrl = this.apiConfig.endpoints.group.list();
      const result = await this.httpService.get(apiUrl, { token, ...params });
      this.logger.log('获取小组列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取小组列表失败:', error);
      throw error;
    }
  }
}
