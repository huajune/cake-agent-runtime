import { Injectable, Logger } from '@nestjs/common';
import { DeliverySkipReason } from '@shared-types/tracking.types';
import { MessageTrackingService } from '../tracking/message-tracking.service';
import { MonitoringCacheService } from '../tracking/monitoring-cache.service';

@Injectable()
export class MonitoringProbeService {
  private readonly logger = new Logger(MonitoringProbeService.name);

  constructor(
    private readonly messageTrackingService: MessageTrackingService,
    private readonly cacheService: MonitoringCacheService,
  ) {}

  async recordReplySkippedProbe(body?: { messageId?: string; reason?: DeliverySkipReason }) {
    const reason: DeliverySkipReason = 'output_leak';
    const messageId = body?.messageId?.trim() || `monitoring-probe-${Date.now()}`;

    this.logger.warn(
      `[MonitoringProbe] recordReplySkipped messageId=${messageId} reason=${reason}`,
    );
    this.messageTrackingService.recordReplySkipped(messageId, reason);

    return this.cacheService.getCounters();
  }
}
