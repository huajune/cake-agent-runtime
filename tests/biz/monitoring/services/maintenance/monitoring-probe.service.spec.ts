import { MonitoringProbeService } from '@biz/monitoring/services/maintenance/monitoring-probe.service';

describe('MonitoringProbeService', () => {
  const messageTrackingService = {
    recordReplySkipped: jest.fn(),
  };
  const cacheService = {
    getCounters: jest.fn(),
  };
  const service = new MonitoringProbeService(messageTrackingService as any, cacheService as any);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(12345);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records an output_leak probe and returns counters', async () => {
    cacheService.getCounters.mockResolvedValue({ totalOutputLeakSkipped: 2 });

    await expect(
      service.recordReplySkippedProbe({ messageId: ' msg-1 ', reason: 'hosting_paused' as any }),
    ).resolves.toEqual({ totalOutputLeakSkipped: 2 });
    expect(messageTrackingService.recordReplySkipped).toHaveBeenCalledWith('msg-1', 'output_leak');
  });

  it('generates a deterministic fallback message id when omitted', async () => {
    cacheService.getCounters.mockResolvedValue({});

    await service.recordReplySkippedProbe();

    expect(messageTrackingService.recordReplySkipped).toHaveBeenCalledWith(
      'monitoring-probe-12345',
      'output_leak',
    );
  });
});
