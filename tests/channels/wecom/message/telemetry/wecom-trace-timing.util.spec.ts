import {
  buildWecomTimingSummary,
  type WecomTraceTimings,
} from '@channels/wecom/message/telemetry/wecom-trace-timing.util';

/**
 * 时长折算是消息处理流水（message_processing_records）各耗时列的唯一来源，
 * Dashboard 的排队/装配/投递分析都读它。这里锁死三件事：
 * 静默窗口不得被计成排队积压、缺时间点必须留空而不是 0、时钟回拨不得产生负数。
 */
describe('buildWecomTimingSummary', () => {
  const T0 = 1_700_000_000_000;

  /** 一条顺利回合的完整时间线（相对 T0 的偏移，ms）。 */
  const fullTimeline: WecomTraceTimings = {
    acceptedAt: T0,
    historyStoredAt: T0 + 100,
    imagePreparedAt: T0 + 200,
    queueAddAt: T0 + 300,
    workerStartAt: T0 + 5_300,
    aiStartAt: T0 + 5_400,
    aiEndAt: T0 + 20_400,
    deliveryStartAt: T0 + 20_500,
    firstSegmentSentAt: T0 + 21_000,
    deliveryEndAt: T0 + 23_000,
  };

  it('derives every stage duration from the timestamps it was given', () => {
    const summary = buildWecomTimingSummary(fullTimeline, undefined, T0 + 23_100);

    expect(summary.durations).toMatchObject({
      acceptedToHistoryStoredMs: 100,
      acceptedToImagePreparedMs: 200,
      acceptedToQueueAddMs: 300,
      queueAddToWorkerStartMs: 5_000,
      acceptedToWorkerStartMs: 5_300,
      acceptedToAiStartMs: 5_400,
      acceptedToAiEndMs: 20_400,
      acceptedToFirstSegmentSentMs: 21_000,
      acceptedToDeliveryStartMs: 20_500,
      acceptedToDeliveryEndMs: 23_000,
      workerStartToAiStartMs: 100,
      aiStartToAiEndMs: 15_000,
      aiEndToDeliveryStartMs: 100,
      deliveryDurationMs: 2_500,
      totalMs: 23_100,
    });
    // requestToFirstTextDeltaMs 是首段送达的别名列，必须与 acceptedToFirstSegmentSentMs 同值。
    expect(summary.durations.requestToFirstTextDeltaMs).toBe(
      summary.durations.acceptedToFirstSegmentSentMs,
    );
    expect(summary.timestamps).toEqual({ ...fullTimeline, completedAt: T0 + 23_100 });
  });

  it('leaves quiet-window and queue-net durations empty when the window is unknown', () => {
    const summary = buildWecomTimingSummary(fullTimeline, undefined, T0 + 23_100);

    expect(summary.durations.quietWindowWaitMs).toBeUndefined();
    // 无窗口信息就无从扣减：两个净排队列退化成未扣减的原始等待，而不是留空。
    expect(summary.durations.queueWaitMs).toBe(5_300);
    expect(summary.durations.queueMs).toBe(5_000);
  });

  describe('quiet window deduction', () => {
    it('excludes the debounce wait from queue durations instead of counting it as backlog', () => {
      // 静默窗口到 T0+5_000 到期，worker T0+5_300 起跑：窗口占 5s，真实排队只有 300ms。
      const summary = buildWecomTimingSummary(fullTimeline, T0 + 5_000, T0 + 23_100);

      expect(summary.durations.quietWindowWaitMs).toBe(5_000);
      expect(summary.durations.queueWaitMs).toBe(300);
      // 入队前已经过去 300ms 窗口，故只从 queueAdd→workerStart 里扣剩下的 4_700ms。
      expect(summary.durations.queueMs).toBe(300);
    });

    it('caps the wait at worker start when the window outlives it', () => {
      // 窗口名义上到 T0+9_000 才到期，但 worker T0+5_300 就起跑了（末条消息后静默已足够）。
      const summary = buildWecomTimingSummary(fullTimeline, T0 + 9_000, T0 + 23_100);

      expect(summary.durations.quietWindowWaitMs).toBe(5_300);
      expect(summary.durations.queueWaitMs).toBe(0);
      expect(summary.durations.queueMs).toBe(0);
    });

    it('never reports a negative wait when the window expired before the message arrived', () => {
      const summary = buildWecomTimingSummary(fullTimeline, T0 - 4_000, T0 + 23_100);

      expect(summary.durations.quietWindowWaitMs).toBe(0);
      expect(summary.durations.queueWaitMs).toBe(5_300);
      expect(summary.durations.queueMs).toBe(5_000);
    });

    it('keeps queue durations empty when worker start is missing', () => {
      const { workerStartAt: _dropped, ...withoutWorkerStart } = fullTimeline;
      const summary = buildWecomTimingSummary(withoutWorkerStart, T0 + 5_000, T0 + 23_100);

      expect(summary.durations.quietWindowWaitMs).toBeUndefined();
      expect(summary.durations.acceptedToWorkerStartMs).toBeUndefined();
      expect(summary.durations.queueWaitMs).toBeUndefined();
      expect(summary.durations.queueMs).toBeUndefined();
    });
  });

  it('reports missing stages as undefined rather than zero', () => {
    // 守卫拦截/主动沉默的回合没有投递段：这些列必须留空，否则会被统计成「0ms 投递完成」。
    const summary = buildWecomTimingSummary(
      { acceptedAt: T0, workerStartAt: T0 + 1_000, replySkippedAt: T0 + 2_000 },
      undefined,
      T0 + 2_000,
    );

    expect(summary.durations.deliveryDurationMs).toBeUndefined();
    expect(summary.durations.acceptedToFirstSegmentSentMs).toBeUndefined();
    expect(summary.durations.aiStartToAiEndMs).toBeUndefined();
    expect(summary.durations.fallbackDurationMs).toBeUndefined();
    expect(summary.durations.totalMs).toBe(2_000);
  });

  it('clamps to zero instead of emitting negative durations when timestamps go backwards', () => {
    // 时间戳来自不同进程，时钟回拨会让后一步早于前一步；负耗时会污染 Dashboard 的均值。
    const summary = buildWecomTimingSummary(
      { acceptedAt: T0 + 5_000, workerStartAt: T0, aiStartAt: T0 + 1_000, aiEndAt: T0 + 500 },
      undefined,
      T0,
    );

    expect(summary.durations.acceptedToWorkerStartMs).toBe(0);
    expect(summary.durations.aiStartToAiEndMs).toBe(0);
    expect(summary.durations.totalMs).toBe(0);
  });

  it('measures the fallback delivery window on its own', () => {
    const summary = buildWecomTimingSummary(
      { acceptedAt: T0, fallbackStartAt: T0 + 30_000, fallbackEndAt: T0 + 31_500 },
      undefined,
      T0 + 31_600,
    );

    expect(summary.durations.fallbackDurationMs).toBe(1_500);
  });
});
