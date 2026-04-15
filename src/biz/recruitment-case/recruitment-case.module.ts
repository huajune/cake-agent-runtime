import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BizMessageModule } from '@biz/message/message.module';
import { UserModule } from '@biz/user/user.module';
import { MemoryModule } from '@memory/memory.module';
import { NotificationModule } from '@notification/notification.module';
import { RecruitmentCaseRepository } from './repositories/recruitment-case.repository';
import { RecruitmentCaseService } from './services/recruitment-case.service';
import { RecruitmentStageResolverService } from './services/recruitment-stage-resolver.service';

@Module({
  imports: [
    ConfigModule,
    BizMessageModule,
    MemoryModule,
    NotificationModule,
    forwardRef(() => UserModule),
  ],
  providers: [RecruitmentCaseRepository, RecruitmentCaseService, RecruitmentStageResolverService],
  exports: [RecruitmentCaseService, RecruitmentStageResolverService],
})
export class RecruitmentCaseModule {}
