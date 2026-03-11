import { Controller, Get, Post, Delete, HttpCode, Body } from '@nestjs/common';
import { AgentReplyConfig } from '@db';
import { HostingConfigFacadeService } from './services';

/**
 * 系统配置控制器
 * 纯委托层，不包含任何业务逻辑
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

  @Get('ai-reply-status')
  getAiReplyStatus() {
    return { enabled: this.facade.getAiReplyStatus() };
  }

  @Post('toggle-ai-reply')
  @HttpCode(200)
  async toggleAiReply(@Body('enabled') enabled: boolean) {
    const newStatus = await this.facade.toggleAiReply(enabled);
    return {
      enabled: newStatus,
      message: `AI 自动回复功能已${newStatus ? '启用' : '禁用'}`,
    };
  }

  @Get('message-merge-status')
  getMessageMergeStatus() {
    return { enabled: this.facade.getMessageMergeStatus() };
  }

  @Post('toggle-message-merge')
  @HttpCode(200)
  async toggleMessageMerge(@Body('enabled') enabled: boolean) {
    const newStatus = await this.facade.toggleMessageMerge(enabled);
    return {
      enabled: newStatus,
      message: `消息聚合功能已${newStatus ? '启用' : '禁用'}`,
    };
  }

  @Get('worker-status')
  getWorkerStatus() {
    return this.facade.getWorkerStatus();
  }

  @Post('worker-concurrency')
  @HttpCode(200)
  async setWorkerConcurrency(@Body('concurrency') concurrency: number) {
    if (concurrency === undefined || concurrency === null) {
      return { success: false, message: 'concurrency 参数必填' };
    }
    return this.facade.setWorkerConcurrency(concurrency);
  }
}
