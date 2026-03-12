import { Controller, Get, Post, Body, HttpCode } from '@nestjs/common';
import { StrategyConfigService } from './services/strategy-config.service';
import { StrategyPersona, StrategyStageGoals, StrategyRedLines } from './types/strategy.types';

/**
 * 策略配置控制器
 * 纯委托层，不包含任何业务逻辑
 */
@Controller('strategy')
export class StrategyController {
  constructor(private readonly strategyConfigService: StrategyConfigService) {}

  @Get()
  async getActiveConfig() {
    return this.strategyConfigService.getActiveConfig();
  }

  @Post('persona')
  @HttpCode(200)
  async updatePersona(@Body() body: StrategyPersona) {
    const config = await this.strategyConfigService.updatePersona(body);
    return { config, message: '人格配置已更新' };
  }

  @Post('stage-goals')
  @HttpCode(200)
  async updateStageGoals(@Body() body: StrategyStageGoals) {
    const config = await this.strategyConfigService.updateStageGoals(body);
    return { config, message: '阶段目标配置已更新' };
  }

  @Post('red-lines')
  @HttpCode(200)
  async updateRedLines(@Body() body: StrategyRedLines) {
    const config = await this.strategyConfigService.updateRedLines(body);
    return { config, message: '红线规则已更新' };
  }
}
