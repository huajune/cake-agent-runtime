import { Controller, Post, Body, Logger } from '@nestjs/common';
import { HttpService } from './http.service';
import { RawResponse } from '@infra/server/response/decorators/api-response.decorator';

/**
 * HTTP 客户端控制器
 * 提供 HTTP 请求的 API 接口
 */
@Controller('http')
export class HttpController {
  private readonly logger = new Logger(HttpController.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * 测试调用第三方 API
   * POST /http/test
   */
  @RawResponse() // 透传第三方 API 原始响应，不使用统一包装
  @Post('test')
  async testApi(@Body() body: { url: string; method?: string; data?: any }) {
    const { url, method = 'GET', data } = body;

    this.logger.log(`测试调用 API: ${method} ${url}`);

    if (method.toUpperCase() === 'POST') {
      return await this.httpService.post(url, data);
    } else {
      return await this.httpService.get(url, data);
    }
  }
}
