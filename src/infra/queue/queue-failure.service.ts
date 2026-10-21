import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { toErrorMessage } from '@infra/utils/error.util';

@Injectable()
export class QueueFailureService {
  private readonly logger = new Logger(QueueFailureService.name);

  constructor(private readonly alerts: AlertNotifierService) {}

  async report(code: string, resource: string, error: unknown): Promise<void> {
    const detail = toErrorMessage(error);
    this.logger.error(`${code} resource=${resource}: ${detail}`);
    try {
      await this.alerts.sendAlert({
        code,
        severity: AlertLevel.ERROR,
        summary: `后台任务异常：${resource}`,
        source: { subsystem: 'queue', component: 'QueueRuntime', action: code },
        diagnostics: { errorMessage: detail },
        dedupe: { key: `${code}:${resource}` },
      });
    } catch (alertError) {
      this.logger.error(`后台任务告警失败: ${toErrorMessage(alertError)}`);
    }
  }

  async exhausted(queue: string, job: Job, error: Error): Promise<void> {
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await this.report('queue.retry_exhausted', `${queue}:${job.name}:${job.id}`, error);
  }
}
