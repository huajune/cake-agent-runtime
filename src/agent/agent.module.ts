import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { LoopService } from './loop.service';
import { CompletionService } from './completion.service';
import { SystemPromptService } from './system-prompt.service';
import { AgentController } from './agent.controller';

@Module({
  imports: [ConfigModule, FeishuModule, BizModule, ToolModule, MemoryModule, ObservabilityModule],
  controllers: [AgentController],
  providers: [SystemPromptService, LoopService, CompletionService],
  exports: [SystemPromptService, LoopService, CompletionService],
})
export class AgentModule {}
