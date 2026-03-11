import { Module } from '@nestjs/common';
import { StrategyConfigRepository } from './repositories';
import { StrategyConfigService } from './services';
import { StrategyController } from './strategy.controller';

@Module({
  controllers: [StrategyController],
  providers: [StrategyConfigRepository, StrategyConfigService],
  exports: [StrategyConfigService],
})
export class StrategyModule {}
