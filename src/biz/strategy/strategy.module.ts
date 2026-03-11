import { Module } from '@nestjs/common';
import { StrategyConfigService } from './services';
import { StrategyController } from './strategy.controller';

@Module({
  controllers: [StrategyController],
  providers: [StrategyConfigService],
  exports: [StrategyConfigService],
})
export class StrategyModule {}
