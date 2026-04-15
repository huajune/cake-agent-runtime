import { forwardRef, Module } from '@nestjs/common';
import { RecruitmentCaseModule } from '@biz/recruitment-case/recruitment-case.module';
import { UserHostingRepository } from './repositories/user-hosting.repository';
import { UserHostingService } from './services/user-hosting.service';
import { UserController } from './user.controller';

@Module({
  imports: [forwardRef(() => RecruitmentCaseModule)],
  providers: [UserHostingRepository, UserHostingService],
  controllers: [UserController],
  exports: [UserHostingService],
})
export class UserModule {}
