import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { SpongeModule } from '@sponge/sponge.module';
import { AgentRunnerService } from './runner.service';
import { CompletionService } from './completion.service';
import { ContextService } from './context/context.service';
import { AgentController } from './agent.controller';
import { FactExtractionService } from './fact-extraction.service';
import { InputGuardService } from './input-guard.service';

@Module({
  imports: [
    ConfigModule,
    FeishuModule,
    BizModule,
    ToolModule,
    MemoryModule,
    ObservabilityModule,
    SpongeModule,
  ],
  controllers: [AgentController],
  providers: [
    ContextService,
    AgentRunnerService,
    CompletionService,
    FactExtractionService,
    InputGuardService,
  ],
  exports: [
    ContextService,
    AgentRunnerService,
    CompletionService,
    FactExtractionService,
    InputGuardService,
  ],
})
export class AgentModule {}
