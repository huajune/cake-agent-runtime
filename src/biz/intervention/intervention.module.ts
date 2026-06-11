import { Module } from '@nestjs/common';
import { UserModule } from '@biz/user/user.module';
import { InterventionService } from './intervention.service';

@Module({
  imports: [UserModule],
  providers: [InterventionService],
  exports: [InterventionService],
})
export class InterventionModule {}
