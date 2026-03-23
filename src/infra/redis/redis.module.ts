import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Redis 全局模块
 * 使用 @Global() 装饰器，使 RedisService 在整个应用中可用
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
