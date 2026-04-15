import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { CompletionService } from '@agent/completion.service';
import { RedisService } from '@infra/redis/redis.service';
import { AlertLevel } from '@enums/alert.enum';
import { NotificationStrategy } from '../strategies/notification.strategy';
import { GroupResolverService } from './group-resolver.service';
import { NotificationSenderService } from './notification-sender.service';
import { BrandRotationService } from './brand-rotation.service';
import { OrderGrabStrategy } from '../strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '../strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '../strategies/store-manager.strategy';
import { WorkTipsStrategy } from '../strategies/work-tips.strategy';
import { Environment } from '@enums/environment.enum';
import {
  GroupTaskType,
  GroupTaskConfig,
  GroupContext,
  TaskExecutionResult,
  TimeSlot,
} from '../group-task.types';
import { resolveHumanizedDelayMs } from '../utils/humanized-delay.util';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

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
  private readonly TASK_LOCK_TTL_SECONDS = 300;

  private readonly sendDelayMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    private readonly completionService: CompletionService,
    private readonly redisService: RedisService,
    private readonly groupResolver: GroupResolverService,
    private readonly notificationSender: NotificationSenderService,
    private readonly brandRotation: BrandRotationService,
    private readonly orderGrabStrategy: OrderGrabStrategy,
    private readonly partTimeJobStrategy: PartTimeJobStrategy,
    private readonly storeManagerStrategy: StoreManagerStrategy,
    private readonly workTipsStrategy: WorkTipsStrategy,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.sendDelayMs = parseInt(
      this.configService.get<string>('GROUP_TASK_SEND_DELAY_MS', '60000'),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.isProductionEnvironment()) {
      this.logger.log(
        `🧪 当前环境=${this.getCurrentEnvironment()}，群任务 Cron 自动触发已禁用，仅支持手动触发`,
      );
      return;
    }

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
    return this.systemConfigService.getGroupTaskConfig();
  }

  async isEnabled(): Promise<boolean> {
    return (await this.getConfig()).enabled;
  }

  async isDryRun(): Promise<boolean> {
    return (await this.getConfig()).dryRun;
  }

  /**
   * 更新群任务配置（read-merge-write，唯一写入点）
   */
  async updateConfig(partial: Partial<GroupTaskConfig>): Promise<GroupTaskConfig> {
    return this.systemConfigService.updateGroupTaskConfig(partial);
  }

  // ==================== Cron 调度 ====================

  /** 抢单群 — 上午场 10:00 */
  @Cron('0 10 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabMorning(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.orderGrabStrategy.type)) return;
    await this.executeTask(this.orderGrabStrategy, { timeSlot: TimeSlot.MORNING });
  }

  /** 抢单群 — 下午场 13:00 */
  @Cron('0 13 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabAfternoon(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.orderGrabStrategy.type)) return;
    await this.executeTask(this.orderGrabStrategy, { timeSlot: TimeSlot.AFTERNOON });
  }

  /** 兼职群 — 工作日 13:30 */
  @Cron('30 13 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async cronPartTimeJob(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.partTimeJobStrategy.type)) return;
    await this.executeTask(this.partTimeJobStrategy);
  }

  /** 抢单群 — 晚上场 17:30 */
  @Cron('30 17 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabEvening(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.orderGrabStrategy.type)) return;
    await this.executeTask(this.orderGrabStrategy, { timeSlot: TimeSlot.EVENING });
  }

  /** 店长群 — 工作日 10:30 */
  @Cron('30 10 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async cronStoreManager(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.storeManagerStrategy.type)) return;
    await this.executeTask(this.storeManagerStrategy);
  }

  /** 工作小贴士 — 周六 15:00 */
  @Cron('0 15 * * 6', { timeZone: 'Asia/Shanghai' })
  async cronWorkTips(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.workTipsStrategy.type)) return;
    await this.executeTask(this.workTipsStrategy);
  }

  // ==================== 核心编排 ====================

  /**
   * 执行一次通知任务
   *
   * 可由 Cron 自动触发，也可由 Controller 手动触发。
   */
  /**
   * 执行一次通知任务
   *
   * @param strategy 通知策略
   * @param options.forceEnabled 绕过 enabled 开关（即使定时任务关闭也能执行）
   * @param options.forceSend    绕过 dryRun 设置（即使试运行模式也发真实消息）
   * @param options.timeSlot     场次标识（同一任务一天多次执行时区分）
   */
  async executeTask(
    strategy: NotificationStrategy,
    options: { forceEnabled?: boolean; forceSend?: boolean; timeSlot?: TimeSlot } = {},
  ): Promise<TaskExecutionResult> {
    const { forceEnabled = false, forceSend = false, timeSlot } = options;

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
    if (!config.enabled && !forceEnabled) {
      this.logger.debug(`[${strategy.type}] 任务已禁用，跳过`);
      return result;
    }

    const dryRun = forceSend ? false : config.dryRun;
    const lockKey = this.getTaskLockKey(strategy.type);
    const lockOwner = `${strategy.type}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    if (!(await this.acquireTaskLock(lockKey, lockOwner))) {
      this.logger.warn(`[${strategy.type}] 任务已在执行中，跳过重复触发`);
      result.endTime = new Date();
      return result;
    }

    try {
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

        if (strategy.prepareTask) {
          await strategy.prepareTask({ timeSlot });
        }

        // 2. 按 (城市+行业) 分组，同组共享数据和 AI 生成结果
        const groupMap =
          strategy.type === GroupTaskType.ORDER_GRAB
            ? this.groupOrderGrabGroups(groups)
            : this.groupByCityIndustry(groups);
        this.logger.log(`[${strategy.type}] ${groups.length} 个群，${groupMap.size} 个分组`);

        // 3. 逐分组处理
        for (const [groupKey, groupMembers] of groupMap) {
          try {
            // 3a. 用分组代表拉取数据（同组数据相同，只拉一次）
            const representative = groupMembers[0];
            const data = await strategy.fetchData(representative, timeSlot);

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
            const followUpMessage = data.payload?.followUpMessage as string | undefined;
            const successGroups: GroupContext[] = [];
            for (const [index, group] of groupMembers.entries()) {
              try {
                await this.notificationSender.sendToGroup(group, message, strategy.type, dryRun);
                // 跟随消息（如店长群问候语）单独发送
                if (followUpMessage) {
                  await this.notificationSender.sendTextToGroup(group, followUpMessage, dryRun);
                }
                result.successCount++;
                successGroups.push(group);
                this.logger.log(`[${strategy.type}] ✅ ${group.groupName}`);
              } catch (error: unknown) {
                result.failedCount++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                result.errors.push({ groupName: group.groupName, error: errorMsg });
                this.logger.error(`[${strategy.type}] ❌ ${group.groupName}: ${errorMsg}`);
              } finally {
                if (index < groupMembers.length - 1) {
                  await this.pauseBetweenGroups(group.groupName);
                }
              }
            }

            // 3d. 记录品牌轮转（兼职群：同城市+行业的群共享品牌轮转）
            // 仅对发送成功的群记录品牌轮转，避免发送失败导致浪费当前品牌甚至跳过
            if (strategy.type === GroupTaskType.PART_TIME_JOB && data.payload?.brand) {
              for (const group of successGroups) {
                await this.brandRotation.recordPushedBrand(
                  group.imRoomId,
                  data.payload.brand as string,
                );
              }
            }

            const status =
              successGroups.length === groupMembers.length
                ? 'success'
                : successGroups.length > 0
                  ? 'partial'
                  : 'failed';

            result.details.push({
              groupKey,
              groupCount: groupMembers.length,
              dataSummary: data.summary,
              status,
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
        this.exceptionNotifier?.notifyAsync({
          source: {
            subsystem: 'group-task',
            component: 'GroupTaskSchedulerService',
            action: 'executeTask',
            trigger: 'manual',
          },
          code: 'group_task.execution_failed',
          summary: `${strategy.type} 群任务执行失败`,
          error,
          severity: AlertLevel.ERROR,
          scope: {
            scenario: strategy.type,
          },
          diagnostics: {
            payload: {
              dryRun,
              timeSlot,
            },
          },
        });
      }

      result.endTime = new Date();

      // 3. 飞书通知结果
      try {
        await this.notificationSender.reportToFeishu(result, dryRun);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push({ groupName: '(飞书通知群)', error: errorMsg });
        this.logger.error(`[${strategy.type}] 飞书通知发送失败: ${errorMsg}`);
      }

      const duration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
      this.logger.log(
        `[${strategy.type}] 执行完成: 成功=${result.successCount} 失败=${result.failedCount} 跳过=${result.skippedCount} 耗时=${duration.toFixed(1)}s`,
      );

      return result;
    } finally {
      await this.releaseTaskLock(lockKey, lockOwner);
    }
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

  /**
   * 抢单群按“实际取数地区”分组，而不是按群标签里的归属城市分组。
   * 例：标签都挂在武汉名下的荆州/宜昌群，也必须各自单独拉数和发消息。
   */
  private groupOrderGrabGroups(groups: GroupContext[]): Map<string, GroupContext[]> {
    const map = new Map<string, GroupContext[]>();
    for (const group of groups) {
      const key = this.resolveOrderGrabGroupKey(group);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(group);
    }
    return map;
  }

  private resolveOrderGrabGroupKey(group: GroupContext): string {
    const strategy = this.orderGrabStrategy as OrderGrabStrategy & {
      resolveOrderGrabGroupKey?: (context: GroupContext) => string;
    };
    return strategy.resolveOrderGrabGroupKey?.(group) ?? group.city;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async pauseBetweenGroups(groupName: string): Promise<void> {
    const delayMs = resolveHumanizedDelayMs(this.sendDelayMs);
    if (delayMs <= 0) return;

    this.logger.debug(`[群任务] ${groupName} 发送完成后等待 ${delayMs}ms，再继续下一个群`);
    await this.delay(delayMs);
  }

  private shouldRunScheduledTask(type: GroupTaskType): boolean {
    if (this.isProductionEnvironment()) {
      return true;
    }

    this.logger.debug(
      `[${type}] 当前环境=${this.getCurrentEnvironment()}，跳过 Cron 自动触发，仅允许手动触发`,
    );
    return false;
  }

  private isProductionEnvironment(): boolean {
    return this.getCurrentEnvironment() === Environment.Production;
  }

  private getCurrentEnvironment(): Environment {
    return this.configService.get<Environment>('NODE_ENV', Environment.Development);
  }

  private getTaskLockKey(type: GroupTaskType): string {
    return `group-task:lock:${type}`;
  }

  private async acquireTaskLock(lockKey: string, ownerToken: string): Promise<boolean> {
    const result = await this.redisService.getClient().set(lockKey, ownerToken, {
      nx: true,
      ex: this.TASK_LOCK_TTL_SECONDS,
    });

    return result === 'OK';
  }

  private async releaseTaskLock(lockKey: string, ownerToken: string): Promise<void> {
    try {
      await this.redisService.getClient().eval(
        `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          end
          return 0
        `,
        [lockKey],
        [ownerToken],
      );
    } catch (error) {
      this.logger.warn(
        `[${lockKey}] 释放群任务锁失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
