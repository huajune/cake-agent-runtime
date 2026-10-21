import { Global, Module } from '@nestjs/common';
import { ActionExecutionModule } from '../action-execution/action-execution.module';
import { ReplyTurnsRepository } from './reply-turns.repository';
import { ReplyTurnsService } from './reply-turns.service';

@Global()
@Module({
  imports: [ActionExecutionModule],
  providers: [ReplyTurnsRepository, ReplyTurnsService],
  exports: [ReplyTurnsRepository, ReplyTurnsService],
})
export class ReplyExecutionModule {}
