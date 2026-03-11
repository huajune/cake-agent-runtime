import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '../types';
import { SystemConfigService } from './system-config.service';
import { GroupBlacklistService } from './group-blacklist.service';
import { UserHostingService } from '@biz/user/services';
import { MessageService } from '@wecom/message/message.service';
import { MessageProcessor } from '@wecom/message/message.processor';

/**
 * 系统配置门面服务
 *
 * 统一协调 Agent 配置、黑名单、运行时开关、Worker 管理等操作。
 * 消除 Controller 对 wecom 域的直接依赖。
 */
@Injectable()
export class HostingConfigFacadeService {
  private readonly logger = new Logger(HostingConfigFacadeService.name);

  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly groupBlacklistService: GroupBlacklistService,
    private readonly userHostingService: UserHostingService,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    @Inject(forwardRef(() => MessageProcessor))
    private readonly messageProcessor: MessageProcessor,
  ) {}

  // ==================== Agent 配置 ====================

  async getAgentReplyConfig(): Promise<{ config: AgentReplyConfig; defaults: AgentReplyConfig }> {
    const config = await this.systemConfigService.getAgentReplyConfig();
    return { config, defaults: DEFAULT_AGENT_REPLY_CONFIG };
  }

  async updateAgentReplyConfig(
    body: Partial<AgentReplyConfig>,
  ): Promise<{ config: AgentReplyConfig; message: string }> {
    this.logger.log(`更新 Agent 回复策略配置: ${JSON.stringify(body)}`);
    const newConfig = await this.systemConfigService.setAgentReplyConfig(body);
    return { config: newConfig, message: '配置已更新' };
  }

  async resetAgentReplyConfig(): Promise<{ config: AgentReplyConfig; message: string }> {
    this.logger.log('重置 Agent 回复策略配置为默认值');
    const newConfig = await this.systemConfigService.setAgentReplyConfig(
      DEFAULT_AGENT_REPLY_CONFIG,
    );
    return { config: newConfig, message: 'Agent 回复策略配置已重置为默认值' };
  }

  // ==================== 黑名单 ====================

  async getBlacklist(): Promise<{ chatIds: string[]; groupIds: string[] }> {
    const [pausedUsers, groupBlacklist] = await Promise.all([
      this.userHostingService.getPausedUsersWithProfiles(),
      this.groupBlacklistService.getGroupBlacklist(),
    ]);
    return {
      chatIds: pausedUsers.map((u) => u.userId),
      groupIds: groupBlacklist.map((g) => g.groupId),
    };
  }

  async addToBlacklist(
    id: string,
    type: 'chatId' | 'groupId',
    reason?: string,
  ): Promise<{ message: string }> {
    if (type === 'chatId') {
      await this.userHostingService.pauseUser(id);
      return { message: `用户 ${id} 已添加到黑名单` };
    } else {
      await this.groupBlacklistService.addGroupToBlacklist(id, reason);
      return { message: `小组 ${id} 已添加到黑名单` };
    }
  }

  async removeFromBlacklist(id: string, type: 'chatId' | 'groupId'): Promise<{ message: string }> {
    if (type === 'chatId') {
      await this.userHostingService.resumeUser(id);
      return { message: `用户 ${id} 已从黑名单移除` };
    } else {
      await this.groupBlacklistService.removeGroupFromBlacklist(id);
      return { message: `小组 ${id} 已从黑名单移除` };
    }
  }

  // ==================== 运行时开关 ====================

  getAiReplyStatus(): boolean {
    return this.messageService.getAiReplyStatus();
  }

  async toggleAiReply(enabled: boolean): Promise<boolean> {
    return this.messageService.toggleAiReply(enabled);
  }

  getMessageMergeStatus(): boolean {
    return this.messageService.getMessageMergeStatus();
  }

  async toggleMessageMerge(enabled: boolean): Promise<boolean> {
    return this.messageService.toggleMessageMerge(enabled);
  }

  // ==================== Worker 管理 ====================

  getWorkerStatus(): Record<string, unknown> {
    return {
      ...this.messageProcessor.getWorkerStatus(),
      messageMergeEnabled: this.messageService.getMessageMergeStatus(),
    };
  }

  async setWorkerConcurrency(
    concurrency: number,
  ): Promise<{ success: boolean; message: string; concurrency?: number }> {
    return this.messageProcessor.setConcurrency(concurrency);
  }
}
