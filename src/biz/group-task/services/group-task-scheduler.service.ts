import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { randomUUID } from 'node:crypto';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { NotificationStrategy } from '../strategies/notification.strategy';
import { OrderGrabStrategy } from '../strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '../strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '../strategies/store-manager.strategy';
import { WorkTipsStrategy } from '../strategies/work-tips.strategy';
import { Environment } from '@enums/environment.enum';
import { GroupTaskType, GroupTaskConfig, TimeSlot } from '../group-task.types';
import {
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
  PlanJobData,
} from '../queue/group-task-queue.constants';

/**
 * 群任务调度编排服务
 *
 * 发送过程全部委托给 `GroupTaskProcessor`（Bull 队列驱动），
 * 本服务只负责：
 *   1. Cron 定时触发
 *   2. 配置闸门（enabled / dryRun）
 *   3. 把一次执行的参数冻结成 plan job 入队，由队列承担持久化 & 故障恢复
 *
 * 进程在发送过程中被部署重启时，未完成的 send/prepare job 仍在 Redis，
 * 新进程起来后 Bull 会继续派发，不会导致"发一条就没了"的事故。
 */
@Injectable()
export class GroupTaskSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(GroupTaskSchedulerService.name);

  private readonly sendDelayMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    @InjectQueue(GROUP_TASK_QUEUE_NAME)
    private readonly groupTaskQueue: Queue,
    private readonly orderGrabStrategy: OrderGrabStrategy,
    private readonly partTimeJobStrategy: PartTimeJobStrategy,
    private readonly storeManagerStrategy: StoreManagerStrategy,
    private readonly workTipsStrategy: WorkTipsStrategy,
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

  // ==================== 运行时配置 ====================

  async getConfig(): Promise<GroupTaskConfig> {
    return this.systemConfigService.getGroupTaskConfig();
  }

  async isEnabled(): Promise<boolean> {
    return (await this.getConfig()).enabled;
  }

  async isDryRun(): Promise<boolean> {
    return (await this.getConfig()).dryRun;
  }

  async updateConfig(partial: Partial<GroupTaskConfig>): Promise<GroupTaskConfig> {
    return this.systemConfigService.updateGroupTaskConfig(partial);
  }

  // ==================== Cron 调度 ====================

  /** 抢单群 — 上午场 10:00 */
  @Cron('0 10 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabMorning(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.orderGrabStrategy.type)) return;
    await this.executeTask(this.orderGrabStrategy, {
      timeSlot: TimeSlot.MORNING,
      trigger: 'cron',
    });
  }

  /** 抢单群 — 下午场 13:00 */
  @Cron('0 13 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabAfternoon(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.orderGrabStrategy.type)) return;
    await this.executeTask(this.orderGrabStrategy, {
      timeSlot: TimeSlot.AFTERNOON,
      trigger: 'cron',
    });
  }

  /** 兼职群 — 工作日 13:30 */
  @Cron('30 13 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async cronPartTimeJob(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.partTimeJobStrategy.type)) return;
    await this.executeTask(this.partTimeJobStrategy, { trigger: 'cron' });
  }

  /** 抢单群 — 晚上场 17:30 */
  @Cron('30 17 * * *', { timeZone: 'Asia/Shanghai' })
  async cronOrderGrabEvening(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.orderGrabStrategy.type)) return;
    await this.executeTask(this.orderGrabStrategy, {
      timeSlot: TimeSlot.EVENING,
      trigger: 'cron',
    });
  }

  /** 店长群 — 工作日 10:30 */
  @Cron('30 10 * * 1-5', { timeZone: 'Asia/Shanghai' })
  async cronStoreManager(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.storeManagerStrategy.type)) return;
    await this.executeTask(this.storeManagerStrategy, { trigger: 'cron' });
  }

  /** 工作小贴士 — 周六 15:00 */
  @Cron('0 15 * * 6', { timeZone: 'Asia/Shanghai' })
  async cronWorkTips(): Promise<void> {
    if (!this.shouldRunScheduledTask(this.workTipsStrategy.type)) return;
    await this.executeTask(this.workTipsStrategy, { trigger: 'cron' });
  }

  // ==================== 核心入口（入队而非执行） ====================

  /**
   * 将一次群任务执行入队。
   *
   * @returns execId — 写入 Bull plan job data；可用于后续查询 / 补发追踪
   *          skipped — 非空时代表本次未入队（如配置禁用），前端可据此区分
   */
  async executeTask(
    strategy: NotificationStrategy,
    options: {
      forceEnabled?: boolean;
      forceSend?: boolean;
      timeSlot?: TimeSlot;
      trigger?: 'cron' | 'manual';
    } = {},
  ): Promise<{ execId: string | null; skipped?: 'disabled' | 'duplicate' }> {
    const { forceEnabled = false, forceSend = false, timeSlot, trigger = 'manual' } = options;

    const config = await this.getConfig();
    if (!config.enabled && !forceEnabled) {
      this.logger.debug(`[${strategy.type}] 任务已禁用，跳过入队`);
      return { execId: null, skipped: 'disabled' };
    }

    const dryRun = forceSend ? false : config.dryRun;
    const execId = randomUUID();
    const startedAt = Date.now();

    const planData: PlanJobData = {
      execId,
      type: strategy.type,
      timeSlot,
      dryRun,
      sendDelayMs: this.sendDelayMs,
      startedAt,
      trigger,
    };

    // cron 在同一分钟内重复触发（极端边界）由确定性 jobId 去重；
    // manual 总是新 execId，不存在重复问题。
    const jobId =
      trigger === 'cron'
        ? `plan:cron:${strategy.type}:${this.formatMinuteUtc(startedAt)}:${timeSlot ?? 'default'}`
        : `plan:manual:${strategy.type}:${execId}`;

    try {
      const job = await this.groupTaskQueue.add(GroupTaskJobName.PLAN, planData, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 200 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
      });

      // Bull 在 jobId 冲突时会返回已存在的 job，data 仍是首次的 planData
      // 这里通过比对 data.execId 判断是否实际入队
      const acceptedExecId = (job.data as PlanJobData | undefined)?.execId ?? execId;
      if (acceptedExecId !== execId) {
        this.logger.warn(
          `[${strategy.type}] jobId=${jobId} 已存在，沿用既有 exec=${acceptedExecId}`,
        );
        return { execId: acceptedExecId, skipped: 'duplicate' };
      }

      this.logger.log(
        `[${strategy.type}] plan 已入队 exec=${execId} trigger=${trigger} dryRun=${dryRun}`,
      );
      return { execId };
    } catch (error) {
      this.logger.error(
        `[${strategy.type}] plan 入队失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  // ==================== 手动触发辅助 ====================

  getStrategy(type: GroupTaskType): NotificationStrategy | null {
    const map: Record<GroupTaskType, NotificationStrategy> = {
      [GroupTaskType.ORDER_GRAB]: this.orderGrabStrategy,
      [GroupTaskType.PART_TIME_JOB]: this.partTimeJobStrategy,
      [GroupTaskType.STORE_MANAGER]: this.storeManagerStrategy,
      [GroupTaskType.WORK_TIPS]: this.workTipsStrategy,
    };
    return map[type] || null;
  }

  // ==================== 内部工具 ====================

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

  /** 将毫秒戳格式化为分钟级 UTC key，用于同分钟 cron 去重 */
  private formatMinuteUtc(tsMs: number): string {
    const d = new Date(tsMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `${y}${m}${day}${h}${min}`;
  }
}
