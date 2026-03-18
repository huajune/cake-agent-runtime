import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { LoopService } from './loop.service';
import { CompletionService } from './completion.service';
import { SignalDetectorService } from './signal-detector.service';
import { ContextService } from './context/context.service';
import { AgentController } from './agent.controller';
import { FactExtractionService } from './fact-extraction.service';

@Module({
  imports: [ConfigModule, FeishuModule, BizModule, ToolModule, MemoryModule, ObservabilityModule],
  controllers: [AgentController],
  providers: [
    ContextService,
    LoopService,
    CompletionService,
    SignalDetectorService,
    FactExtractionService,
  ],
  exports: [
    ContextService,
    LoopService,
    CompletionService,
    SignalDetectorService,
    FactExtractionService,
  ],
})
export class AgentModule {}
