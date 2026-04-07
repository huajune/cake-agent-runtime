import { AiStreamTraceTiming } from '@biz/test-suite/services/ai-stream-trace-timing';

describe('AiStreamTraceTiming', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should only record one ai start and one response pipe start', () => {
    const timing = new AiStreamTraceTiming();

    expect(timing.markAiStart()).toBe(true);
    expect(timing.markAiStart()).toBe(false);
    expect(timing.markResponsePipeStart()).toBe(true);
    expect(timing.markResponsePipeStart()).toBe(false);
  });

  it('should build non-negative timing payloads from recorded milestones', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:00:00.000Z'));
    const timing = new AiStreamTraceTiming();

    jest.advanceTimersByTime(100);
    timing.markWorkerStart();
    jest.advanceTimersByTime(50);
    timing.markAiStart();
    jest.advanceTimersByTime(20);
    timing.markStreamReady();
    jest.advanceTimersByTime(10);
    timing.markResponsePipeStart();
    jest.advanceTimersByTime(5);
    timing.markFirstChunk();
    timing.markFinishChunk();
    timing.markUsageResolved();
    const completedAt = timing.markCompleted();

    const payload = timing.buildTimings(completedAt);

    expect(payload.durations.totalMs).toBeGreaterThanOrEqual(0);
    expect(payload.durations.requestToAiStartMs).toBe(150);
    expect(payload.durations.requestToFirstChunkMs).toBe(185);
    expect(payload.durations.firstChunkToFinishMs).toBeGreaterThanOrEqual(0);
  });
});
