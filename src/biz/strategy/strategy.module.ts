import { Module } from '@nestjs/common';
import { StrategyConfigRepository } from './repositories/strategy-config.repository';
import { StrategyConfigService } from './services/strategy-config.service';
import { StrategyController } from './strategy.controller';

@Module({
  controllers: [StrategyController],
  providers: [StrategyConfigRepository, StrategyConfigService],
  exports: [StrategyConfigService],
})
export class StrategyModule {}
