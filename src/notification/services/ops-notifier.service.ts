import { Injectable, Logger } from '@nestjs/common';
import { FEISHU_RECEIVER_USERS, FeishuReceiver } from '@infra/feishu/constants/receivers';
import { FeishuOpsChannel } from '../channels/feishu-ops.channel';
import {
  GroupTaskExecutionDetail,
  GroupTaskExecutionError,
  OpsCardRenderer,
} from '../renderers/ops-card.renderer';

@Injectable()
export class OpsNotifierService {
  private readonly logger = new Logger(OpsNotifierService.name);

  constructor(
    private readonly opsChannel: FeishuOpsChannel,
    private readonly opsCardRenderer: OpsCardRenderer,
  ) {}

  async sendGroupTaskPreview(params: {
    groupName: string;
    tag: string;
    city: string;
    industry?: string;
    typeName: string;
    message: string;
    dryRun: boolean;
  }): Promise<boolean> {
    const card = this.opsCardRenderer.buildGroupTaskPreviewCard(params);

    if (params.dryRun) {
      await this.opsChannel.sendOrThrow(card);
      return true;
    }

    const sent = await this.opsChannel.send(card);
    if (!sent) {
      this.logger.error(
        `[运营通知] 飞书消息通知群发送失败: ${params.typeName} -> ${params.groupName}`,
      );
    }
    return sent;
  }

  async sendGroupTaskReport(params: {
    typeName: string;
    dryRun: boolean;
    totalGroups: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    durationSeconds: number;
    details: GroupTaskExecutionDetail[];
    errors: GroupTaskExecutionError[];
    atUsers?: FeishuReceiver[];
  }): Promise<void> {
    const card = this.opsCardRenderer.buildGroupTaskReportCard(params);
    await this.opsChannel.sendOrThrow(card);
  }

  async sendGroupFullAlert(params: {
    city: string;
    industry?: string;
    memberLimit: number;
    groups: Array<{ name: string; memberCount?: number }>;
  }): Promise<boolean> {
    const card = this.opsCardRenderer.buildGroupFullAlertCard({
      ...params,
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });
    return this.opsChannel.send(card);
  }
}
