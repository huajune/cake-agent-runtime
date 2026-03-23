import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpService } from './http.service';
import { HttpController } from './http.controller';
import { HttpClientFactory } from './http-client.factory';

/**
 * HTTP 客户端模块
 * 提供通用的 HTTP 请求能力
 */
@Module({
  imports: [ConfigModule],
  controllers: [HttpController],
  providers: [
    HttpClientFactory, // 工厂先注册，供其他服务使用
    HttpService, // HttpService 依赖 HttpClientFactory
  ],
  exports: [HttpService, HttpClientFactory],
})
export class HttpModule {}
