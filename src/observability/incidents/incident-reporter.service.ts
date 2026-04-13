import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { IncidentNotification } from './incident.types';

@Injectable()
export class IncidentReporterService {
  private readonly logger = new Logger(IncidentReporterService.name);

  constructor(private readonly alertNotifier: AlertNotifierService) {}

  async notify({
    source,
    error,
    title,
    errorType = 'system_exception',
    level = AlertLevel.ERROR,
    apiEndpoint,
    extra,
  }: IncidentNotification): Promise<boolean> {
    return this.alertNotifier.sendAlert({
      errorType,
      title: title || `系统异常: ${source}`,
      error,
      level,
      scenario: source,
      apiEndpoint,
      extra: {
        source,
        ...extra,
      },
      details: this.buildErrorDetails(error),
    });
  }

  notifyAsync(notification: IncidentNotification): void {
    void this.notify(notification).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`发送系统异常告警失败: ${message}`);
    });
  }

  private buildErrorDetails(error: unknown): Record<string, unknown> | undefined {
    if (!(error instanceof Error)) {
      return undefined;
    }

    return {
      name: error.name,
      stack: error.stack?.split('\n').slice(0, 20).join('\n'),
    };
  }
}
