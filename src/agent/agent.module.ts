import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeishuModule } from '@core/feishu';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { ObservabilityModule } from '@/observability';
import { OrchestratorService } from './services/orchestrator.service';
import { ProfileLoaderService } from './services/profile-loader.service';
import { StrategyConfigService } from './strategy/strategy-config.service';
import { AgentController } from './agent.controller';

@Module({
  imports: [ConfigModule, FeishuModule, BizModule, ToolModule, MemoryModule, ObservabilityModule],
  controllers: [AgentController],
  providers: [ProfileLoaderService, StrategyConfigService, OrchestratorService],
  exports: [ProfileLoaderService, StrategyConfigService, OrchestratorService],
})
export class AgentModule {}
