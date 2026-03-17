import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { OrchestratorService } from './orchestrator.service';
import { ProfileLoaderService } from './profile-loader.service';
import { StrategyPromptService } from './strategy-prompt.service';
import { AgentController } from './agent.controller';

@Module({
  imports: [ConfigModule, FeishuModule, BizModule, ToolModule, MemoryModule, ObservabilityModule],
  controllers: [AgentController],
  providers: [ProfileLoaderService, StrategyPromptService, OrchestratorService],
  exports: [ProfileLoaderService, StrategyPromptService, OrchestratorService],
})
export class AgentModule {}
