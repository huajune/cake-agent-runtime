import { Module } from '@nestjs/common';
import { WeworkUserController } from './wework-user.controller';
import { WeworkUserService } from './wework-user.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [WeworkUserController],
  providers: [WeworkUserService],
  exports: [WeworkUserService],
})
export class WeworkUserModule {}
