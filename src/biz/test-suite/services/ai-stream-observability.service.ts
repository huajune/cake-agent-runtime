import { Inject, Injectable } from '@nestjs/common';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { OBSERVER, Observer } from '@observability/observer.interface';
import { AiStreamTrace, AiStreamTraceOptions } from './ai-stream-trace';

@Injectable()
export class AiStreamObservabilityService {
  constructor(
    private readonly messageTrackingService: MessageTrackingService,
    @Inject(OBSERVER) private readonly observer: Observer,
  ) {}

  startTrace(options: AiStreamTraceOptions): AiStreamTrace {
    return new AiStreamTrace(this.messageTrackingService, this.observer, options);
  }
}

export { AiStreamTrace };
export type { AiStreamTraceOptions } from './ai-stream-trace';
