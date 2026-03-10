import {
  Controller,
  Get,
  Post,
  Delete,
  HttpCode,
  Logger,
  Body,
  Inject,
  forwardRef,
  Query,
  Param,
} from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { DashboardData, MetricsData, TimeRange } from './interfaces/monitoring.interface';
import { MessageService } from '@wecom/message/message.service';
import { MessageFilterService } from '@wecom/message/services/message-filter.service';
import { MessageProcessor } from '@wecom/message/message.processor';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '@core/supabase';
import {
  SystemConfigRepository,
  ChatMessageRepository,
  MonitoringRepository,
  MessageProcessingRepository,
} from '@core/supabase/repositories';

/**
 * 监控控制器
 * 提供监控数据查询 API
 */
@Controller('monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(
    private readonly monitoringService: MonitoringService,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    @Inject(forwardRef(() => MessageFilterService))
    private readonly filterService: MessageFilterService,
    @Inject(forwardRef(() => MessageProcessor))
    private readonly messageProcessor: MessageProcessor,
    private readonly systemConfigRepository: SystemConfigRepository,
    private readonly chatMessageRepository: ChatMessageRepository,
    private readonly monitoringRepository: MonitoringRepository,
    private readonly messageProcessingRepository: MessageProcessingRepository,
  ) {}

  /**
   * 获取仪表盘数据（完整版，已废弃，建议使用专用接口）
   * GET /monitoring/dashboard?range=today|week|month
   * @deprecated 建议使用 /monitoring/dashboard/overview 或 /monitoring/dashboard/system
   */
  @Get('dashboard')
  async getDashboard(@Query('range') range?: TimeRange): Promise<DashboardData> {
    const timeRange = range || 'today';
    this.logger.warn(
      `[已废弃] /monitoring/dashboard 接口已废弃，建议使用专用接口: /dashboard/overview 或 /dashboard/system`,
    );
    return this.monitoringService.getDashboardDataAsync(timeRange);
  }

  /**
   * 获取 Dashboard 概览数据（轻量级）
   * GET /monitoring/dashboard/overview?range=today|week|month
   * 用于 Dashboard 页面，仅返回必需数据
   */
  @Get('dashboard/overview')
  async getDashboardOverview(@Query('range') range?: TimeRange): Promise<{
    timeRange: string;
    overview: any;
    overviewDelta: any;
    dailyTrend: any[];
    businessTrend: any[];
    responseTrend: any[];
    business: any;
    businessDelta: any;
    fallback: any;
    fallbackDelta: any;
  }> {
    const timeRange = range || 'today';
    this.logger.debug(`获取 Dashboard 概览: ${timeRange}`);
    return this.monitoringService.getDashboardOverviewAsync(timeRange);
  }

  /**
   * 获取 System 监控数据（轻量级）
   * GET /monitoring/dashboard/system
   * 用于 System 页面，仅返回队列和告警数据
   */
  @Get('dashboard/system')
  async getSystemMonitoring(): Promise<{
    queue: any;
    alertsSummary: any;
    alertTrend: any[];
  }> {
    this.logger.debug('获取 System 监控数据');
    return this.monitoringService.getSystemMonitoringAsync();
  }

  /**
   * 获取趋势数据（独立接口）
   * GET /monitoring/stats/trends?range=today|week|month
   * 用于各类趋势图表
   */
  @Get('stats/trends')
  async getTrends(@Query('range') range?: TimeRange): Promise<{
    dailyTrend: any;
    responseTrend: any[];
    alertTrend: any[];
    businessTrend: any[];
  }> {
    const timeRange = range || 'today';
    this.logger.debug(`获取趋势数据: ${timeRange}`);
    return this.monitoringService.getTrendsDataAsync(timeRange);
  }

  /**
   * 获取详细指标数据
   * GET /monitoring/metrics
   */
  @Get('metrics')
  async getMetrics(): Promise<MetricsData> {
    return this.monitoringService.getMetricsDataAsync();
  }

  /**
   * 健康检查
   * GET /monitoring/health
   */
  @Get('health')
  health(): { status: string; timestamp: number } {
    return {
      status: 'ok',
      timestamp: Date.now(),
    };
  }

  /**
   * 获取指定日期的活跃用户
   * GET /monitoring/users?date=2025-12-10
   */
  @Get('users')
  async getUsersByDate(@Query('date') date?: string): Promise<any[]> {
    if (!date) {
      // 如果未提供日期,返回今日用户
      return this.monitoringService.getTodayUsersFromDatabase();
    }

    // 验证日期格式 (YYYY-MM-DD)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(date)) {
      this.logger.warn(`无效的日期格式: ${date}`);
      return [];
    }

    return this.monitoringService.getUsersByDate(date);
  }

  /**
   * 获取近1月咨询用户趋势数据
   * GET /monitoring/user-trend
   */
  @Get('user-trend')
  async getUserTrend(): Promise<
    Array<{
      date: string;
      userCount: number;
      messageCount: number;
    }>
  > {
    return this.monitoringService.getUserTrend();
  }

  /**
   * 获取 AI 回复开关状态
   * GET /monitoring/ai-reply-status
   */
  @Get('ai-reply-status')
  getAiReplyStatus(): { enabled: boolean } {
    this.logger.debug('获取 AI 回复开关状态');
    return {
      enabled: this.messageService.getAiReplyStatus(),
    };
  }

  /**
   * 切换 AI 回复开关
   * POST /monitoring/toggle-ai-reply
   */
  @Post('toggle-ai-reply')
  @HttpCode(200)
  async toggleAiReply(
    @Body('enabled') enabled: boolean,
  ): Promise<{ enabled: boolean; message: string }> {
    this.logger.log(`切换 AI 回复开关: ${enabled}`);
    const newStatus = await this.messageService.toggleAiReply(enabled);
    return {
      enabled: newStatus,
      message: `AI 自动回复功能已${newStatus ? '启用' : '禁用'}（已持久化）`,
    };
  }

  /**
   * 获取消息聚合开关状态
   * GET /monitoring/message-merge-status
   */
  @Get('message-merge-status')
  getMessageMergeStatus(): { enabled: boolean } {
    this.logger.debug('获取消息聚合开关状态');
    return {
      enabled: this.messageService.getMessageMergeStatus(),
    };
  }

  /**
   * 切换消息聚合开关
   * POST /monitoring/toggle-message-merge
   */
  @Post('toggle-message-merge')
  @HttpCode(200)
  async toggleMessageMerge(
    @Body('enabled') enabled: boolean,
  ): Promise<{ enabled: boolean; message: string }> {
    this.logger.log(`切换消息聚合开关: ${enabled}`);
    const newStatus = await this.messageService.toggleMessageMerge(enabled);
    return {
      enabled: newStatus,
      message: `消息聚合功能已${newStatus ? '启用' : '禁用'}（已持久化）`,
    };
  }

  /**
   * 暂停用户托管
   * POST /monitoring/users/:userId/pause
   */
  @Post('users/:userId/pause')
  @HttpCode(200)
  async pauseUserHosting(@Param('userId') userId: string): Promise<{
    userId: string;
    isPaused: boolean;
    message: string;
  }> {
    this.logger.log(`暂停用户托管: ${userId}`);
    await this.filterService.pauseUser(userId);
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
  async resumeUserHosting(@Param('userId') userId: string): Promise<{
    userId: string;
    isPaused: boolean;
    message: string;
  }> {
    this.logger.log(`恢复用户托管: ${userId}`);
    await this.filterService.resumeUser(userId);
    return {
      userId,
      isPaused: false,
      message: `用户 ${userId} 的托管已恢复（已持久化）`,
    };
  }

  /**
   * 获取暂停托管的用户列表（附带用户资料）
   * GET /monitoring/users/paused
   */
  @Get('users/paused')
  async getPausedUsers(): Promise<{
    users: { userId: string; pausedAt: number; odName?: string; groupName?: string }[];
  }> {
    this.logger.debug('获取暂停托管用户列表');
    return {
      users: await this.filterService.getPausedUsers(),
    };
  }

  /**
   * 检查用户是否被暂停托管
   * GET /monitoring/users/:userId/status
   */
  @Get('users/:userId/status')
  async getUserHostingStatus(
    @Param('userId') userId: string,
  ): Promise<{ userId: string; isPaused: boolean }> {
    return {
      userId,
      isPaused: await this.filterService.isUserPaused(userId),
    };
  }

  // ==================== Agent 回复策略配置 ====================

  /**
   * 获取 Agent 回复策略配置
   * GET /monitoring/agent-config
   */
  @Get('agent-config')
  async getAgentReplyConfig(): Promise<{
    config: AgentReplyConfig;
    defaults: AgentReplyConfig;
  }> {
    this.logger.debug('获取 Agent 回复策略配置');
    const config = await this.systemConfigRepository.getAgentReplyConfig();
    return {
      config,
      defaults: DEFAULT_AGENT_REPLY_CONFIG,
    };
  }

  /**
   * 更新 Agent 回复策略配置
   * POST /monitoring/agent-config
   */
  @Post('agent-config')
  @HttpCode(200)
  async updateAgentReplyConfig(
    @Body() body: Partial<AgentReplyConfig>,
  ): Promise<{ config: AgentReplyConfig; message: string }> {
    this.logger.log(`更新 Agent 回复策略配置: ${JSON.stringify(body)}`);

    // 验证配置值
    const validatedConfig: Partial<AgentReplyConfig> = {};

    if (body.initialMergeWindowMs !== undefined) {
      const value = Number(body.initialMergeWindowMs);
      if (isNaN(value) || value < 0 || value > 30000) {
        throw new Error('initialMergeWindowMs 必须在 0-30000 之间');
      }
      validatedConfig.initialMergeWindowMs = value;
    }

    if (body.maxMergedMessages !== undefined) {
      const value = Number(body.maxMergedMessages);
      if (isNaN(value) || value < 1 || value > 10) {
        throw new Error('maxMergedMessages 必须在 1-10 之间');
      }
      validatedConfig.maxMergedMessages = value;
    }

    if (body.typingDelayPerCharMs !== undefined) {
      const value = Number(body.typingDelayPerCharMs);
      if (isNaN(value) || value < 0 || value > 500) {
        throw new Error('typingDelayPerCharMs 必须在 0-500 之间');
      }
      validatedConfig.typingDelayPerCharMs = value;
    }

    if (body.paragraphGapMs !== undefined) {
      const value = Number(body.paragraphGapMs);
      if (isNaN(value) || value < 0 || value > 10000) {
        throw new Error('paragraphGapMs 必须在 0-10000 之间');
      }
      validatedConfig.paragraphGapMs = value;
    }

    if (body.alertThrottleWindowMs !== undefined) {
      const value = Number(body.alertThrottleWindowMs);
      if (isNaN(value) || value < 60000 || value > 3600000) {
        throw new Error('alertThrottleWindowMs 必须在 60000-3600000 之间（1分钟-1小时）');
      }
      validatedConfig.alertThrottleWindowMs = value;
    }

    if (body.alertThrottleMaxCount !== undefined) {
      const value = Number(body.alertThrottleMaxCount);
      if (isNaN(value) || value < 1 || value > 100) {
        throw new Error('alertThrottleMaxCount 必须在 1-100 之间');
      }
      validatedConfig.alertThrottleMaxCount = value;
    }

    // 业务指标告警开关（布尔值）
    if (body.businessAlertEnabled !== undefined) {
      validatedConfig.businessAlertEnabled = Boolean(body.businessAlertEnabled);
    }

    // 最小样本量
    if (body.minSamplesForAlert !== undefined) {
      const value = Number(body.minSamplesForAlert);
      if (isNaN(value) || value < 1 || value > 1000) {
        throw new Error('minSamplesForAlert 必须在 1-1000 之间');
      }
      validatedConfig.minSamplesForAlert = value;
    }

    // 同类告警最小间隔（分钟）
    if (body.alertIntervalMinutes !== undefined) {
      const value = Number(body.alertIntervalMinutes);
      if (isNaN(value) || value < 1 || value > 1440) {
        throw new Error('alertIntervalMinutes 必须在 1-1440 之间（1分钟-24小时）');
      }
      validatedConfig.alertIntervalMinutes = value;
    }

    // ===== 告警阈值配置 =====

    // 成功率严重阈值（百分比）
    if (body.successRateCritical !== undefined) {
      const value = Number(body.successRateCritical);
      if (isNaN(value) || value < 0 || value > 100) {
        throw new Error('successRateCritical 必须在 0-100 之间');
      }
      validatedConfig.successRateCritical = value;
    }

    // 响应时间严重阈值（毫秒）
    if (body.avgDurationCritical !== undefined) {
      const value = Number(body.avgDurationCritical);
      if (isNaN(value) || value < 1000 || value > 300000) {
        throw new Error('avgDurationCritical 必须在 1000-300000 之间（1秒-5分钟）');
      }
      validatedConfig.avgDurationCritical = value;
    }

    // 队列深度严重阈值（条数）
    if (body.queueDepthCritical !== undefined) {
      const value = Number(body.queueDepthCritical);
      if (isNaN(value) || value < 1 || value > 1000) {
        throw new Error('queueDepthCritical 必须在 1-1000 之间');
      }
      validatedConfig.queueDepthCritical = value;
    }

    // 错误率严重阈值（每小时次数）
    if (body.errorRateCritical !== undefined) {
      const value = Number(body.errorRateCritical);
      if (isNaN(value) || value < 1 || value > 1000) {
        throw new Error('errorRateCritical 必须在 1-1000 之间');
      }
      validatedConfig.errorRateCritical = value;
    }

    const newConfig = await this.systemConfigRepository.setAgentReplyConfig(validatedConfig);

    // 根据更新内容生成不同的提示信息
    const message = this.getUpdateMessage(body);

    return {
      config: newConfig,
      message,
    };
  }

  /**
   * 根据更新内容生成对应的提示信息
   */
  private getUpdateMessage(body: Partial<AgentReplyConfig>): string {
    // 告警开关
    if (body.businessAlertEnabled !== undefined) {
      return body.businessAlertEnabled
        ? '业务告警已启用（已实时生效）'
        : '业务告警已禁用（已实时生效）';
    }

    // 告警阈值配置
    const thresholdKeys = [
      'successRateCritical',
      'avgDurationCritical',
      'queueDepthCritical',
      'errorRateCritical',
    ];
    if (thresholdKeys.some((key) => body[key as keyof AgentReplyConfig] !== undefined)) {
      return '告警阈值配置已更新（已实时生效）';
    }

    // 告警相关配置
    const alertKeys = ['minSamplesForAlert', 'alertIntervalMinutes'];
    if (alertKeys.some((key) => body[key as keyof AgentReplyConfig] !== undefined)) {
      return '告警配置已更新（已实时生效）';
    }

    // 消息聚合配置
    const mergeKeys = ['initialMergeWindowMs', 'maxMergedMessages'];
    if (mergeKeys.some((key) => body[key as keyof AgentReplyConfig] !== undefined)) {
      return '消息聚合配置已更新（已实时生效）';
    }

    // 其他配置
    return '配置已更新（已实时生效）';
  }

  /**
   * 重置 Agent 回复策略配置为默认值
   * POST /monitoring/agent-config/reset
   */
  @Post('agent-config/reset')
  @HttpCode(200)
  async resetAgentReplyConfig(): Promise<{ config: AgentReplyConfig; message: string }> {
    this.logger.log('重置 Agent 回复策略配置为默认值');
    const newConfig = await this.systemConfigRepository.setAgentReplyConfig(
      DEFAULT_AGENT_REPLY_CONFIG,
    );
    return {
      config: newConfig,
      message: 'Agent 回复策略配置已重置为默认值',
    };
  }

  // ==================== 账号托管管理（统一黑名单） ====================

  /**
   * 获取黑名单列表（统一接口）
   * GET /monitoring/blacklist
   * @returns 包含 chatIds（用户）和 groupIds（小组）的黑名单列表
   */
  @Get('blacklist')
  async getBlacklist(): Promise<{
    chatIds: string[];
    groupIds: string[];
  }> {
    this.logger.debug('获取黑名单列表');
    const [pausedUsers, groupBlacklist] = await Promise.all([
      this.filterService.getPausedUsers(),
      this.filterService.getGroupBlacklist(),
    ]);

    return {
      chatIds: pausedUsers.map((u) => u.userId),
      groupIds: groupBlacklist.map((g) => g.groupId),
    };
  }

  /**
   * 添加到黑名单（统一接口）
   * POST /monitoring/blacklist
   * @body { id: string, type: 'chatId' | 'groupId', reason?: string }
   */
  @Post('blacklist')
  @HttpCode(200)
  async addToBlacklist(
    @Body() body: { id: string; type: 'chatId' | 'groupId'; reason?: string },
  ): Promise<{ message: string }> {
    const { id, type, reason } = body;

    if (!id || !type) {
      throw new Error('id 和 type 参数必填');
    }

    if (type === 'chatId') {
      this.logger.log(`添加用户到黑名单: ${id}`);
      await this.filterService.pauseUser(id);
      return { message: `用户 ${id} 已添加到黑名单（托管已暂停）` };
    } else if (type === 'groupId') {
      this.logger.log(`添加小组到黑名单: ${id}, reason=${reason}`);
      await this.filterService.addGroupToBlacklist(id, reason);
      return { message: `小组 ${id} 已添加到黑名单` };
    } else {
      throw new Error('type 必须是 chatId 或 groupId');
    }
  }

  /**
   * 从黑名单移除（统一接口）
   * DELETE /monitoring/blacklist
   * @body { id: string, type: 'chatId' | 'groupId' }
   */
  @Delete('blacklist')
  async removeFromBlacklist(
    @Body() body: { id: string; type: 'chatId' | 'groupId' },
  ): Promise<{ message: string }> {
    const { id, type } = body;

    if (!id || !type) {
      throw new Error('id 和 type 参数必填');
    }

    if (type === 'chatId') {
      this.logger.log(`从黑名单移除用户: ${id}`);
      await this.filterService.resumeUser(id);
      return { message: `用户 ${id} 已从黑名单移除（托管已恢复）` };
    } else if (type === 'groupId') {
      this.logger.log(`从黑名单移除小组: ${id}`);
      const removed = await this.filterService.removeGroupFromBlacklist(id);
      if (removed) {
        return { message: `小组 ${id} 已从黑名单移除` };
      } else {
        return { message: `小组 ${id} 不在黑名单中` };
      }
    } else {
      throw new Error('type 必须是 chatId 或 groupId');
    }
  }

  /**
   * 切换用户托管状态
   * POST /monitoring/users/:chatId/hosting
   * @body { enabled: boolean }
   */
  @Post('users/:chatId/hosting')
  @HttpCode(200)
  async toggleUserHosting(
    @Param('chatId') chatId: string,
    @Body('enabled') enabled: boolean,
  ): Promise<{ chatId: string; hostingEnabled: boolean; message: string }> {
    this.logger.log(`切换用户托管状态: ${chatId}, enabled=${enabled}`);

    if (enabled) {
      await this.filterService.resumeUser(chatId);
      return {
        chatId,
        hostingEnabled: true,
        message: `用户 ${chatId} 的托管已启用`,
      };
    } else {
      await this.filterService.pauseUser(chatId);
      return {
        chatId,
        hostingEnabled: false,
        message: `用户 ${chatId} 的托管已暂停`,
      };
    }
  }

  /**
   * 获取用户列表（含托管状态）
   * GET /monitoring/users
   */
  @Get('users')
  async getUsers(): Promise<
    {
      chatId: string;
      userName?: string;
      messageCount: number;
      tokenUsage: number;
      lastActiveAt?: string;
      hostingEnabled: boolean;
    }[]
  > {
    this.logger.debug('获取用户列表');
    const users = await this.monitoringService.getTodayUsers();
    const pausedUsers = await this.filterService.getPausedUsers();
    const pausedSet = new Set(pausedUsers.map((u) => u.userId));

    return users.map((user) => ({
      chatId: user.chatId,
      userName: user.odName || user.chatId,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      lastActiveAt: user.lastActiveAt ? new Date(user.lastActiveAt).toISOString() : undefined,
      hostingEnabled: !pausedSet.has(user.chatId),
    }));
  }

  // ==================== Worker 并发管理 ====================

  /**
   * 获取 Worker 状态
   * GET /monitoring/worker-status
   */
  @Get('worker-status')
  getWorkerStatus(): {
    concurrency: number;
    activeJobs: number;
    minConcurrency: number;
    maxConcurrency: number;
    messageMergeEnabled: boolean;
  } {
    this.logger.debug('获取 Worker 状态');
    const baseStatus = this.messageProcessor.getWorkerStatus();
    return {
      ...baseStatus,
      messageMergeEnabled: this.messageService.getMessageMergeStatus(),
    };
  }

  /**
   * 设置 Worker 并发数
   * POST /monitoring/worker-concurrency
   * @body { concurrency: number }
   */
  @Post('worker-concurrency')
  @HttpCode(200)
  async setWorkerConcurrency(@Body('concurrency') concurrency: number): Promise<{
    success: boolean;
    message: string;
    previousConcurrency: number;
    currentConcurrency: number;
  }> {
    this.logger.log(`设置 Worker 并发数: ${concurrency}`);

    if (concurrency === undefined || concurrency === null) {
      return {
        success: false,
        message: 'concurrency 参数必填',
        previousConcurrency: this.messageProcessor.getWorkerStatus().concurrency,
        currentConcurrency: this.messageProcessor.getWorkerStatus().concurrency,
      };
    }

    return this.messageProcessor.setConcurrency(concurrency);
  }

  // ==================== 聊天记录查询 ====================

  /**
   * 获取聊天记录（支持日期筛选）
   * GET /monitoring/chat-messages?page=1&pageSize=50&date=2024-01-15
   */
  @Get('chat-messages')
  async getChatMessages(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('date') date?: string,
  ): Promise<{
    messages: Array<{
      id: string;
      chatId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      candidateName?: string;
      managerName?: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const pageNum = parseInt(page || '1', 10);
    const pageSizeNum = parseInt(pageSize || '50', 10);
    const targetDate = date ? new Date(date) : new Date();

    this.logger.debug(
      `获取聊天记录: date=${targetDate.toISOString().split('T')[0]}, page=${pageNum}, pageSize=${pageSizeNum}`,
    );

    return this.chatMessageRepository.getTodayChatMessages(targetDate, pageNum, pageSizeNum);
  }

  /**
   * 获取所有会话列表
   * GET /monitoring/chat-sessions?days=7
   * GET /monitoring/chat-sessions?startDate=2024-01-01&endDate=2024-01-31
   * v1.3: 新增 avatar, contactType 字段
   * v1.4: 支持精确的 startDate/endDate 时间范围筛选
   */
  @Get('chat-sessions')
  async getChatSessions(
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{
    sessions: Array<{
      chatId: string;
      candidateName?: string;
      managerName?: string;
      messageCount: number;
      lastMessage?: string;
      lastTimestamp?: number;
      // v1.3 新增字段
      avatar?: string;
      contactType?: string;
    }>;
  }> {
    // 优先使用精确时间范围
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = endDate ? new Date(endDate) : new Date();
      end.setHours(23, 59, 59, 999);
      this.logger.debug(`获取会话列表: ${start.toISOString()} ~ ${end.toISOString()}`);
      const sessions = await this.chatMessageRepository.getChatSessionListByDateRange(start, end);
      return { sessions };
    }

    // 兼容旧的 days 参数
    const daysNum = parseInt(days || '1', 10);
    this.logger.debug(`获取会话列表: 最近 ${daysNum} 天`);
    const sessions = await this.chatMessageRepository.getChatSessionList(daysNum);
    return { sessions };
  }

  /**
   * 获取每日聊天统计数据（数据库聚合查询，性能优化版本）
   * GET /monitoring/chat-daily-stats?startDate=2024-01-01&endDate=2024-01-31
   * v1.5: 用于趋势图表展示，使用数据库 RPC 函数进行聚合查询
   */
  @Get('chat-daily-stats')
  async getChatDailyStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<
    Array<{
      date: string;
      messageCount: number;
      sessionCount: number;
    }>
  > {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    this.logger.debug(
      `获取每日聊天统计: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );

    const stats = await this.chatMessageRepository.getChatDailyStats(start, end);
    return stats;
  }

  /**
   * 获取聊天汇总统计数据（数据库聚合查询，性能优化版本）
   * GET /monitoring/chat-summary-stats?startDate=2024-01-01&endDate=2024-01-31
   * v1.5: 用于顶部统计栏展示，使用数据库 RPC 函数进行聚合查询
   */
  @Get('chat-summary-stats')
  async getChatSummaryStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{
    totalSessions: number;
    totalMessages: number;
    activeSessions: number;
  }> {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    this.logger.debug(
      `获取聊天汇总统计: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );

    const stats = await this.chatMessageRepository.getChatSummaryStats(start, end);
    return stats;
  }

  /**
   * 获取聊天会话列表（优化版，使用数据库聚合）
   * GET /monitoring/chat-sessions-optimized?startDate=2025-12-13&endDate=2025-12-16
   */
  @Get('chat-sessions-optimized')
  async getChatSessionsOptimized(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<
    Array<{
      chatId: string;
      candidateName?: string;
      managerName?: string;
      messageCount: number;
      lastMessage?: string;
      lastTimestamp?: number;
      avatar?: string;
      contactType?: string;
    }>
  > {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    this.logger.debug(
      `获取聊天会话列表（优化版）: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );

    const sessions = await this.chatMessageRepository.getChatSessionListOptimized(start, end);
    return sessions;
  }

  /**
   * 获取聊天趋势数据
   * GET /monitoring/chat-trend?days=7
   */
  @Get('chat-trend')
  async getChatTrend(@Query('days') days?: string): Promise<
    Array<{
      hour: string;
      message_count: number;
      active_users: number;
      active_chats: number;
    }>
  > {
    const daysNum = parseInt(days || '7', 10);
    this.logger.debug(`获取聊天趋势: 最近 ${daysNum} 天`);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);
    const endDate = new Date();
    const trend = await this.monitoringRepository.getDashboardHourlyTrend(startDate, endDate);
    return trend.map((item) => ({
      hour: item.hour,
      message_count: item.messageCount,
      active_users: item.uniqueUsers,
      active_chats: 0,
    }));
  }

  /**
   * 获取指定会话的聊天记录
   * GET /monitoring/chat-sessions/:chatId/messages
   * v1.3: 新增 messageType, source, contactType, isSelf, avatar, externalUserId 字段
   */
  @Get('chat-sessions/:chatId/messages')
  async getChatSessionMessages(@Param('chatId') chatId: string): Promise<{
    chatId: string;
    messages: Array<{
      messageId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      candidateName?: string;
      managerName?: string;
      // v1.3 新增字段
      messageType?: string;
      source?: string;
      contactType?: string;
      isSelf?: boolean;
      avatar?: string;
      externalUserId?: string;
    }>;
  }> {
    this.logger.debug(`获取会话消息: chatId=${chatId}`);
    const messages = await this.chatMessageRepository.getChatHistoryDetail(chatId);
    return { chatId, messages };
  }

  /**
   * 获取消息统计数据（聚合查询，轻量级）
   * GET /monitoring/message-stats
   * 查询参数:
   *   - startDate: 开始日期 (YYYY-MM-DD)
   *   - endDate: 结束日期 (YYYY-MM-DD)
   * 返回: { total, success, failed, avgDuration }
   */
  @Get('message-stats')
  async getMessageStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    avgDuration: number;
  }> {
    const options: any = {};

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      options.startDate = start;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      options.endDate = end;
    }

    this.logger.debug(`获取消息统计: ${JSON.stringify(options)}`);

    // 直接查询聚合统计（使用 Supabase 的聚合查询，不拉取详细记录）
    const stats = await this.monitoringService.getMessageStatsAsync(
      options.startDate?.getTime() || Date.now() - 24 * 60 * 60 * 1000,
      options.endDate?.getTime() || Date.now(),
    );

    return stats;
  }

  /**
   * 获取最慢消息 Top N（专用接口，数据库排序）
   * GET /monitoring/slowest-messages
   * 查询参数:
   *   - startDate: 开始日期 (YYYY-MM-DD)
   *   - endDate: 结束日期 (YYYY-MM-DD)
   *   - limit: 返回数量 (默认 10)
   */
  @Get('slowest-messages')
  async getSlowestMessages(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ): Promise<any[]> {
    const options: any = {
      limit: limit ? parseInt(limit, 10) : 10,
    };

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      options.startDate = start;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      options.endDate = end;
    }

    this.logger.debug(`获取最慢消息 Top ${options.limit}: ${JSON.stringify(options)}`);
    const records = await this.messageProcessingRepository.getSlowestMessages(
      options.startDate?.getTime(),
      options.endDate?.getTime(),
      options.limit,
    );
    return records;
  }

  /**
   * 获取消息处理记录（持久化数据，支持分页和排序）
   * GET /monitoring/message-processing-records
   * 查询参数:
   *   - startDate: 开始日期 (YYYY-MM-DD)
   *   - endDate: 结束日期 (YYYY-MM-DD)
   *   - status: 状态筛选 (processing|success|failure)
   *   - chatId: 会话ID筛选
   *   - userName: 用户昵称模糊搜索
   *   - orderBy: 排序字段 (receivedAt|aiDuration，默认 receivedAt)
   *   - order: 排序方向 (asc|desc，默认 desc)
   *   - limit: 返回数量限制 (默认 50，最大 200)
   *   - offset: 偏移量 (默认 0)
   */
  @Get('message-processing-records')
  async getMessageProcessingRecords(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: 'processing' | 'success' | 'failure',
    @Query('chatId') chatId?: string,
    @Query('userName') userName?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<any[]> {
    const options: any = {};

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      options.startDate = start;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      options.endDate = end;
    }

    if (status) {
      options.status = status;
    }

    if (chatId) {
      options.chatId = chatId;
    }

    if (userName) {
      options.userName = userName;
    }

    if (limit) {
      options.limit = parseInt(limit, 10);
    }

    if (offset) {
      options.offset = parseInt(offset, 10);
    }

    this.logger.debug(`获取消息处理记录: ${JSON.stringify(options)}`);
    const result = await this.messageProcessingRepository.getMessageProcessingRecords(options);
    return result.records;
  }

  /**
   * 获取单条消息处理记录详情（包含完整的 agent_invocation）
   * GET /monitoring/message-processing-records/:messageId
   */
  @Get('message-processing-records/:messageId')
  async getMessageProcessingRecordDetail(
    @Param('messageId') messageId: string,
  ): Promise<any | null> {
    this.logger.debug(`获取消息处理记录详情: ${messageId}`);
    const record = await this.messageProcessingRepository.getMessageProcessingRecordById(messageId);
    return record;
  }
}
