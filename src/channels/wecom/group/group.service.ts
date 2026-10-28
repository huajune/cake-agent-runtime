import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';
import { HostingGroup } from '@biz/ops-events/providers/group-directory.provider';

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

  /** 访问范围维护使用完整小组目录，失败或超过分页上限不返回部分授权。 */
  async getAllGroups(): Promise<HostingGroup[]> {
    const groups = new Map<string, HostingGroup>();
    for (let current = 1; current <= 20; current++) {
      let data: unknown = await this.getGroupList({ current, pageSize: 100 });
      for (
        let depth = 0;
        depth < 5 && data && typeof data === 'object' && 'data' in data;
        depth++
      ) {
        if ('errcode' in data && data.errcode !== 0)
          throw new InternalServerErrorException('小组目录读取失败');
        data = data.data;
      }
      if (!Array.isArray(data)) throw new InternalServerErrorException('小组目录格式无效');
      for (const group of data) {
        if (typeof group?.id !== 'string' || typeof group?.name !== 'string')
          throw new InternalServerErrorException('小组目录身份字段缺失');
        if (groups.has(group.id)) throw new InternalServerErrorException('小组目录分页重复');
        groups.set(group.id, { id: group.id, name: group.name, description: group.description });
      }
      if (data.length < 100) return [...groups.values()];
    }
    throw new InternalServerErrorException('小组目录超过读取上限');
  }

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
