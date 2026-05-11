import { Injectable } from '@nestjs/common';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';

export interface GroupTaskExecutionDetail {
  groupKey: string;
  groupCount: number;
  dataSummary: string;
  status: 'success' | 'skipped' | 'partial' | 'failed';
}

export interface GroupTaskExecutionError {
  groupName: string;
  error: string;
}

export interface GroupTaskReportCardParams {
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
}

@Injectable()
export class OpsCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildGroupTaskPreviewCard(params: {
    groupName: string;
    tag: string;
    city: string;
    industry?: string;
    typeName: string;
    message: string;
    dryRun: boolean;
  }): Record<string, unknown> {
    const modeTag = params.dryRun ? '预览' : '已发送';

    return this.cardBuilder.buildMarkdownCard({
      title: `📋 [${modeTag}] ${params.typeName} → ${params.groupName}`,
      content: [
        `**目标群**: ${params.groupName}`,
        `**标签**: ${params.tag} / ${params.city}${params.industry ? ` / ${params.industry}` : ''}`,
        '---',
        params.message,
      ].join('\n'),
      color: 'blue',
    });
  }

  buildGroupTaskReportCard(params: GroupTaskReportCardParams): Record<string, unknown> {
    const modeLabel = params.dryRun ? '[试运行] ' : '';
    const isSuccess = params.failedCount === 0;
    const isPartialFail = params.successCount > 0 && params.failedCount > 0;

    let statusText: string;
    let color: 'green' | 'yellow' | 'red';
    let titleEmoji: string;
    if (isSuccess) {
      statusText = '全部成功';
      color = 'green';
      titleEmoji = '📢';
    } else if (isPartialFail) {
      statusText = '部分失败';
      color = 'yellow';
      titleEmoji = '⚠️';
    } else {
      statusText = '全部失败';
      color = 'red';
      titleEmoji = '🚨';
    }

    const lines: string[] = [
      `**总群数**: ${params.totalGroups} | **分组**: ${params.details.length}`,
      `**成功**: ${params.successCount} | **失败**: ${params.failedCount} | **跳过**: ${params.skippedCount} | **耗时**: ${params.durationSeconds.toFixed(1)}s`,
      '---',
    ];

    const appendSection = (header: string, sectionLines: string[]): void => {
      if (sectionLines.length === 0) return;
      lines.push('', header, ...sectionLines);
    };

    appendSection(
      '**✅ 成功分组**',
      params.details
        .filter((detail) => detail.status === 'success')
        .map(
          (detail) => `✅ **${detail.groupKey}** (${detail.groupCount}群) — ${detail.dataSummary}`,
        ),
    );

    appendSection(
      '**⏭️ 已跳过**',
      params.details
        .filter((detail) => detail.status === 'skipped')
        .map(
          (detail) => `⏭️ **${detail.groupKey}** (${detail.groupCount}群) — ${detail.dataSummary}`,
        ),
    );

    appendSection(
      '**⚠️ 部分失败**',
      params.details
        .filter((detail) => detail.status === 'partial')
        .map(
          (detail) => `⚠️ **${detail.groupKey}** (${detail.groupCount}群) — ${detail.dataSummary}`,
        ),
    );

    appendSection(
      '**❌ 失败分组**',
      params.details
        .filter((detail) => detail.status === 'failed')
        .map(
          (detail) => `❌ **${detail.groupKey}** (${detail.groupCount}群) — ${detail.dataSummary}`,
        ),
    );

    appendSection(
      '**🚨 错误明细**',
      params.errors.map((item) => `- **${item.groupName}** — ${item.error}`),
    );

    return this.cardBuilder.buildMarkdownCard({
      title: `${titleEmoji} ${modeLabel}${params.typeName}通知 — ${statusText}`,
      content: lines.join('\n'),
      color,
      atUsers: params.atUsers,
    });
  }

  buildInviteRejectedAlertCard(params: {
    city: string;
    industry?: string;
    chatBotImId?: string;
    chatBotUserId?: string;
    rejectedGroups: Array<{
      name: string;
      imRoomId: string;
      ownerBotImId?: string;
      ownerBotUserId?: string;
      error?: string;
    }>;
    atUsers?: FeishuReceiver[];
  }): Record<string, unknown> {
    const scope = `${params.city}${params.industry ? ` / ${params.industry}` : ''}`;
    const chatBotLabel = params.chatBotUserId
      ? `${params.chatBotUserId} (${params.chatBotImId ?? '-'})`
      : (params.chatBotImId ?? '未知');

    const rejectedLines = params.rejectedGroups.map((group, index) => {
      const ownerLabel = group.ownerBotUserId
        ? `${group.ownerBotUserId} (${group.ownerBotImId ?? '-'})`
        : (group.ownerBotImId ?? '未知群主');
      return [
        `${index + 1}. **${group.name}**`,
        `   - imRoomId: ${group.imRoomId}`,
        `   - 群主 bot: ${ownerLabel}`,
        `   - 错误: ${group.error ?? '-'}`,
      ].join('\n');
    });

    const content = [
      `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '**级别**: WARNING',
      `**范围**: ${scope}`,
      `**接客 bot**: ${chatBotLabel}`,
      `**结论**: 接客 bot 在该城市/行业的全部候选群里都被拒绝（典型为 errcode=400400 "room not found"，即接客 bot 不是群成员）`,
      '**修复动作**: 在企微后台把"接客 bot"拉进下方列出的群，或与群主确认 bot 关系',
      `**被拒群数**: ${params.rejectedGroups.length}`,
      '',
      '**被拒群明细**',
      ...rejectedLines,
    ].join('\n');

    return this.cardBuilder.buildMarkdownCard({
      title: `⚠️ 接客 bot 拉群被拒 — ${scope}`,
      content,
      color: 'red',
      atUsers: params.atUsers,
    });
  }

  buildGroupFullAlertCard(params: {
    city: string;
    industry?: string;
    memberLimit: number;
    groups: Array<{ name: string; memberCount?: number }>;
    atUsers?: FeishuReceiver[];
  }): Record<string, unknown> {
    const scope = `${params.city}${params.industry ? ` / ${params.industry}` : ''}`;
    const conclusion = `${params.city}${params.industry ? `/${params.industry}` : ''} 所有兼职群已满，需要创建新群`;
    const numberedGroups = params.groups.map((group, index) => {
      const count = group.memberCount ?? '未知';
      return `${index + 1}. ${group.name} (${count} / ${params.memberLimit})`;
    });

    const content = [
      `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '**级别**: WARNING',
      `**范围**: ${scope}`,
      `**结论**: ${conclusion}`,
      `**容量阈值**: ${params.memberLimit} 人`,
      `**已满群数**: ${params.groups.length}`,
      '',
      '**已满群列表**',
      ...numberedGroups,
    ].join('\n');

    return this.cardBuilder.buildMarkdownCard({
      title: `⚠️ ${conclusion}`,
      content,
      color: 'yellow',
      atUsers: params.atUsers,
    });
  }
}
