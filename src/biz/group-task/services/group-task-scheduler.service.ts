import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { CompletionService } from '@agent/completion.service';
import { NotificationStrategy } from '../strategies/notification.strategy';
import { GroupResolverService } from './group-resolver.service';
import { NotificationSenderService } from './notification-sender.service';
import { BrandRotationService } from './brand-rotation.service';
import { OrderGrabStrategy } from '../strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '../strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '../strategies/store-manager.strategy';
import { WorkTipsStrategy } from '../strategies/work-tips.strategy';
import {
  GroupTaskType,
  GroupTaskConfig,
  DEFAULT_GROUP_TASK_CONFIG,
  GroupContext,
  TaskExecutionResult,
  TimeSlot,
} from '../group-task.types';

const CONFIG_KEY = 'group_task_config';

/**
 * 群任务调度编排服务
 *
 * 负责：
 * 1. Cron 定时触发各类通知
 * 2. 编排完整流程：获取群 → 拉数据 → AI生成 → 发送 → 飞书通知
 */
@Injectable()
export class GroupTaskSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(GroupTaskSchedulerService.name);

  private readonly sendDelayMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    private readonly completionService: CompletionService,
    private readonly groupResolver: GroupResolverService,
    private readonly notificationSender: NotificationSenderService,
    private readonly brandRotation: BrandRotationService,
    private readonly orderGrabStrategy: OrderGrabStrategy,
    private readonly partTimeJobStrategy: PartTimeJobStrategy,
    private readonly storeManagerStrategy: StoreManagerStrategy,
    private readonly workTipsStrategy: WorkTipsStrategy,
  ) {
    this.sendDelayMs = parseInt(
      this.configService.get<string>('GROUP_TASK_SEND_DELAY_MS', '2000'),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    const enabled = await this.isEnabled();
    if (enabled) {
      this.logger.log('✅ 群任务调度服务已启动');
    } else {
      this.logger.log('⏸️ 群任务调度服务已禁用');
    }
  }

  // ==================== 运行时配置（Supabase system_config 单 key 存储）====================

  /**
   * 读取群任务配置（一次 DB 查询）
   */
  async getConfig(): Promise<GroupTaskConfig> {
    const stored = await this.systemConfigService.getConfigValue<GroupTaskConfig>(CONFIG_KEY);
    return {
      enabled: stored?.enabled ?? DEFAULT_GROUP_TASK_CONFIG.enabled,
      dryRun: stored?.dryRun ?? DEFAULT_GROUP_TASK_CONFIG.dryRun,
    };
  }

  async isEnabled(): Promise<boolean> {
    return (await this.getConfig()).enabled;
  }

  async isDryRun(): Promise<boolean> {
    return (await this.getConfig()).dryRun;
  }

  // ==================== Cron 调度 ====================

  /** 抢单群 — 上午场 10:00 */
  @Cron('0 10 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabMorning(): Promise<void> {
    await this.executeTask(this.orderGrabStrategy, false, TimeSlot.MORNING);
  }

  /** 抢单群 — 下午场 13:00 */
  @Cron('0 13 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabAfternoon(): Promise<void> {
    await this.executeTask(this.orderGrabStrategy, false, TimeSlot.AFTERNOON);
  }

  /** 兼职群 — 工作日 13:00 */
  @Cron('0 13 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async cronPartTimeJob(): Promise<void> {
    await this.executeTask(this.partTimeJobStrategy);
  }

  /** 抢单群 — 晚上场 17:30 */
  @Cron('30 17 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabEvening(): Promise<void> {
    await this.executeTask(this.orderGrabStrategy, false, TimeSlot.EVENING);
  }

  /** 店长群 — 工作日 10:30 */
  @Cron('30 10 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async cronStoreManager(): Promise<void> {
    await this.executeTask(this.storeManagerStrategy);
  }

  /** 工作小贴士 — 周六 15:00 */
  @Cron('0 15 * * 6', { timeZone: 'Asia/Shanghai' })
  async cronWorkTips(): Promise<void> {
    await this.executeTask(this.workTipsStrategy);
  }

  // ==================== 核心编排 ====================

  /**
   * 执行一次通知任务
   *
   * 可由 Cron 自动触发，也可由 Controller 手动触发。
   */
  async executeTask(
    strategy: NotificationStrategy,
    force = false,
    timeSlot?: TimeSlot,
  ): Promise<TaskExecutionResult> {
    const result: TaskExecutionResult = {
      type: strategy.type,
      totalGroups: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      errors: [],
      details: [],
      startTime: new Date(),
      endTime: new Date(),
    };

    const config = await this.getConfig();
    if (!config.enabled && !force) {
      this.logger.debug(`[${strategy.type}] 任务已禁用，跳过`);
      return result;
    }

    const { dryRun } = config;
    this.logger.log(`[${strategy.type}] 开始执行... (dryRun=${dryRun})`);

    try {
      // 1. 获取目标群列表
      const groups = await this.groupResolver.resolveGroups(strategy.tagPrefix);
      result.totalGroups = groups.length;

      if (groups.length === 0) {
        this.logger.warn(`[${strategy.type}] 未找到匹配群 (tagPrefix=${strategy.tagPrefix})`);
        result.endTime = new Date();
        await this.notificationSender.reportToFeishu(result, dryRun);
        return result;
      }

      // 2. 按 (城市+行业) 分组，同组共享数据和 AI 生成结果
      const groupMap = this.groupByCityIndustry(groups);
      this.logger.log(`[${strategy.type}] ${groups.length} 个群，${groupMap.size} 个分组`);

      // 3. 逐分组处理
      for (const [groupKey, groupMembers] of groupMap) {
        try {
          // 3a. 用分组代表拉取数据（同组数据相同，只拉一次）
          const representative = groupMembers[0];
          const data = await strategy.fetchData(representative);

          if (!data.hasData) {
            result.skippedCount += groupMembers.length;
            result.details.push({
              groupKey,
              groupCount: groupMembers.length,
              dataSummary: data.summary,
              status: 'skipped',
              groupNames: groupMembers.map((g) => g.groupName),
            });
            this.logger.log(
              `[${strategy.type}] 跳过分组 [${groupKey}] (${groupMembers.length}群): ${data.summary}`,
            );
            continue;
          }

          // 3b. 生成消息（模板 or AI，同组只生成一次）
          let message: string;
          if (strategy.needsAI && strategy.buildPrompt) {
            // AI 生成
            const prompt = strategy.buildPrompt(data, representative);
            message = await this.completionService.generateSimple({
              systemPrompt: prompt.systemPrompt,
              userMessage: prompt.userMessage,
            });
            // 追加固定尾部（如有）
            if (strategy.appendFooter) {
              message = strategy.appendFooter(message, data);
            }
          } else if (strategy.buildMessage) {
            // 纯模板
            message = strategy.buildMessage(data, representative, timeSlot);
          } else {
            this.logger.error(`[${strategy.type}] 策略未实现 buildMessage 或 buildPrompt`);
            continue;
          }

          // 3c. 同组所有群发送相同消息
          for (const group of groupMembers) {
            try {
              await this.notificationSender.sendToGroup(group, message, strategy.type, dryRun);
              result.successCount++;
              this.logger.log(`[${strategy.type}] ✅ ${group.groupName}`);
              await this.delay(this.sendDelayMs);
            } catch (error: unknown) {
              result.failedCount++;
              const errorMsg = error instanceof Error ? error.message : String(error);
              result.errors.push({ groupName: group.groupName, error: errorMsg });
              this.logger.error(`[${strategy.type}] ❌ ${group.groupName}: ${errorMsg}`);
            }
          }

          // 3d. 记录品牌轮转（兼职群：同城市+行业的群共享品牌轮转）
          if (strategy.type === GroupTaskType.PART_TIME_JOB && data.payload?.brand) {
            for (const group of groupMembers) {
              await this.brandRotation.recordPushedBrand(
                group.imRoomId,
                data.payload.brand as string,
              );
            }
          }

          result.details.push({
            groupKey,
            groupCount: groupMembers.length,
            dataSummary: data.summary,
            status: 'success',
            groupNames: groupMembers.map((g) => g.groupName),
          });

          this.logger.log(
            `[${strategy.type}] 分组 [${groupKey}] 完成: ${groupMembers.length}群, ${data.summary}`,
          );
        } catch (error: unknown) {
          result.failedCount += groupMembers.length;
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push({ groupName: `分组[${groupKey}]`, error: errorMsg });
          result.details.push({
            groupKey,
            groupCount: groupMembers.length,
            dataSummary: errorMsg,
            status: 'failed',
            groupNames: groupMembers.map((g) => g.groupName),
          });
          this.logger.error(`[${strategy.type}] ❌ 分组 [${groupKey}]: ${errorMsg}`);
        }
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${strategy.type}] 任务整体失败: ${errorMsg}`);
      result.errors.push({ groupName: '(整体)', error: errorMsg });
    }

    result.endTime = new Date();

    // 3. 飞书通知结果
    await this.notificationSender.reportToFeishu(result, dryRun);

    const duration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
    this.logger.log(
      `[${strategy.type}] 执行完成: 成功=${result.successCount} 失败=${result.failedCount} 跳过=${result.skippedCount} 耗时=${duration.toFixed(1)}s`,
    );

    return result;
  }

  // ==================== 手动触发（供 Controller 调用）====================

  /** 获取所有策略 */
  getStrategy(type: GroupTaskType): NotificationStrategy | null {
    const map: Record<GroupTaskType, NotificationStrategy> = {
      [GroupTaskType.ORDER_GRAB]: this.orderGrabStrategy,
      [GroupTaskType.PART_TIME_JOB]: this.partTimeJobStrategy,
      [GroupTaskType.STORE_MANAGER]: this.storeManagerStrategy,
      [GroupTaskType.WORK_TIPS]: this.workTipsStrategy,
    };
    return map[type] || null;
  }

  /**
   * 按 (城市+行业) 分组
   *
   * 同城市同行业的群共享数据和 AI 文案，避免重复拉取和生成。
   * 例：5 个 "兼职群_上海_餐饮" → 一组，拉一次数据，生成一次文案，发 5 个群。
   */
  private groupByCityIndustry(groups: GroupContext[]): Map<string, GroupContext[]> {
    const map = new Map<string, GroupContext[]>();
    for (const group of groups) {
      const key = group.industry ? `${group.city}_${group.industry}` : group.city;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(group);
    }
    return map;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
