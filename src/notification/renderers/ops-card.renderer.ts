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

  buildReplyFactContradictionAlertCard(params: {
    chatId?: string;
    userId?: string;
    traceId?: string;
    contactName?: string;
    botImId?: string;
    botUserName?: string;
    replyPreview: string;
    contradictions: Array<{ ruleId: string; label: string }>;
    toolNames: string[];
    atUsers?: FeishuReceiver[];
  }): Record<string, unknown> {
    const botLabel = params.botUserName
      ? `${params.botUserName} (${params.botImId ?? '-'})`
      : (params.botImId ?? '未知');

    const ruleLines = params.contradictions.map(
      (c, i) => `${i + 1}. ${c.label}（ruleId: ${c.ruleId}）`,
    );

    const content = [
      `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '**级别**: WARNING（仅观察，未改写回复）',
      `**候选人**: ${params.contactName ?? '-'}`,
      `**接客 bot**: ${botLabel}`,
      `**chatId**: ${params.chatId ?? '-'}`,
      `**userId**: ${params.userId ?? '-'}`,
      `**traceId**: ${params.traceId ?? '-'}`,
      `**本轮 tool**: ${params.toolNames.length > 0 ? params.toolNames.join(', ') : '（无）'}`,
      '',
      '**命中规则**',
      ...ruleLines,
      '',
      '**回复预览（前 400 字）**',
      `> ${params.replyPreview.replace(/\n/g, ' ')}`,
      '',
      '排查建议：若准确率高，可升级到 phase 2（命中即静默丢弃回复）；若误报多，调整规则关键词或加 exception。',
    ].join('\n');

    return this.cardBuilder.buildMarkdownCard({
      title: '⚠️ Agent 回复事实矛盾（与本轮 tool 结果不一致）',
      content,
      color: 'yellow',
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
      const reason = classifyInviteRejection(group.error);
      return [
        `${index + 1}. **${group.name}** [${reason.label}]`,
        `   - imRoomId: ${group.imRoomId}`,
        `   - 群主 bot: ${ownerLabel}`,
        `   - 错误: ${group.error ?? '-'}`,
      ].join('\n');
    });

    // 按 error 归类被拒原因，给出对应结论 / 修复动作；不再一律按 "bot 不在群中" 处理。
    const diagnosis = summarizeInviteRejections(params.rejectedGroups.map((group) => group.error));

    const content = [
      `**时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '**级别**: WARNING',
      `**范围**: ${scope}`,
      `**接客 bot**: ${chatBotLabel}`,
      `**结论**: ${diagnosis.conclusion}`,
      `**修复动作**: ${diagnosis.fixAction}`,
      `**被拒群数**: ${params.rejectedGroups.length}`,
      '',
      '**被拒群明细**',
      ...rejectedLines,
    ].join('\n');

    return this.cardBuilder.buildMarkdownCard({
      title: `🚨 接客 bot 拉群被拒 — ${scope}`,
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

/** 拉群被拒的失败类型；不同类型对应完全不同的运维修复动作。 */
type InviteRejectionKind = 'not_friend' | 'room_not_found' | 'unknown';

interface InviteRejectionReason {
  kind: InviteRejectionKind;
  label: string;
}

/**
 * 把企业级拉群接口返回的 error 文本归类。
 * - errcode=-8 "is not a friend"：接客 bot 与候选人不是外部联系人（好友关系问题），把 bot 拉进群无济于事。
 * - errcode=400400 "room not found"：接客 bot 不是群成员（群成员问题）。
 */
function classifyInviteRejection(error?: string): InviteRejectionReason {
  const text = error ?? '';
  if (/errcode=-8\b/.test(text) || /is not a friend/i.test(text)) {
    return { kind: 'not_friend', label: '好友关系' };
  }
  if (/\b400400\b/.test(text) || /room not found/i.test(text)) {
    return { kind: 'room_not_found', label: 'bot 不在群' };
  }
  return { kind: 'unknown', label: '未知' };
}

/**
 * 汇总全部被拒群的失败类型，给出主导结论与修复动作。
 *
 * 优先级：可处理的失败（bot 不在群 > 未知）领衔，好友关系(-8) 殿后。
 * 因为纯 -8（候选人拉黑/删好友）已在 invite_to_group 里短路成静默收口、根本不会发本告警；
 * -8 出现在告警里时必然混着别的可处理失败，运维应优先看可处理项。
 */
function summarizeInviteRejections(errors: Array<string | undefined>): {
  conclusion: string;
  fixAction: string;
} {
  const counts: Record<InviteRejectionKind, number> = {
    not_friend: 0,
    room_not_found: 0,
    unknown: 0,
  };
  for (const error of errors) {
    counts[classifyInviteRejection(error).kind] += 1;
  }

  const mixed =
    [counts.not_friend, counts.room_not_found, counts.unknown].filter((count) => count > 0).length >
    1;
  const mixedHint = mixed ? '（注意：本次被拒群存在多种失败原因，详见下方明细的 [类型] 标记）' : '';

  if (counts.room_not_found > 0) {
    return {
      conclusion: `接客 bot 不是候选群成员，企微返回 errcode=400400 "room not found"${mixedHint}`,
      fixAction: '在企微后台把"接客 bot"拉进下方列出的群，或与群主确认 bot 关系',
    };
  }
  if (counts.unknown > 0) {
    return {
      conclusion: `接客 bot 在该城市/行业的候选群被拒（非 -8 好友关系问题）${mixedHint}`,
      fixAction: '请查看下方每个群的原始错误信息，确认具体被拒原因',
    };
  }
  return {
    conclusion: `候选人不是接客 bot 的外部联系人，企微返回 errcode=-8 "is not a friend"，无法把候选人拉进群${mixedHint}`,
    fixAction:
      '这是好友关系问题，把 bot 拉进群无效。候选人很可能已删除接客 bot、或外部联系人关系从未真正建立；需人工跟进，重新加候选人为好友后再拉群',
  };
}
