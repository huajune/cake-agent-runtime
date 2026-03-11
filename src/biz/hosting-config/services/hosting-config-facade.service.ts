import { Injectable, Logger } from '@nestjs/common';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '../types/hosting-config.types';
import { SystemConfigService } from './system-config.service';
import { GroupBlacklistService } from './group-blacklist.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

/**
 * 系统配置门面服务
 *
 * 统一协调 Agent 配置、黑名单等 biz 层操作。
 * 运行时开关（AI 回复、消息聚合）和 Worker 管理由 Controller 直接调用
 * wecom 域服务处理，避免 biz/ 对 wecom/ 的跨域依赖。
 */
@Injectable()
export class HostingConfigFacadeService {
  private readonly logger = new Logger(HostingConfigFacadeService.name);

  constructor(
    private readonly systemConfigService: SystemConfigService,
    private readonly groupBlacklistService: GroupBlacklistService,
    private readonly userHostingService: UserHostingService,
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
      groupIds: groupBlacklist.map((g) => g.group_id),
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
}
