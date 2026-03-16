import { Module } from '@nestjs/common';
import { SpongeService } from './sponge.service';

@Module({
  providers: [SpongeService],
  exports: [SpongeService],
})
export class SpongeModule {}
