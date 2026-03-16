import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

/**
 * 企业成员管理模块
 * 负责企业内部成员的管理
 */
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
