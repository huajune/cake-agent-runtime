import { Controller, Get, Post, Delete, HttpCode, Logger, Body } from '@nestjs/common';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '@db';
import { SystemConfigService } from './system-config.service';
import { GroupBlacklistService } from './group-blacklist.service';
import { UserHostingService } from '@biz/user/user-hosting.service';
import { MessageService } from '@wecom/message/message.service';
import { MessageProcessor } from '@wecom/message/message.processor';
import { Inject, forwardRef } from '@nestjs/common';

/**
 * 系统配置控制器
 * 处理黑名单、Agent 回复策略等业务配置
 */
@Controller('config')
export class HostingConfigController {
  private readonly logger = new Logger(HostingConfigController.name);

  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly groupBlacklistService: GroupBlacklistService,
    private readonly userHostingService: UserHostingService,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    @Inject(forwardRef(() => MessageProcessor))
    private readonly messageProcessor: MessageProcessor,
  ) {}

  @Get('agent-config')
  async getAgentReplyConfig() {
    this.logger.debug('获取 Agent 回复策略配置');
    const config = await this.systemConfigService.getAgentReplyConfig();
    return { config, defaults: DEFAULT_AGENT_REPLY_CONFIG };
  }

  @Post('agent-config')
  @HttpCode(200)
  async updateAgentReplyConfig(@Body() body: Partial<AgentReplyConfig>) {
    this.logger.log(`更新 Agent 回复策略配置: ${JSON.stringify(body)}`);
    // 验证逻辑略（可以从原文件复制）
    const newConfig = await this.systemConfigService.setAgentReplyConfig(body);
    return { config: newConfig, message: '配置已更新' };
  }

  @Post('agent-config/reset')
  @HttpCode(200)
  async resetAgentReplyConfig() {
    this.logger.log('重置 Agent 回复策略配置为默认值');
    const newConfig = await this.systemConfigService.setAgentReplyConfig(
      DEFAULT_AGENT_REPLY_CONFIG,
    );
    return { config: newConfig, message: 'Agent 回复策略配置已重置为默认值' };
  }

  @Get('blacklist')
  async getBlacklist() {
    this.logger.debug('获取黑名单列表');
    const [pausedUsers, groupBlacklist] = await Promise.all([
      this.userHostingService.getPausedUsersWithProfiles(),
      this.groupBlacklistService.getGroupBlacklist(),
    ]);
    return {
      chatIds: pausedUsers.map((u) => u.userId),
      groupIds: groupBlacklist.map((g) => g.groupId),
    };
  }

  @Post('blacklist')
  @HttpCode(200)
  async addToBlacklist(@Body() body: { id: string; type: 'chatId' | 'groupId'; reason?: string }) {
    const { id, type, reason } = body;
    if (type === 'chatId') {
      await this.userHostingService.pauseUser(id);
      return { message: `用户 ${id} 已添加到黑名单` };
    } else {
      await this.groupBlacklistService.addGroupToBlacklist(id, reason);
      return { message: `小组 ${id} 已添加到黑名单` };
    }
  }

  @Delete('blacklist')
  async removeFromBlacklist(@Body() body: { id: string; type: 'chatId' | 'groupId' }) {
    const { id, type } = body;
    if (type === 'chatId') {
      await this.userHostingService.resumeUser(id);
      return { message: `用户 ${id} 已从黑名单移除` };
    } else {
      await this.groupBlacklistService.removeGroupFromBlacklist(id);
      return { message: `小组 ${id} 已从黑名单移除` };
    }
  }

  // ==================== 运行时开关 ====================

  /**
   * 获取 AI 回复开关状态
   */
  @Get('ai-reply-status')
  getAiReplyStatus(): { enabled: boolean } {
    return { enabled: this.messageService.getAiReplyStatus() };
  }

  /**
   * 切换 AI 回复开关
   */
  @Post('toggle-ai-reply')
  @HttpCode(200)
  async toggleAiReply(@Body('enabled') enabled: boolean) {
    const newStatus = await this.messageService.toggleAiReply(enabled);
    return {
      enabled: newStatus,
      message: `AI 自动回复功能已${newStatus ? '启用' : '禁用'}`,
    };
  }

  /**
   * 获取消息聚合开关状态
   */
  @Get('message-merge-status')
  getMessageMergeStatus(): { enabled: boolean } {
    return { enabled: this.messageService.getMessageMergeStatus() };
  }

  /**
   * 切换消息聚合开关
   */
  @Post('toggle-message-merge')
  @HttpCode(200)
  async toggleMessageMerge(@Body('enabled') enabled: boolean) {
    const newStatus = await this.messageService.toggleMessageMerge(enabled);
    return {
      enabled: newStatus,
      message: `消息聚合功能已${newStatus ? '启用' : '禁用'}`,
    };
  }

  // ==================== Worker 并发管理 ====================

  /**
   * 获取 Worker 状态
   */
  @Get('worker-status')
  getWorkerStatus() {
    return {
      ...this.messageProcessor.getWorkerStatus(),
      messageMergeEnabled: this.messageService.getMessageMergeStatus(),
    };
  }

  /**
   * 设置 Worker 并发数
   */
  @Post('worker-concurrency')
  @HttpCode(200)
  async setWorkerConcurrency(@Body('concurrency') concurrency: number) {
    if (concurrency === undefined || concurrency === null) {
      return {
        success: false,
        message: 'concurrency 参数必填',
      };
    }
    return this.messageProcessor.setConcurrency(concurrency);
  }
}
