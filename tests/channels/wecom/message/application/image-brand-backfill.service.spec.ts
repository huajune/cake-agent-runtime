import { MessageType } from '@enums/message-callback.enum';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import { ImageBrandBackfillService } from '@channels/wecom/message/application/image-brand-backfill.service';

describe('ImageBrandBackfillService', () => {
  const imageDescription = { describeForBackfill: jest.fn() };
  const brandResolution = { resolve: jest.fn() };
  const brandState = { applyLateImageResolutions: jest.fn() };
  const simpleMerge = {
    acquireProcessingLock: jest.fn(),
    releaseProcessingLock: jest.fn(),
  };
  const alertNotifier = { sendSimpleAlert: jest.fn() };
  const resolution: BrandResolution = {
    canonicalName: '肯德基',
    brandId: 1,
    confidence: 1,
    source: 'image_description',
    matchType: 'canonical_exact',
    matchedText: '肯德基',
    sourceText: '肯德基招聘海报',
    intentPolarity: 'positive',
    ambiguous: false,
  };
  const backfillParams = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
    chatId: 'chat-1',
    missing: [{ messageId: 'image-1', imageUrl: 'https://example.com/image.jpg' }],
    turnMs: 1234,
  };
  let service: ImageBrandBackfillService;

  beforeEach(() => {
    jest.clearAllMocks();
    imageDescription.describeForBackfill.mockResolvedValue('肯德基招聘截图');
    brandResolution.resolve.mockResolvedValue([resolution]);
    simpleMerge.acquireProcessingLock.mockResolvedValue(true);
    simpleMerge.releaseProcessingLock.mockResolvedValue(undefined);
    brandState.applyLateImageResolutions.mockResolvedValue('applied');
    alertNotifier.sendSimpleAlert.mockResolvedValue(true);
    service = new ImageBrandBackfillService(
      imageDescription as never,
      brandResolution as never,
      brandState as never,
      simpleMerge as never,
      alertNotifier as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('detects only undescribed image messages, excluding successful saves and emotions', () => {
    expect(
      service.detectMissingImages({
        imageMessageIds: ['image-1', 'emotion-1', 'image-2'],
        imageUrls: ['url-1', 'url-2', 'url-3'],
        visualMessageTypes: {
          'image-1': MessageType.IMAGE,
          'emotion-1': MessageType.EMOTION,
          'image-2': MessageType.IMAGE,
        },
        toolCalls: [
          {
            toolName: 'save_image_description',
            args: { messageId: 'image-1' },
            result: { success: true },
          },
          {
            toolName: 'save_image_description',
            args: { messageId: 'image-2' },
            result: { success: false },
          },
        ],
      }),
    ).toEqual([{ messageId: 'image-2', imageUrl: 'url-3' }]);
  });

  it('skips locking and state writes when no brand is resolved', async () => {
    brandResolution.resolve.mockResolvedValue([]);

    await runBackfill(service, backfillParams);

    expect(simpleMerge.acquireProcessingLock).not.toHaveBeenCalled();
    expect(brandState.applyLateImageResolutions).not.toHaveBeenCalled();
  });

  it('writes under the processing lock and always releases it', async () => {
    await runBackfill(service, backfillParams);

    expect(brandState.applyLateImageResolutions).toHaveBeenCalledWith({
      corpId: 'corp-1',
      userId: 'user-1',
      sessionId: 'session-1',
      resolutions: [resolution],
      resolutionTurnMs: 1234,
    });
    expect(simpleMerge.releaseProcessingLock).toHaveBeenCalledWith(
      'chat-1',
      expect.stringMatching(/^brand-backfill:/),
    );
  });

  it('alerts when a late image resolution is dropped as expired', async () => {
    brandState.applyLateImageResolutions.mockResolvedValue('dropped_expired');

    await runBackfill(service, backfillParams);

    expect(alertNotifier.sendSimpleAlert).toHaveBeenCalledWith(
      '图片品牌补写因过期被丢弃',
      expect.stringContaining('肯德基'),
      'info',
    );
    expect(simpleMerge.releaseProcessingLock).toHaveBeenCalledTimes(1);
  });

  it('retries lock acquisition five times, then alerts and gives up without writing', async () => {
    jest.useFakeTimers();
    simpleMerge.acquireProcessingLock.mockResolvedValue(false);

    const pending = runBackfill(service, backfillParams);
    await jest.runAllTimersAsync();
    await pending;

    expect(simpleMerge.acquireProcessingLock).toHaveBeenCalledTimes(5);
    expect(brandState.applyLateImageResolutions).not.toHaveBeenCalled();
    expect(simpleMerge.releaseProcessingLock).not.toHaveBeenCalled();
    expect(alertNotifier.sendSimpleAlert).toHaveBeenCalledWith(
      '图片品牌补写因锁竞争放弃',
      expect.stringContaining('连续 5 次'),
      'warning',
    );
  });
});

function runBackfill(
  service: ImageBrandBackfillService,
  params: {
    corpId: string;
    userId: string;
    sessionId: string;
    chatId: string;
    missing: Array<{ messageId: string; imageUrl: string }>;
    turnMs: number;
  },
): Promise<void> {
  return (
    service as unknown as {
      runBackfill(input: typeof params): Promise<void>;
    }
  ).runBackfill(params);
}
