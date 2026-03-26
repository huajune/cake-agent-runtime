import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import {
  GroupContext,
  GroupTaskType,
  TaskExecutionResult,
  GROUP_TASK_TYPE_NAMES,
} from '../group-task.types';

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
 * 使用小组级 API 发送消息（_apiType: 'group'，用 chatId）。
 * 飞书通知复用 FeishuWebhookService（INTERVIEW_BOOKING 类型，自带签名）。
 */
@Injectable()
export class NotificationSenderService {
  private readonly logger = new Logger(NotificationSenderService.name);

  private readonly miniprogramAppid: string;
  private readonly miniprogramUsername: string;
  private readonly miniprogramThumbUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly messageSenderService: MessageSenderService,
    private readonly webhookService: FeishuWebhookService,
  ) {
    this.miniprogramAppid = this.configService.get<string>(
      'MINIPROGRAM_APPID',
      'wx0703d5b561bca48c',
    );
    this.miniprogramUsername = this.configService.get<string>(
      'MINIPROGRAM_USERNAME',
      'gh_55e19c5164da',
    );
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

    // 1. 发送文本消息（小组级 API）
    await this.messageSenderService.sendMessage({
      _apiType: 'group',
      token: group.token,
      chatId: group.chatId,
      messageType: 7, // TEXT（企业级类型，会被 service 转换为小组级 0）
      payload: { text: message },
    });

    // 2. 兼职群额外发送小程序卡片
    if (type === GroupTaskType.PART_TIME_JOB) {
      await this.delay(1000);
      await this.messageSenderService.sendMessage({
        _apiType: 'group',
        token: group.token,
        chatId: group.chatId,
        messageType: 9, // MINI_PROGRAM（企业级类型，会被转换为小组级 4）
        payload: {
          appid: this.miniprogramAppid,
          username: this.miniprogramUsername,
          title: MINIPROGRAM_DEFAULTS.TITLE,
          thumbUrl: this.miniprogramThumbUrl,
          pagePath: MINIPROGRAM_DEFAULTS.PAGE_PATH,
          description: MINIPROGRAM_DEFAULTS.DESCRIPTION,
        },
      });
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
    const modeTag = dryRun ? '预览' : '已发送';

    const card = this.webhookService.buildCard(
      `📋 [${modeTag}] ${typeName} → ${group.groupName}`,
      [
        `**目标群**: ${group.groupName}`,
        `**标签**: ${group.tag} / ${group.city}${group.industry ? ` / ${group.industry}` : ''}`,
        '---',
        message,
      ].join('\n'),
      'blue',
    );

    await this.webhookService.sendMessage('INTERVIEW_BOOKING', card);
    this.logger.log(`[试运行] 已发送飞书预览: ${group.groupName}`);
  }

  /**
   * 发送任务执行结果到飞书
   */
  async reportToFeishu(result: TaskExecutionResult, dryRun: boolean): Promise<void> {
    const duration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
    const typeName = GROUP_TASK_TYPE_NAMES[result.type] || result.type;
    const modeLabel = dryRun ? '[试运行] ' : '';

    const isSuccess = result.failedCount === 0;
    const isPartialFail = result.successCount > 0 && result.failedCount > 0;

    let statusText: string;
    let color: 'blue' | 'green' | 'yellow' | 'red';
    if (isSuccess) {
      statusText = '全部成功';
      color = 'green';
    } else if (isPartialFail) {
      statusText = '部分失败';
      color = 'yellow';
    } else {
      statusText = '全部失败';
      color = 'red';
    }

    // 构建分组详情
    const lines: string[] = [
      `**总群数**: ${result.totalGroups} | **分组**: ${result.details.length}`,
      `**成功**: ${result.successCount} | **失败**: ${result.failedCount} | **跳过**: ${result.skippedCount} | **耗时**: ${duration.toFixed(1)}s`,
      '---',
    ];

    // 成功分组
    const successDetails = result.details.filter((d) => d.status === 'success');
    if (successDetails.length > 0) {
      for (const d of successDetails) {
        lines.push(`✅ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`);
      }
    }

    // 跳过分组
    const skippedDetails = result.details.filter((d) => d.status === 'skipped');
    if (skippedDetails.length > 0) {
      for (const d of skippedDetails) {
        lines.push(`⏭️ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`);
      }
    }

    // 失败分组
    const failedDetails = result.details.filter((d) => d.status === 'failed');
    if (failedDetails.length > 0) {
      for (const d of failedDetails) {
        lines.push(`❌ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`);
      }
    }

    const card = this.webhookService.buildCard(
      `📢 ${modeLabel}${typeName}通知 — ${statusText}`,
      lines.join('\n'),
      color,
    );

    await this.webhookService.sendMessage('INTERVIEW_BOOKING', card);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
