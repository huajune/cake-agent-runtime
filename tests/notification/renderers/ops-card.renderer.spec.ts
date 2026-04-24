import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { OpsCardRenderer } from '@notification/renderers/ops-card.renderer';

describe('OpsCardRenderer', () => {
  let renderer: OpsCardRenderer;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

  beforeEach(() => {
    cardBuilder = {
      buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
    } as unknown as jest.Mocked<FeishuCardBuilderService>;

    renderer = new OpsCardRenderer(cardBuilder);
  });

  it('should render group task preview cards', () => {
    const card = renderer.buildGroupTaskPreviewCard({
      groupName: '上海兼职1群',
      tag: '兼职',
      city: '上海',
      industry: '零售',
      typeName: '抢单通知',
      message: '今晚 7 点上新',
      dryRun: true,
    });

    expect(card).toEqual(
      expect.objectContaining({
        title: '📋 [预览] 抢单通知 → 上海兼职1群',
        color: 'blue',
      }),
    );
    expect((card.content as string)).toContain('**目标群**: 上海兼职1群');
    expect((card.content as string)).toContain('**标签**: 兼职 / 上海 / 零售');
    expect((card.content as string)).toContain('今晚 7 点上新');
  });

  it('should render detailed partial-failure reports', () => {
    const card = renderer.buildGroupTaskReportCard({
      typeName: '兼职',
      dryRun: false,
      totalGroups: 5,
      successCount: 2,
      failedCount: 1,
      skippedCount: 1,
      durationSeconds: 12.34,
      details: [
        { groupKey: '上海A', groupCount: 2, dataSummary: '2 条发送成功', status: 'success' },
        { groupKey: '上海B', groupCount: 1, dataSummary: '配置关闭', status: 'skipped' },
        { groupKey: '上海C', groupCount: 1, dataSummary: '1 条成功 1 条失败', status: 'partial' },
        { groupKey: '上海D', groupCount: 1, dataSummary: '全部发送失败', status: 'failed' },
      ],
      errors: [{ groupName: '上海D-1群', error: 'Webhook timeout' }],
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });

    expect(card).toEqual(
      expect.objectContaining({
        title: '⚠️ 兼职通知 — 部分失败',
        color: 'yellow',
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect((card.content as string)).toContain('**总群数**: 5 | **分组**: 4');
    expect((card.content as string)).toContain('**✅ 成功分组**');
    expect((card.content as string)).toContain('**⏭️ 已跳过**');
    expect((card.content as string)).toContain('**⚠️ 部分失败**');
    expect((card.content as string)).toContain('**❌ 失败分组**');
    expect((card.content as string)).toContain('**🚨 错误明细**');
    expect((card.content as string)).toContain('Webhook timeout');
  });

  it('should render group full alert cards with numbered group list', () => {
    const card = renderer.buildGroupFullAlertCard({
      city: '上海',
      industry: '零售',
      memberLimit: 200,
      groups: [
        { name: '上海零售1群', memberCount: 200 },
        { name: '上海零售2群' },
      ],
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });

    expect(card).toEqual(
      expect.objectContaining({
        title: '⚠️ 上海/零售 所有兼职群已满，需要创建新群',
        color: 'yellow',
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect((card.content as string)).toContain('**范围**: 上海 / 零售');
    expect((card.content as string)).toContain('**容量阈值**: 200 人');
    expect((card.content as string)).toContain('1. 上海零售1群 (200 / 200)');
    expect((card.content as string)).toContain('2. 上海零售2群 (未知 / 200)');
  });
});
