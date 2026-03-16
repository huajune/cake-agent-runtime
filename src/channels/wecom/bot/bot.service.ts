import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取托管账号列表
   */
  async getBotList(token: string) {
    try {
      const apiUrl = this.apiConfig.endpoints.bot.list();
      const params = { token };
      const result = await this.httpService.get(apiUrl, params);
      this.logger.log('获取托管账号列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取托管账号列表失败:', error);
      throw error;
    }
  }
}
