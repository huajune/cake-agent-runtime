import { SpongeStatusPollService } from '@biz/ops-events/crons/sponge-status-poll.cron';

describe('SpongeStatusPollService.runOnce', () => {
  const opsEventsRepository = { findWorkOrdersPendingPass: jest.fn() };
  const opsEventsRecorder = { recordEvent: jest.fn() };
  const spongeService = { getCachedWorkOrderById: jest.fn() };

  const service = new SpongeStatusPollService(
    opsEventsRepository as never,
    opsEventsRecorder as never,
    spongeService as never,
  );

  const pendingWo = {
    workOrderId: 9001,
    corpId: 'corp-1',
    userId: 'user-1',
    chatId: 'chat-1',
    botImId: 'bot-im-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    opsEventsRecorder.recordEvent.mockResolvedValue(true);
  });

  it('emits interview.passed when interview is passed (no longer tracks hired)', async () => {
    opsEventsRepository.findWorkOrdersPendingPass.mockResolvedValue([pendingWo]);
    spongeService.getCachedWorkOrderById.mockResolvedValue({
      workOrderId: 9001,
      interviewPassTime: '2026-05-20 10:00:00',
      currentStatus: '上岗成功',
    });

    const result = await service.runOnce();

    expect(result).toEqual({ scanned: 1, passed: 1 });
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledTimes(1);
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'interview.passed', idempotencyKey: '9001:pass' }),
    );
    // 收口到面试通过：即便已上岗成功，也不再记 candidate.hired
    expect(opsEventsRecorder.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'candidate.hired' }),
    );
  });

  it('emits nothing when interview not yet passed', async () => {
    opsEventsRepository.findWorkOrdersPendingPass.mockResolvedValue([pendingWo]);
    spongeService.getCachedWorkOrderById.mockResolvedValue({
      workOrderId: 9001,
      interviewPassTime: null,
      currentStatus: '约面成功',
    });

    const result = await service.runOnce();

    expect(result).toEqual({ scanned: 1, passed: 0 });
    expect(opsEventsRecorder.recordEvent).not.toHaveBeenCalled();
  });

  it('skips work orders whose sponge lookup fails (graceful)', async () => {
    opsEventsRepository.findWorkOrdersPendingPass.mockResolvedValue([pendingWo]);
    spongeService.getCachedWorkOrderById.mockRejectedValue(new Error('sponge down'));

    const result = await service.runOnce();

    expect(result).toEqual({ scanned: 1, passed: 0 });
    expect(opsEventsRecorder.recordEvent).not.toHaveBeenCalled();
  });
});
