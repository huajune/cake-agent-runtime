import { Controller, Get, Post, Delete, HttpCode, Logger, Body, Param } from '@nestjs/common';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '@db';
import { SystemConfigService, GroupBlacklistService } from '@db/config';
import { UserHostingService } from '@db/user';

/**
 * 管理控制器
 * 纯数据库管理端点，直接使用 Supabase Service 层
 *
 * 路由前缀: /monitoring（保持前端兼容）
 *
 * 端点分组:
 * - 用户托管管理: pause/resume/status
 * - 黑名单管理: get/add/remove
 * - Agent 回复策略配置: get/update/reset
 */
@Controller('monitoring')
export class MonitoringAdminController {
  private readonly logger = new Logger(MonitoringAdminController.name);

  constructor(
    private readonly userHostingService: UserHostingService,
    private readonly groupBlacklistService: GroupBlacklistService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  // ==================== 用户托管管理 ====================

  /**
   * 暂停用户托管
   * POST /monitoring/users/:userId/pause
   */
  @Post('users/:userId/pause')
  @HttpCode(200)
  async pauseUserHosting(@Param('userId') userId: string) {
    this.logger.log(`暂停用户托管: ${userId}`);
    await this.userHostingService.pauseUser(userId);
    return {
      userId,
      isPaused: true,
      message: `用户 ${userId} 的托管已暂停（已持久化）`,
    };
  }

  /**
   * 恢复用户托管
   * POST /monitoring/users/:userId/resume
   */
  @Post('users/:userId/resume')
  @HttpCode(200)
  async resumeUserHosting(@Param('userId') userId: string) {
    this.logger.log(`恢复用户托管: ${userId}`);
    await this.userHostingService.resumeUser(userId);
    return {
      userId,
      isPaused: false,
      message: `用户 ${userId} 的托管已恢复（已持久化）`,
    };
  }

  /**
   * 获取暂停托管的用户列表
   * GET /monitoring/users/paused
   */
  @Get('users/paused')
  async getPausedUsers() {
    this.logger.debug('获取暂停托管用户列表');
    return { users: await this.userHostingService.getPausedUsersWithProfiles() };
  }

  /**
   * 检查用户是否被暂停托管
   * GET /monitoring/users/:userId/status
   */
  @Get('users/:userId/status')
  async getUserHostingStatus(@Param('userId') userId: string) {
    return {
      userId,
      isPaused: await this.userHostingService.isUserPaused(userId),
    };
  }

  /**
   * 切换用户托管状态
   * POST /monitoring/users/:chatId/hosting
   */
  @Post('users/:chatId/hosting')
  @HttpCode(200)
  async toggleUserHosting(@Param('chatId') chatId: string, @Body('enabled') enabled: boolean) {
    this.logger.log(`切换用户托管状态: ${chatId}, enabled=${enabled}`);

    if (enabled) {
      await this.userHostingService.resumeUser(chatId);
      return { chatId, hostingEnabled: true, message: `用户 ${chatId} 的托管已启用` };
    } else {
      await this.userHostingService.pauseUser(chatId);
      return { chatId, hostingEnabled: false, message: `用户 ${chatId} 的托管已暂停` };
    }
  }

  // ==================== Agent 回复策略配置 ====================

  /**
   * 获取 Agent 回复策略配置
   * GET /monitoring/agent-config
   */
  @Get('agent-config')
  async getAgentReplyConfig() {
    this.logger.debug('获取 Agent 回复策略配置');
    const config = await this.systemConfigService.getAgentReplyConfig();
    return { config, defaults: DEFAULT_AGENT_REPLY_CONFIG };
  }

  /**
   * 更新 Agent 回复策略配置
   * POST /monitoring/agent-config
   */
  @Post('agent-config')
  @HttpCode(200)
  async updateAgentReplyConfig(@Body() body: Partial<AgentReplyConfig>) {
    this.logger.log(`更新 Agent 回复策略配置: ${JSON.stringify(body)}`);

    const validatedConfig: Partial<AgentReplyConfig> = {};

    if (body.initialMergeWindowMs !== undefined) {
      const value = Number(body.initialMergeWindowMs);
      if (isNaN(value) || value < 0 || value > 30000)
        throw new Error('initialMergeWindowMs 必须在 0-30000 之间');
      validatedConfig.initialMergeWindowMs = value;
    }

    if (body.maxMergedMessages !== undefined) {
      const value = Number(body.maxMergedMessages);
      if (isNaN(value) || value < 1 || value > 10)
        throw new Error('maxMergedMessages 必须在 1-10 之间');
      validatedConfig.maxMergedMessages = value;
    }

    if (body.typingDelayPerCharMs !== undefined) {
      const value = Number(body.typingDelayPerCharMs);
      if (isNaN(value) || value < 0 || value > 500)
        throw new Error('typingDelayPerCharMs 必须在 0-500 之间');
      validatedConfig.typingDelayPerCharMs = value;
    }

    if (body.paragraphGapMs !== undefined) {
      const value = Number(body.paragraphGapMs);
      if (isNaN(value) || value < 0 || value > 10000)
        throw new Error('paragraphGapMs 必须在 0-10000 之间');
      validatedConfig.paragraphGapMs = value;
    }

    if (body.alertThrottleWindowMs !== undefined) {
      const value = Number(body.alertThrottleWindowMs);
      if (isNaN(value) || value < 60000 || value > 3600000)
        throw new Error('alertThrottleWindowMs 必须在 60000-3600000 之间（1分钟-1小时）');
      validatedConfig.alertThrottleWindowMs = value;
    }

    if (body.alertThrottleMaxCount !== undefined) {
      const value = Number(body.alertThrottleMaxCount);
      if (isNaN(value) || value < 1 || value > 100)
        throw new Error('alertThrottleMaxCount 必须在 1-100 之间');
      validatedConfig.alertThrottleMaxCount = value;
    }

    if (body.businessAlertEnabled !== undefined) {
      validatedConfig.businessAlertEnabled = Boolean(body.businessAlertEnabled);
    }

    if (body.minSamplesForAlert !== undefined) {
      const value = Number(body.minSamplesForAlert);
      if (isNaN(value) || value < 1 || value > 1000)
        throw new Error('minSamplesForAlert 必须在 1-1000 之间');
      validatedConfig.minSamplesForAlert = value;
    }

    if (body.alertIntervalMinutes !== undefined) {
      const value = Number(body.alertIntervalMinutes);
      if (isNaN(value) || value < 1 || value > 1440)
        throw new Error('alertIntervalMinutes 必须在 1-1440 之间（1分钟-24小时）');
      validatedConfig.alertIntervalMinutes = value;
    }

    if (body.successRateCritical !== undefined) {
      const value = Number(body.successRateCritical);
      if (isNaN(value) || value < 0 || value > 100)
        throw new Error('successRateCritical 必须在 0-100 之间');
      validatedConfig.successRateCritical = value;
    }

    if (body.avgDurationCritical !== undefined) {
      const value = Number(body.avgDurationCritical);
      if (isNaN(value) || value < 1000 || value > 300000)
        throw new Error('avgDurationCritical 必须在 1000-300000 之间（1秒-5分钟）');
      validatedConfig.avgDurationCritical = value;
    }

    if (body.queueDepthCritical !== undefined) {
      const value = Number(body.queueDepthCritical);
      if (isNaN(value) || value < 1 || value > 1000)
        throw new Error('queueDepthCritical 必须在 1-1000 之间');
      validatedConfig.queueDepthCritical = value;
    }

    if (body.errorRateCritical !== undefined) {
      const value = Number(body.errorRateCritical);
      if (isNaN(value) || value < 1 || value > 1000)
        throw new Error('errorRateCritical 必须在 1-1000 之间');
      validatedConfig.errorRateCritical = value;
    }

    const newConfig = await this.systemConfigService.setAgentReplyConfig(validatedConfig);
    const message = this.getUpdateMessage(body);

    return { config: newConfig, message };
  }

  private getUpdateMessage(body: Partial<AgentReplyConfig>): string {
    if (body.businessAlertEnabled !== undefined) {
      return body.businessAlertEnabled
        ? '业务告警已启用（已实时生效）'
        : '业务告警已禁用（已实时生效）';
    }

    const thresholdKeys = [
      'successRateCritical',
      'avgDurationCritical',
      'queueDepthCritical',
      'errorRateCritical',
    ];
    if (thresholdKeys.some((key) => body[key as keyof AgentReplyConfig] !== undefined)) {
      return '告警阈值配置已更新（已实时生效）';
    }

    const alertKeys = ['minSamplesForAlert', 'alertIntervalMinutes'];
    if (alertKeys.some((key) => body[key as keyof AgentReplyConfig] !== undefined)) {
      return '告警配置已更新（已实时生效）';
    }

    const mergeKeys = ['initialMergeWindowMs', 'maxMergedMessages'];
    if (mergeKeys.some((key) => body[key as keyof AgentReplyConfig] !== undefined)) {
      return '消息聚合配置已更新（已实时生效）';
    }

    return '配置已更新（已实时生效）';
  }

  /**
   * 重置 Agent 回复策略配置为默认值
   * POST /monitoring/agent-config/reset
   */
  @Post('agent-config/reset')
  @HttpCode(200)
  async resetAgentReplyConfig() {
    this.logger.log('重置 Agent 回复策略配置为默认值');
    const newConfig = await this.systemConfigService.setAgentReplyConfig(
      DEFAULT_AGENT_REPLY_CONFIG,
    );
    return { config: newConfig, message: 'Agent 回复策略配置已重置为默认值' };
  }

  // ==================== 黑名单管理 ====================

  /**
   * 获取黑名单列表
   * GET /monitoring/blacklist
   */
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

  /**
   * 添加到黑名单
   * POST /monitoring/blacklist
   */
  @Post('blacklist')
  @HttpCode(200)
  async addToBlacklist(@Body() body: { id: string; type: 'chatId' | 'groupId'; reason?: string }) {
    const { id, type, reason } = body;
    if (!id || !type) throw new Error('id 和 type 参数必填');

    if (type === 'chatId') {
      this.logger.log(`添加用户到黑名单: ${id}`);
      await this.userHostingService.pauseUser(id);
      return { message: `用户 ${id} 已添加到黑名单（托管已暂停）` };
    } else if (type === 'groupId') {
      this.logger.log(`添加小组到黑名单: ${id}, reason=${reason}`);
      await this.groupBlacklistService.addGroupToBlacklist(id, reason);
      return { message: `小组 ${id} 已添加到黑名单` };
    } else {
      throw new Error('type 必须是 chatId 或 groupId');
    }
  }

  /**
   * 从黑名单移除
   * DELETE /monitoring/blacklist
   */
  @Delete('blacklist')
  async removeFromBlacklist(@Body() body: { id: string; type: 'chatId' | 'groupId' }) {
    const { id, type } = body;
    if (!id || !type) throw new Error('id 和 type 参数必填');

    if (type === 'chatId') {
      this.logger.log(`从黑名单移除用户: ${id}`);
      await this.userHostingService.resumeUser(id);
      return { message: `用户 ${id} 已从黑名单移除（托管已恢复）` };
    } else if (type === 'groupId') {
      this.logger.log(`从黑名单移除小组: ${id}`);
      const removed = await this.groupBlacklistService.removeGroupFromBlacklist(id);
      return {
        message: removed ? `小组 ${id} 已从黑名单移除` : `小组 ${id} 不在黑名单中`,
      };
    } else {
      throw new Error('type 必须是 chatId 或 groupId');
    }
  }
}
