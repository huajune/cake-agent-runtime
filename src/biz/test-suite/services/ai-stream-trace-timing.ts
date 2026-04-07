import type { AiStreamTimingPayload, AiStreamTraceMarks } from './ai-stream-trace';

export class AiStreamTraceTiming {
  readonly marks: AiStreamTraceMarks = {
    receivedAt: Date.now(),
  };

  markWorkerStart(): void {
    this.marks.workerStartAt = Date.now();
  }

  markAiStart(): boolean {
    if (this.marks.aiStartAt) return false;
    this.marks.aiStartAt = Date.now();
    return true;
  }

  markStreamReady(): void {
    this.marks.streamReadyAt = Date.now();
  }

  markResponsePipeStart(): boolean {
    if (this.marks.responsePipeStartAt) return false;
    this.marks.responsePipeStartAt = Date.now();
    return true;
  }

  markFirstChunk(): void {
    this.marks.firstChunkAt ??= Date.now();
  }

  markFirstReasoningStart(): void {
    this.marks.firstReasoningStartAt ??= Date.now();
  }

  markFirstReasoningDelta(): void {
    this.marks.firstReasoningDeltaAt ??= Date.now();
  }

  markFirstTextStart(): void {
    this.marks.firstTextStartAt ??= Date.now();
  }

  markFirstTextDelta(): void {
    this.marks.firstTextDeltaAt ??= Date.now();
  }

  markFinishChunk(): void {
    this.marks.finishChunkAt = Date.now();
  }

  markUsageResolved(): void {
    this.marks.usageResolvedAt = Date.now();
  }

  markCompleted(): number {
    const completedAt = Date.now();
    this.marks.completedAt = completedAt;
    return completedAt;
  }

  buildTimings(completedAt = this.marks.completedAt ?? Date.now()): AiStreamTimingPayload {
    return {
      timestamps: {
        ...this.marks,
        completedAt,
      },
      durations: {
        totalMs: completedAt - this.marks.receivedAt,
        requestToAiStartMs: this.diff(this.marks.aiStartAt, this.marks.receivedAt),
        requestToStreamReadyMs: this.diff(this.marks.streamReadyAt, this.marks.receivedAt),
        requestToResponsePipeStartMs: this.diff(
          this.marks.responsePipeStartAt,
          this.marks.receivedAt,
        ),
        requestToFirstChunkMs: this.diff(this.marks.firstChunkAt, this.marks.receivedAt),
        requestToFirstReasoningStartMs: this.diff(
          this.marks.firstReasoningStartAt,
          this.marks.receivedAt,
        ),
        requestToFirstReasoningDeltaMs: this.diff(
          this.marks.firstReasoningDeltaAt,
          this.marks.receivedAt,
        ),
        requestToFirstTextStartMs: this.diff(this.marks.firstTextStartAt, this.marks.receivedAt),
        requestToFirstTextDeltaMs: this.diff(this.marks.firstTextDeltaAt, this.marks.receivedAt),
        aiStartToStreamReadyMs: this.diff(this.marks.streamReadyAt, this.marks.aiStartAt),
        streamReadyToResponsePipeStartMs: this.diff(
          this.marks.responsePipeStartAt,
          this.marks.streamReadyAt,
        ),
        responsePipeStartToFirstChunkMs: this.diff(
          this.marks.firstChunkAt,
          this.marks.responsePipeStartAt,
        ),
        firstChunkToFinishMs: this.diff(completedAt, this.marks.firstChunkAt),
        responsePipeStartToFinishMs: this.diff(completedAt, this.marks.responsePipeStartAt),
        requestToUsageResolvedMs: this.diff(this.marks.usageResolvedAt, this.marks.receivedAt),
      },
    };
  }

  private diff(to?: number, from?: number): number | undefined {
    if (to === undefined || from === undefined) return undefined;
    return Math.max(to - from, 0);
  }
}
