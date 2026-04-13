import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import {
  GroupContext,
  GroupTaskType,
  TaskExecutionResult,
  GROUP_TASK_TYPE_NAMES,
} from '../group-task.types';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';

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
  private readonly miniprogramAppid: string;
  private readonly miniprogramUsername: string;
  private readonly miniprogramThumbUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly messageSenderService: MessageSenderService,
    private readonly webhookService: FeishuWebhookService,
    private readonly cardBuilder: FeishuCardBuilderService,
  ) {
    this.enterpriseToken = this.configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() || '';
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
    await this.messageSenderService.sendMessage({
      token: this.enterpriseToken,
      imBotId: group.imBotId,
      imRoomId: group.imRoomId,
      messageType: 7, // TEXT
      payload: { text: message },
    });

    // 2. 兼职群额外发送小程序卡片（需要 appid + username 配置）
    if (type === GroupTaskType.PART_TIME_JOB) {
      await this.delay(1000);
      await this.sendPartTimeMiniProgramCard(group);
    }
  }

  /**
   * 发送纯文本消息到目标群（跟随消息，不触发小程序卡片和飞书预览）
   */
  async sendTextToGroup(group: GroupContext, text: string, dryRun: boolean): Promise<void> {
    if (dryRun) return;

    this.assertEnterpriseSendable(group);

    await this.messageSenderService.sendMessage({
      token: this.enterpriseToken,
      imBotId: group.imBotId,
      imRoomId: group.imRoomId,
      messageType: 7,
      payload: { text },
    });
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
    const modeTag = dryRun ? '预览' : '已发送';

    const card = this.cardBuilder.buildMarkdownCard({
      title: `📋 [${modeTag}] ${typeName} → ${group.groupName}`,
      content: [
        `**目标群**: ${group.groupName}`,
        `**标签**: ${group.tag} / ${group.city}${group.industry ? ` / ${group.industry}` : ''}`,
        '---',
        message,
      ].join('\n'),
      color: 'blue',
    });
    await this.webhookService.sendMessage('MESSAGE_NOTIFICATION', card);
    this.logger.log(`[试运行] 已发送飞书预览: ${group.groupName}`);
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
      await this.messageSenderService.sendMessage({
        token: this.enterpriseToken,
        imBotId: group.imBotId,
        imRoomId: group.imRoomId,
        messageType: 9, // MINI_PROGRAM
        payload,
      });
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

    const appendSection = (header: string, sectionLines: string[]): void => {
      if (sectionLines.length === 0) return;
      lines.push('', header, ...sectionLines);
    };

    // 成功分组
    const successDetails = result.details.filter((d) => d.status === 'success');
    appendSection(
      '**✅ 成功分组**',
      successDetails.map((d) => `✅ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`),
    );

    // 跳过分组
    const skippedDetails = result.details.filter((d) => d.status === 'skipped');
    appendSection(
      '**⏭️ 已跳过**',
      skippedDetails.map((d) => `⏭️ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`),
    );

    // 部分失败分组
    const partialDetails = result.details.filter((d) => d.status === 'partial');
    appendSection(
      '**⚠️ 部分失败**',
      partialDetails.map((d) => `⚠️ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`),
    );

    // 失败分组
    const failedDetails = result.details.filter((d) => d.status === 'failed');
    appendSection(
      '**❌ 失败分组**',
      failedDetails.map((d) => `❌ **${d.groupKey}** (${d.groupCount}群) — ${d.dataSummary}`),
    );

    appendSection(
      '**🚨 错误明细**',
      result.errors.map((item) => `- **${item.groupName}** — ${item.error}`),
    );

    const card = this.cardBuilder.buildMarkdownCard({
      title: `📢 ${modeLabel}${typeName}通知 — ${statusText}`,
      content: lines.join('\n'),
      color,
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });
    await this.webhookService.sendMessage('MESSAGE_NOTIFICATION', card);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
