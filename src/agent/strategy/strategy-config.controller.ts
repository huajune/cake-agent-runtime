import { Controller, Get, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { StrategyConfigService } from './strategy-config.service';
import {
  StrategyConfigRecord,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
} from './strategy-config.types';

/**
 * 策略配置 Controller
 *
 * 提供策略配置的 REST API，供 Dashboard 前端调用
 */
@Controller('agent/strategy')
export class StrategyConfigController {
  private readonly logger = new Logger(StrategyConfigController.name);

  constructor(private readonly strategyConfigService: StrategyConfigService) {}

  /**
   * 获取当前激活的完整策略配置
   * GET /agent/strategy
   */
  @Get()
  async getActiveConfig(): Promise<StrategyConfigRecord> {
    this.logger.debug('获取策略配置');
    return this.strategyConfigService.getActiveConfig();
  }

  /**
   * 更新人格配置
   * POST /agent/strategy/persona
   */
  @Post('persona')
  @HttpCode(200)
  async updatePersona(
    @Body() body: StrategyPersona,
  ): Promise<{ config: StrategyConfigRecord; message: string }> {
    this.logger.log('更新人格配置');

    if (!body.textDimensions || !Array.isArray(body.textDimensions)) {
      throw new Error('人格配置必须包含 textDimensions 数组');
    }

    const config = await this.strategyConfigService.updatePersona(body);
    return { config, message: '人格配置已更新' };
  }

  /**
   * 更新阶段目标
   * POST /agent/strategy/stage-goals
   */
  @Post('stage-goals')
  @HttpCode(200)
  async updateStageGoals(
    @Body() body: StrategyStageGoals,
  ): Promise<{ config: StrategyConfigRecord; message: string }> {
    this.logger.log('更新阶段目标配置');

    if (!body.stages || !Array.isArray(body.stages)) {
      throw new Error('阶段目标配置必须包含 stages 数组');
    }

    const config = await this.strategyConfigService.updateStageGoals(body);
    return { config, message: '阶段目标配置已更新' };
  }

  /**
   * 更新红线规则
   * POST /agent/strategy/red-lines
   */
  @Post('red-lines')
  @HttpCode(200)
  async updateRedLines(
    @Body() body: StrategyRedLines,
  ): Promise<{ config: StrategyConfigRecord; message: string }> {
    this.logger.log('更新红线规则');

    if (!body.rules || !Array.isArray(body.rules)) {
      throw new Error('红线规则必须包含 rules 数组');
    }

    const config = await this.strategyConfigService.updateRedLines(body);
    return { config, message: '红线规则已更新' };
  }
}
