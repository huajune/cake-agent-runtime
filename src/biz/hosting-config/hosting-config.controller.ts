import { Controller, Get, Post, Delete, HttpCode, Body } from '@nestjs/common';
import { AgentReplyConfig } from './types/hosting-config.types';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';

/**
 * 系统配置控制器
 * 纯委托层，不包含任何业务逻辑，所有操作委托给 HostingConfigFacadeService。
 */
@Controller('config')
export class HostingConfigController {
  constructor(private readonly facade: HostingConfigFacadeService) {}

  // ==================== 运行时开关 ====================

  @Get('ai-reply-status')
  async getAiReplyStatus() {
    return { enabled: await this.facade.getAiReplyStatus() };
  }

  @Post('toggle-ai-reply')
  @HttpCode(200)
  async toggleAiReply(@Body('enabled') enabled: boolean) {
    return this.facade.toggleAiReply(enabled);
  }

  @Get('message-merge-status')
  async getMessageMergeStatus() {
    return { enabled: await this.facade.getMessageMergeStatus() };
  }

  @Post('toggle-message-merge')
  @HttpCode(200)
  async toggleMessageMerge(@Body('enabled') enabled: boolean) {
    return this.facade.toggleMessageMerge(enabled);
  }

  // ==================== Agent 配置 ====================

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

  // ==================== 群任务通知配置 ====================

  @Post('group-task-config')
  @HttpCode(200)
  async updateGroupTaskConfig(@Body() body: { enabled?: boolean; dryRun?: boolean }) {
    const current = (await this.facade.getAgentReplyConfig()).groupTaskConfig;
    const updated = { ...current, ...body };
    await this.facade.updateGroupTaskConfig(updated);
    return { config: updated, message: '群任务配置已更新' };
  }

  // ==================== 黑名单 ====================

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
