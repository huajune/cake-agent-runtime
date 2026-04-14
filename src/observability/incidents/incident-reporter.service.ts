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
    summary,
    code = 'system.exception',
    severity = AlertLevel.ERROR,
    scope,
    impact,
    diagnostics,
    dedupe,
  }: IncidentNotification): Promise<boolean> {
    return this.alertNotifier.sendAlert({
      code,
      summary: summary || `系统异常: ${source.component}.${source.action}`,
      severity,
      source,
      scope,
      impact,
      diagnostics: {
        error,
        errorMessage: diagnostics?.errorMessage || this.extractErrorMessage(error),
        errorName: diagnostics?.errorName || (error instanceof Error ? error.name : undefined),
        stack: diagnostics?.stack || this.buildErrorStack(error),
        category: diagnostics?.category,
        modelChain: diagnostics?.modelChain,
        totalAttempts: diagnostics?.totalAttempts,
        messageCount: diagnostics?.messageCount,
        memoryWarning: diagnostics?.memoryWarning,
        dispatchMode: diagnostics?.dispatchMode,
        payload: diagnostics?.payload,
      },
      dedupe: dedupe || {
        key: `${code}:${source.subsystem}:${source.component}:${source.action}`,
      },
    });
  }

  notifyAsync(notification: IncidentNotification): void {
    void this.notify(notification).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`发送系统异常告警失败: ${message}`);
    });
  }

  private extractErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error == null) {
      return undefined;
    }
    return String(error);
  }

  private buildErrorStack(error: unknown): string | undefined {
    if (!(error instanceof Error)) {
      return undefined;
    }

    return error.stack?.split('\n').slice(0, 20).join('\n');
  }
}
