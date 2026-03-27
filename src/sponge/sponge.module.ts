import { Module } from '@nestjs/common';
import { SpongeService } from './sponge.service';
import { SpongeBiService } from './sponge-bi.service';

@Module({
  providers: [SpongeBiService, SpongeService],
  exports: [SpongeService, SpongeBiService],
})
export class SpongeModule {}
