import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取联系人列表
   */
  async getContactList(
    token: string,
    current?: number,
    pageSize?: number,
    wxid?: string,
    includeStranger?: boolean,
  ) {
    try {
      const apiUrl = this.apiConfig.endpoints.contact.list();

      const params: any = { token };

      if (current !== undefined) params.current = current;
      if (pageSize !== undefined) params.pageSize = pageSize;
      if (wxid) params.wxid = wxid;
      if (includeStranger !== undefined) params.includeStranger = includeStranger;

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取联系人列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取联系人列表失败:', error);
      throw error;
    }
  }
}
