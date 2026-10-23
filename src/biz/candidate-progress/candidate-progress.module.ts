import { Module } from '@nestjs/common';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { ToolModule } from '@tools/tool.module';
import { ObservabilityModule } from '@observability/observability.module';
import { CandidateProgressService } from './services/candidate-progress.service';

@Module({
  imports: [MemoryModule, SpongeModule, ToolModule, ObservabilityModule],
  providers: [CandidateProgressService],
  exports: [CandidateProgressService],
})
export class CandidateProgressModule {}
