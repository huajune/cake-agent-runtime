import { Module } from '@nestjs/common';
import { UserHostingRepository } from './repositories/user-hosting.repository';
import { UserHostingService } from './services/user-hosting.service';
import { UserController } from './user.controller';

@Module({
  providers: [UserHostingRepository, UserHostingService],
  controllers: [UserController],
  exports: [UserHostingService],
})
export class UserModule {}
