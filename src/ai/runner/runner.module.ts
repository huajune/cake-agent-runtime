import { Module } from '@nestjs/common';
import { ModelModule } from '../model/model.module';
import { AgentRunnerService } from './agent-runner.service';

@Module({
  imports: [ModelModule],
  providers: [AgentRunnerService],
  exports: [AgentRunnerService],
})
export class RunnerModule {}
