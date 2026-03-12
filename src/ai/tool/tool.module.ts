import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';

@Module({
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolModule {}
