import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MODEL_DICTIONARY } from '@providers/models';
import { supportsVision } from '@providers/types';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '../types/hosting-config.types';
import { SystemConfigService } from './system-config.service';
import { GroupBlacklistService } from './group-blacklist.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { GroupTaskConfig } from '@biz/group-task/group-task.types';

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

  // ==================== 运行时开关 ====================

  async getAiReplyStatus(): Promise<boolean> {
    return this.systemConfigService.getAiReplyEnabled();
  }

  async toggleAiReply(enabled: boolean): Promise<{ enabled: boolean; message: string }> {
    this.logger.log(`切换 AI 回复开关: ${enabled}`);
    await this.systemConfigService.setAiReplyEnabled(enabled);
    return { enabled, message: `AI 自动回复功能已${enabled ? '启用' : '禁用'}` };
  }

  async getMessageMergeStatus(): Promise<boolean> {
    return this.systemConfigService.getMessageMergeEnabled();
  }

  async toggleMessageMerge(enabled: boolean): Promise<{ enabled: boolean; message: string }> {
    this.logger.log(`切换消息聚合开关: ${enabled}`);
    await this.systemConfigService.setMessageMergeEnabled(enabled);
    return { enabled, message: `消息聚合功能已${enabled ? '启用' : '禁用'}` };
  }

  // ==================== Agent 配置 ====================

  async getAgentReplyConfig(): Promise<{
    config: AgentReplyConfig;
    defaults: AgentReplyConfig;
    groupTaskConfig: GroupTaskConfig;
  }> {
    const config = await this.systemConfigService.getAgentReplyConfig();
    const groupTaskConfig = await this.systemConfigService.getGroupTaskConfig();
    return {
      config,
      defaults: DEFAULT_AGENT_REPLY_CONFIG,
      groupTaskConfig,
    };
  }

  async updateAgentReplyConfig(
    body: Partial<AgentReplyConfig>,
  ): Promise<{ config: AgentReplyConfig; message: string }> {
    this.assertModelOverridesValid(body);
    this.logger.log(`更新 Agent 回复策略配置: ${JSON.stringify(body)}`);
    const newConfig = await this.systemConfigService.setAgentReplyConfig(body);
    return { config: newConfig, message: '配置已更新' };
  }

  /**
   * 模型覆盖字段的保存时校验：非空值必须是 MODEL_DICTIONARY 登记过的模型 ID
   * （空字符串 = 清除覆盖走环境变量路由，放行）；vision 覆盖额外要求多模态能力，
   * 否则图片消息会在执行器被逐台跳过、静默落入降级链。
   */
  private assertModelOverridesValid(body: Partial<AgentReplyConfig>): void {
    const modelFields: Array<keyof AgentReplyConfig> = [
      'wecomCallbackModelId',
      'extractModelId',
      'visionModelId',
      'evaluateModelId',
      'reviewModelId',
      'repairModelId',
      'reengagementModelId',
    ];
    for (const field of modelFields) {
      const raw = body[field];
      if (typeof raw !== 'string') continue;
      const modelId = raw.trim();
      if (!modelId) continue;
      if (!MODEL_DICTIONARY[modelId]) {
        throw new BadRequestException(
          `${field} 不是已登记的模型 ID: ${modelId}（可用清单见 GET /agent/models）`,
        );
      }
      if (field === 'visionModelId' && !supportsVision(modelId)) {
        throw new BadRequestException(`visionModelId 必须是多模态模型: ${modelId} 不支持图片输入`);
      }
    }
  }

  async updateGroupTaskConfig(partial: Partial<GroupTaskConfig>): Promise<GroupTaskConfig> {
    return this.systemConfigService.updateGroupTaskConfig(partial);
  }

  async resetAgentReplyConfig(): Promise<{ config: AgentReplyConfig; message: string }> {
    this.logger.log('重置 Agent 回复策略配置为默认值');
    const newConfig = await this.systemConfigService.setAgentReplyConfig(
      DEFAULT_AGENT_REPLY_CONFIG,
    );
    return { config: newConfig, message: 'Agent 回复策略配置已重置为默认值' };
  }

  // ==================== 黑名单 ====================

  async getBlacklist(): Promise<{
    chatIds: string[];
    groupIds: string[];
  }> {
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
    permanent?: boolean,
    operator?: string,
  ): Promise<{ message: string }> {
    if (type === 'chatId') {
      await this.userHostingService.pauseUser(id, {
        permanent,
        reason,
        operator,
        source: 'manual',
      });
      return {
        message: permanent ? `用户 ${id} 已永久禁止托管` : `用户 ${id} 已添加到黑名单`,
      };
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
