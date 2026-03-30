import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { StrategyConfigService } from './services/strategy-config.service';
import {
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
  StrategyRoleSetting,
} from './types/strategy.types';

/**
 * 策略配置控制器
 *
 * Web 前端读写 testing 版本，企微回调通过 ContextService 读 released 版本。
 */
@Public()
@Controller('strategy')
export class StrategyController {
  constructor(private readonly strategyConfigService: StrategyConfigService) {}

  /**
   * 获取 testing 版本（Web 编辑用）
   * 支持 ?status=released 查询 released 版本
   */
  @Get()
  async getActiveConfig(@Query('status') status?: string) {
    if (status === 'released') {
      return this.strategyConfigService.getReleasedConfig();
    }
    return this.strategyConfigService.getTestingConfig();
  }

  @Post('role-setting')
  @HttpCode(200)
  async updateRoleSetting(@Body() body: StrategyRoleSetting) {
    if (!body || typeof body.content !== 'string') {
      throw new HttpException('content 必须是字符串', HttpStatus.BAD_REQUEST);
    }
    const config = await this.strategyConfigService.updateRoleSetting(body);
    return { config, message: '角色设定已更新' };
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

  /**
   * 发布策略：testing → released
   */
  @Post('publish')
  @HttpCode(200)
  async publish(@Body() body: { versionNote?: string }) {
    const config = await this.strategyConfigService.publish(body?.versionNote);
    return { config, message: '策略已发布' };
  }

  /**
   * 版本历史（released + archived）
   */
  @Get('versions')
  async getVersionHistory(@Query('limit') limit?: number) {
    return this.strategyConfigService.getVersionHistory(limit || 20);
  }

  /**
   * 变更历史（兼容旧接口）
   */
  @Get('changelog')
  async getChangelog(@Query('limit') limit?: number) {
    return this.strategyConfigService.getChangelog(limit || 20);
  }
}
