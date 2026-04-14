import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { OpsCardRenderer } from '@notification/renderers/ops-card.renderer';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';

describe('OpsNotifierService', () => {
  const mockOpsChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
    sendOrThrow: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };

  const mockRenderer = {
    buildGroupTaskPreviewCard: jest.fn(),
    buildGroupTaskReportCard: jest.fn(),
    buildGroupFullAlertCard: jest.fn(),
  } as unknown as jest.Mocked<OpsCardRenderer>;

  let service: OpsNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpsChannel.send.mockResolvedValue(true);
    mockOpsChannel.sendOrThrow.mockResolvedValue(undefined);
    mockRenderer.buildGroupTaskPreviewCard.mockReturnValue({ kind: 'preview-card' });
    mockRenderer.buildGroupTaskReportCard.mockReturnValue({ kind: 'report-card' });
    mockRenderer.buildGroupFullAlertCard.mockReturnValue({ kind: 'group-full-card' });
    service = new OpsNotifierService(mockOpsChannel as never, mockRenderer);
  });

  it('should use sendOrThrow for dry-run group task previews', async () => {
    const result = await service.sendGroupTaskPreview({
      groupName: '成都A群',
      tag: '店长群',
      city: '成都',
      typeName: '店长通知',
      message: '今日44人面试',
      dryRun: true,
    });

    expect(result).toBe(true);
    expect(mockRenderer.buildGroupTaskPreviewCard).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(mockOpsChannel.sendOrThrow).toHaveBeenCalledWith({ kind: 'preview-card' });
    expect(mockOpsChannel.send).not.toHaveBeenCalled();
  });

  it('should return channel result for formal previews', async () => {
    mockOpsChannel.send.mockResolvedValueOnce(false);

    const result = await service.sendGroupTaskPreview({
      groupName: '成都A群',
      tag: '店长群',
      city: '成都',
      typeName: '店长通知',
      message: '今日44人面试',
      dryRun: false,
    });

    expect(result).toBe(false);
    expect(mockOpsChannel.send).toHaveBeenCalledWith({ kind: 'preview-card' });
  });

  it('should always use sendOrThrow for group task reports', async () => {
    await service.sendGroupTaskReport({
      typeName: '店长通知',
      dryRun: false,
      totalGroups: 3,
      successCount: 2,
      failedCount: 1,
      skippedCount: 0,
      durationSeconds: 12.3,
      details: [],
      errors: [{ groupName: '成都A群', error: 'webhook failed' }],
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });

    expect(mockRenderer.buildGroupTaskReportCard).toHaveBeenCalled();
    expect(mockOpsChannel.sendOrThrow).toHaveBeenCalledWith({ kind: 'report-card' });
  });

  it('should attach default group-full receivers before sending alert', async () => {
    await service.sendGroupFullAlert({
      city: '成都',
      industry: '兼职',
      memberLimit: 500,
      groups: [{ name: '成都兼职1群', memberCount: 500 }],
    });

    expect(mockRenderer.buildGroupFullAlertCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      }),
    );
    expect(mockOpsChannel.send).toHaveBeenCalledWith({ kind: 'group-full-card' });
  });
});
