import { Controller, Get, Post, Delete, HttpCode, Body } from '@nestjs/common';
import { AgentReplyConfig } from './types/hosting-config.types';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';
import { MessageService } from '@wecom/message/message.service';
import { MessageProcessor } from '@wecom/message/message.processor';

/**
 * 系统配置控制器
 * 纯委托层，不包含任何业务逻辑。
 * biz 层操作委托给 HostingConfigFacadeService；
 * wecom 域的运行时开关和 Worker 管理直接调用 MessageService / MessageProcessor。
 */
@Controller('config')
export class HostingConfigController {
  constructor(
    private readonly facade: HostingConfigFacadeService,
    private readonly messageService: MessageService,
    private readonly messageProcessor: MessageProcessor,
  ) {}

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

  // ==================== 运行时开关 ====================

  @Get('ai-reply-status')
  getAiReplyStatus() {
    return { enabled: this.messageService.getAiReplyStatus() };
  }

  @Post('toggle-ai-reply')
  @HttpCode(200)
  async toggleAiReply(@Body('enabled') enabled: boolean) {
    const newStatus = await this.messageService.toggleAiReply(enabled);
    return {
      enabled: newStatus,
      message: `AI 自动回复功能已${newStatus ? '启用' : '禁用'}`,
    };
  }

  @Get('message-merge-status')
  getMessageMergeStatus() {
    return { enabled: this.messageService.getMessageMergeStatus() };
  }

  @Post('toggle-message-merge')
  @HttpCode(200)
  async toggleMessageMerge(@Body('enabled') enabled: boolean) {
    const newStatus = await this.messageService.toggleMessageMerge(enabled);
    return {
      enabled: newStatus,
      message: `消息聚合功能已${newStatus ? '启用' : '禁用'}`,
    };
  }

  // ==================== Worker 管理 ====================

  @Get('worker-status')
  getWorkerStatus() {
    return {
      ...this.messageProcessor.getWorkerStatus(),
      messageMergeEnabled: this.messageService.getMessageMergeStatus(),
    };
  }

  @Post('worker-concurrency')
  @HttpCode(200)
  async setWorkerConcurrency(@Body('concurrency') concurrency: number) {
    if (concurrency === undefined || concurrency === null) {
      return { success: false, message: 'concurrency 参数必填' };
    }
    return this.messageProcessor.setConcurrency(concurrency);
  }
}
