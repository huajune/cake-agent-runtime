import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiConfigService } from './api-config.service';

/**
 * API 配置模块
 * 提供统一的 API 配置管理
 */
@Module({
  imports: [ConfigModule],
  providers: [ApiConfigService],
  exports: [ApiConfigService],
})
export class ApiConfigModule {}
