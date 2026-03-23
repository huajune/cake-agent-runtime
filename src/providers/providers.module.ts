import { Global, Module } from '@nestjs/common';
import { RegistryService } from './registry.service';
import { ReliableService } from './reliable.service';
import { RouterService } from './router.service';

@Global()
@Module({
  providers: [RegistryService, ReliableService, RouterService],
  exports: [RegistryService, ReliableService, RouterService],
})
export class ProvidersModule {}
