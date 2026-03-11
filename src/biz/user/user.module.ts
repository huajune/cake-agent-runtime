import { Module } from '@nestjs/common';
import { UserHostingRepository } from './repositories';
import { UserHostingService } from './services';
import { UserController } from './user.controller';

@Module({
  providers: [UserHostingRepository, UserHostingService],
  controllers: [UserController],
  exports: [UserHostingService],
})
export class UserModule {}
