import { Module } from '@nestjs/common';
import { UserHostingService } from './services';
import { UserController } from './user.controller';

@Module({
  providers: [UserHostingService],
  controllers: [UserController],
  exports: [UserHostingService],
})
export class UserModule {}
