import { Module } from '@nestjs/common';
import { LlmExecutorService } from './llm-executor.service';

@Module({
  providers: [LlmExecutorService],
  exports: [LlmExecutorService],
})
export class LlmModule {}
