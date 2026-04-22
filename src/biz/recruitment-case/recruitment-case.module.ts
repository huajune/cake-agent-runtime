import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RecruitmentCaseRepository } from './repositories/recruitment-case.repository';
import { RecruitmentCaseService } from './services/recruitment-case.service';
import { RecruitmentStageResolverService } from './services/recruitment-stage-resolver.service';

@Module({
  imports: [ConfigModule],
  providers: [RecruitmentCaseRepository, RecruitmentCaseService, RecruitmentStageResolverService],
  exports: [RecruitmentCaseService, RecruitmentStageResolverService],
})
export class RecruitmentCaseModule {}
