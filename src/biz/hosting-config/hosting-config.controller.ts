import { Controller, Get, Post, Delete, HttpCode, Body } from '@nestjs/common';
import { AgentReplyConfig } from './types/hosting-config.types';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';

/**
 * 系统配置控制器
 * 纯委托层，不包含任何业务逻辑。
 * 所有操作委托给 HostingConfigFacadeService。
 * 运行时开关和 Worker 管理端点已迁移至 MessageController（wecom 层）。
 */
@Controller('config')
export class HostingConfigController {
  constructor(private readonly facade: HostingConfigFacadeService) {}

  @Get('agent-config')
  async getAgentReplyConfig() {
    return this.facade.getAgentReplyConfig();
  }

  @Post('agent-config')
  @HttpCode(200)
  async updateAgentReplyConfig(@Body() body: Partial<AgentReplyConfig>) {
    return this.facade.updateAgentReplyConfig(body);
  }

  @Post('agent-config/reset')
  @HttpCode(200)
  async resetAgentReplyConfig() {
    return this.facade.resetAgentReplyConfig();
  }

  @Get('blacklist')
  async getBlacklist() {
    return this.facade.getBlacklist();
  }

  @Post('blacklist')
  @HttpCode(200)
  async addToBlacklist(@Body() body: { id: string; type: 'chatId' | 'groupId'; reason?: string }) {
    return this.facade.addToBlacklist(body.id, body.type, body.reason);
  }

  @Delete('blacklist')
  async removeFromBlacklist(@Body() body: { id: string; type: 'chatId' | 'groupId' }) {
    return this.facade.removeFromBlacklist(body.id, body.type);
  }
}
