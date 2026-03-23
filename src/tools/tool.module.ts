import { Module } from '@nestjs/common';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { ToolRegistryService } from './tool-registry.service';

@Module({
  imports: [MemoryModule, SpongeModule],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolModule {}
