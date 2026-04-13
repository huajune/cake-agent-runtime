import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { AlertLevel } from '@enums/alert.enum';
import {
  GroupContext,
  GroupTaskType,
  TaskExecutionResult,
  GROUP_TASK_TYPE_NAMES,
} from '../group-task.types';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';
import { resolveHumanizedDelayMs } from '../utils/humanized-delay.util';

/** 独立客找工作小程序默认值（可通过环境变量覆盖） */
const MINIPROGRAM_DEFAULTS = {
  TITLE: '独立客找工作',
  PAGE_PATH: 'pages/job/index',
  DESCRIPTION: '点击查看更多岗位',
  THUMB_URL: '',
} as const;

/**
 * 通知发送服务
 *
 * 使用企业级 API 发送消息（token + imBotId + imRoomId）。
 * 小组级 API 对部分群存在 chatId 缺失/会话未建立等边界问题，主动推送统一走企业级。
 * 飞书通知统一走“消息通知群”发送服务。
 */
@Injectable()
export class NotificationSenderService {
  private readonly logger = new Logger(NotificationSenderService.name);

  private readonly enterpriseToken: string;
  private readonly sendDelayMs: number;
  private readonly miniprogramAppid: string;
  private readonly miniprogramUsername: string;
  private readonly miniprogramThumbUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly messageSenderService: MessageSenderService,
    private readonly opsNotifier: OpsNotifierService,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.enterpriseToken = this.configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() || '';
    this.sendDelayMs = parseInt(
      this.configService.get<string>('GROUP_TASK_SEND_DELAY_MS', '60000'),
      10,
    );
    this.miniprogramAppid = this.configService.get<string>('MINIPROGRAM_APPID', '');
    this.miniprogramUsername = this.configService.get<string>('MINIPROGRAM_USERNAME', '');
    this.miniprogramThumbUrl = this.configService.get<string>('MINIPROGRAM_THUMB_URL', '');
  }

  /**
   * 发送消息到目标群
   */
  async sendToGroup(
    group: GroupContext,
    message: string,
    type: GroupTaskType,
    dryRun: boolean,
  ): Promise<void> {
    // 飞书群始终发一份（试运行=预览，生产=监控）
    await this.sendFeishuPreview(group, message, type, dryRun);

    // 试运行模式：只发飞书，不发企微群
    if (dryRun) return;

    this.assertEnterpriseSendable(group);

    // 1. 发送文本消息（企业级 API）
    await this.sendEnterpriseGroupMessage(
      group,
      7, // TEXT
      { text: message },
      '主消息',
    );

    // 2. 兼职群额外发送小程序卡片（需要 appid + username 配置）
    if (type === GroupTaskType.PART_TIME_JOB) {
      await this.sendPartTimeMiniProgramCard(group);
    }
  }

  /**
   * 发送纯文本消息到目标群（跟随消息，不触发小程序卡片和飞书预览）
   */
  async sendTextToGroup(group: GroupContext, text: string, dryRun: boolean): Promise<void> {
    if (dryRun) return;

    this.assertEnterpriseSendable(group);

    await this.sendEnterpriseGroupMessage(group, 7, { text }, '跟随文本');
  }

  /**
   * 校验企业级发送所需字段齐全，否则抛错让 scheduler 计入 errors 并走到飞书卡片
   */
  private assertEnterpriseSendable(group: GroupContext): void {
    if (!this.enterpriseToken) {
      throw new Error('STRIDE_ENTERPRISE_TOKEN 未配置，无法发送企业级消息');
    }
    if (!group.imBotId) {
      throw new Error(`群 ${group.groupName} 缺少 imBotId（botInfo.weixin），无法发送企业级消息`);
    }
    if (!group.imRoomId) {
      throw new Error(`群 ${group.groupName} 缺少 imRoomId（wxid），无法发送企业级消息`);
    }
  }

  /**
   * 发送飞书预览（试运行模式）
   */
  private async sendFeishuPreview(
    group: GroupContext,
    message: string,
    type: GroupTaskType,
    dryRun: boolean,
  ): Promise<void> {
    const typeName = GROUP_TASK_TYPE_NAMES[type] || type;

    if (dryRun) {
      try {
        await this.opsNotifier.sendGroupTaskPreview({
          groupName: group.groupName,
          tag: group.tag,
          city: group.city,
          industry: group.industry,
          typeName,
          message,
          dryRun,
        });
        this.logger.log(`[试运行] 已发送飞书预览: ${group.groupName}`);
        return;
      } catch (error) {
        this.notifyFeishuSendFailure(typeName, group, error, true);
        throw error;
      }
    }

    const sent = await this.opsNotifier.sendGroupTaskPreview({
      groupName: group.groupName,
      tag: group.tag,
      city: group.city,
      industry: group.industry,
      typeName,
      message,
      dryRun,
    });
    if (!sent) {
      const error = new Error(
        `飞书通知群预览发送失败: ${typeName} -> ${group.groupName}，请检查 MESSAGE_NOTIFICATION_WEBHOOK_URL / MESSAGE_NOTIFICATION_WEBHOOK_SECRET 或默认 webhook 配置`,
      );
      this.logger.error(`[群任务] ${error.message}`);
      this.notifyFeishuSendFailure(typeName, group, error, false);
      return;
    }

    this.logger.log(`[生产] 已发送飞书监控卡片: ${group.groupName}`);
  }

  private async sendPartTimeMiniProgramCard(group: GroupContext): Promise<void> {
    if (!this.miniprogramAppid || !this.miniprogramUsername) {
      this.logger.warn('[兼职群] 未配置 MINIPROGRAM_APPID 或 MINIPROGRAM_USERNAME，跳过小程序卡片');
      return;
    }

    const payload = {
      appid: this.miniprogramAppid,
      username: this.miniprogramUsername,
      title: MINIPROGRAM_DEFAULTS.TITLE,
      thumbUrl: this.miniprogramThumbUrl,
      pagePath: MINIPROGRAM_DEFAULTS.PAGE_PATH,
      description: MINIPROGRAM_DEFAULTS.DESCRIPTION,
    };

    try {
      await this.sendEnterpriseGroupMessage(
        group,
        9, // MINI_PROGRAM
        payload,
        '兼职小程序卡片',
      );
      this.logger.log(`[兼职群] 小程序卡片已通过企业级 API 发送: ${group.groupName}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[兼职群] 小程序卡片发送失败 (${group.groupName}): ${message}`);
    }
  }

  /**
   * 发送任务执行结果到飞书
   */
  async reportToFeishu(result: TaskExecutionResult, dryRun: boolean): Promise<void> {
    const duration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
    const typeName = GROUP_TASK_TYPE_NAMES[result.type] || result.type;
    const modeLabel = dryRun ? '[试运行] ' : '';

    try {
      await this.opsNotifier.sendGroupTaskReport({
        typeName: `${modeLabel}${typeName}`,
        dryRun,
        totalGroups: result.totalGroups,
        successCount: result.successCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
        durationSeconds: duration,
        details: result.details,
        errors: result.errors,
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      });
    } catch (error) {
      this.exceptionNotifier?.notifyAsync({
        source: 'group-task:report-to-feishu',
        errorType: 'group_task_feishu_report_failed',
        title: `${typeName} 执行汇总发送失败`,
        error,
        level: AlertLevel.ERROR,
        extra: {
          type: result.type,
          dryRun,
          totalGroups: result.totalGroups,
          successCount: result.successCount,
          failedCount: result.failedCount,
          skippedCount: result.skippedCount,
        },
      });
      throw error;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendEnterpriseGroupMessage(
    group: GroupContext,
    messageType: number,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    const delayMs = resolveHumanizedDelayMs(this.sendDelayMs);
    if (delayMs > 0) {
      this.logger.debug(
        `[群任务] ${group.groupName} ${label}前等待 ${delayMs}ms，模拟人工发送节奏`,
      );
      await this.delay(delayMs);
    }

    await this.messageSenderService.sendMessage({
      token: this.enterpriseToken,
      imBotId: group.imBotId,
      imRoomId: group.imRoomId,
      messageType,
      payload,
    });
  }

  private notifyFeishuSendFailure(
    typeName: string,
    group: GroupContext,
    error: unknown,
    dryRun: boolean,
  ): void {
    this.exceptionNotifier?.notifyAsync({
      source: 'group-task:feishu-preview',
      errorType: 'group_task_feishu_preview_failed',
      title: `${typeName} 飞书预览发送失败`,
      error,
      level: AlertLevel.ERROR,
      extra: {
        groupName: group.groupName,
        tag: group.tag,
        city: group.city,
        industry: group.industry,
        dryRun,
      },
    });
  }
}
