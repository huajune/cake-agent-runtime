import { Module } from '@nestjs/common';
import { UserModule } from '@biz/user/user.module';
import { RecruitmentCaseModule } from '@biz/recruitment-case/recruitment-case.module';
import { InterventionService } from './intervention.service';

@Module({
  imports: [UserModule, RecruitmentCaseModule],
  providers: [InterventionService],
  exports: [InterventionService],
})
export class InterventionModule {}
