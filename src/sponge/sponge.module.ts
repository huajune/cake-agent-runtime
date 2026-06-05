import { Module } from '@nestjs/common';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { SpongeService } from './sponge.service';
import { SpongeBiService } from './sponge-bi.service';

@Module({
  imports: [HostingConfigModule],
  providers: [SpongeBiService, SpongeService],
  exports: [SpongeService, SpongeBiService],
})
export class SpongeModule {}
