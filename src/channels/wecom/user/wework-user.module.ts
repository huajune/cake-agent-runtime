import { Module } from '@nestjs/common';
import { WeworkUserController } from './wework-user.controller';
import { WeworkUserService } from './wework-user.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

/**
 * 企业成员管理模块
 * 负责企业内部成员的管理
 */
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [WeworkUserController],
  providers: [WeworkUserService],
  exports: [WeworkUserService],
})
export class WeworkUserModule {}
