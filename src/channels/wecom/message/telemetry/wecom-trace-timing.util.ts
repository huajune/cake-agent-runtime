/** 企微消息 Trace 的生命周期时间点（毫秒时间戳），每个字段在 Redis Hash 里独占一个 `timing:*` field。 */
export interface WecomTraceTimings {
  acceptedAt: number;
  historyStoredAt?: number;
  imagePreparedAt?: number;
  queueAddAt?: number;
  workerStartAt?: number;
  aiStartAt?: number;
  aiEndAt?: number;
  deliveryStartAt?: number;
  firstSegmentSentAt?: number;
  deliveryEndAt?: number;
  fallbackStartAt?: number;
  fallbackEndAt?: number;
  /** 非 reply 终态时间戳（skip_reply 主动沉默/守卫拦截/handoff/工具短路 → 跳过投递） */
  replySkippedAt?: number;
  completedAt?: number;
}

export interface WecomTimingSummary {
  timestamps: WecomTraceTimings & { completedAt: number };
  durations: Record<string, number | undefined>;
}

function diff(to?: number, from?: number): number | undefined {
  if (to === undefined || from === undefined) return undefined;
  return Math.max(to - from, 0);
}

/** 静默窗口真实等待：从 accepted 到「窗口到期」与「worker 实际起跑」中更早的那一刻。 */
function computeQuietWindowWaitMs(
  quietWindowEligibleAt?: number,
  acceptedAt?: number,
  workerStartAt?: number,
): number | undefined {
  if (
    quietWindowEligibleAt === undefined ||
    acceptedAt === undefined ||
    workerStartAt === undefined
  ) {
    return undefined;
  }
  return Math.max(Math.min(quietWindowEligibleAt, workerStartAt) - acceptedAt, 0);
}

/**
 * 把时间点折算成流水里的派生时长（纯函数）。
 *
 * queueMs / queueWaitMs 都要扣掉静默窗口：候选人连发消息时 worker 故意等窗口到期，这段
 * 不是排队积压，否则 Dashboard 的排队耗时会把 debounce 当成拥塞。
 */
export function buildWecomTimingSummary(
  timings: WecomTraceTimings,
  quietWindowEligibleAt: number | undefined,
  completedAt: number,
): WecomTimingSummary {
  const timestamps = { ...timings, completedAt };
  const acceptedToFirstSegmentSentMs = diff(timestamps.firstSegmentSentAt, timestamps.acceptedAt);
  const acceptedToWorkerStartMs = diff(timestamps.workerStartAt, timestamps.acceptedAt);
  const quietWindowWaitMs = computeQuietWindowWaitMs(
    quietWindowEligibleAt,
    timestamps.acceptedAt,
    timestamps.workerStartAt,
  );
  const acceptedToQueueAddMs = diff(timestamps.queueAddAt, timestamps.acceptedAt);
  const queueAddToWorkerStartMs = diff(timestamps.workerStartAt, timestamps.queueAddAt);
  const queueMs =
    queueAddToWorkerStartMs !== undefined && quietWindowWaitMs !== undefined
      ? Math.max(
          queueAddToWorkerStartMs - Math.max(quietWindowWaitMs - (acceptedToQueueAddMs ?? 0), 0),
          0,
        )
      : queueAddToWorkerStartMs;
  const queueWaitMs =
    acceptedToWorkerStartMs !== undefined
      ? Math.max(acceptedToWorkerStartMs - (quietWindowWaitMs ?? 0), 0)
      : undefined;

  return {
    timestamps,
    durations: {
      acceptedToHistoryStoredMs: diff(timestamps.historyStoredAt, timestamps.acceptedAt),
      acceptedToImagePreparedMs: diff(timestamps.imagePreparedAt, timestamps.acceptedAt),
      acceptedToQueueAddMs,
      queueAddToWorkerStartMs,
      acceptedToWorkerStartMs,
      quietWindowWaitMs,
      prepMs: acceptedToQueueAddMs,
      queueMs,
      queueWaitMs,
      acceptedToAiStartMs: diff(timestamps.aiStartAt, timestamps.acceptedAt),
      acceptedToAiEndMs: diff(timestamps.aiEndAt, timestamps.acceptedAt),
      acceptedToFirstSegmentSentMs,
      acceptedToDeliveryStartMs: diff(timestamps.deliveryStartAt, timestamps.acceptedAt),
      acceptedToDeliveryEndMs: diff(timestamps.deliveryEndAt, timestamps.acceptedAt),
      workerStartToAiStartMs: diff(timestamps.aiStartAt, timestamps.workerStartAt),
      aiStartToAiEndMs: diff(timestamps.aiEndAt, timestamps.aiStartAt),
      aiEndToDeliveryStartMs: diff(timestamps.deliveryStartAt, timestamps.aiEndAt),
      requestToFirstTextDeltaMs: acceptedToFirstSegmentSentMs,
      deliveryDurationMs: diff(timestamps.deliveryEndAt, timestamps.deliveryStartAt),
      fallbackDurationMs: diff(timestamps.fallbackEndAt, timestamps.fallbackStartAt),
      totalMs: diff(completedAt, timestamps.acceptedAt) ?? 0,
    },
  };
}
