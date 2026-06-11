import { Module } from '@nestjs/common';
import { CustomerModule } from '@wecom/customer/customer.module';
import { UserHostingRepository } from './repositories/user-hosting.repository';
import { CandidateProfileEnrichmentService } from './services/candidate-profile-enrichment.service';
import { UserHostingService } from './services/user-hosting.service';
import { UserController } from './user.controller';

@Module({
  imports: [CustomerModule],
  providers: [UserHostingRepository, UserHostingService, CandidateProfileEnrichmentService],
  controllers: [UserController],
  exports: [UserHostingService, CandidateProfileEnrichmentService],
})
export class UserModule {}
