import { Module } from '@nestjs/common';
import { StrategyConfigRepository } from './repositories/strategy-config.repository';
import { StrategyChangelogRepository } from './repositories/strategy-changelog.repository';
import { StrategyConfigService } from './services/strategy-config.service';
import { StrategyController } from './strategy.controller';

@Module({
  controllers: [StrategyController],
  providers: [StrategyConfigRepository, StrategyChangelogRepository, StrategyConfigService],
  exports: [StrategyConfigService],
})
export class StrategyModule {}
