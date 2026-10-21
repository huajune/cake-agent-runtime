import { Global, Module } from '@nestjs/common';
import { ActionExecutionModule } from '../action-execution/action-execution.module';
import { ReplyTurnsRepository } from './reply-turns.repository';
import { ReplyTurnsService } from './reply-turns.service';
import { ReplyRecoveryLeaseService } from './reply-recovery-lease.service';

@Global()
@Module({
  imports: [ActionExecutionModule],
  providers: [ReplyTurnsRepository, ReplyTurnsService, ReplyRecoveryLeaseService],
  exports: [ReplyTurnsRepository, ReplyTurnsService, ReplyRecoveryLeaseService],
})
export class ReplyExecutionModule {}
