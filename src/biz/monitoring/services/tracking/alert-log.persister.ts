import { Injectable, Logger } from '@nestjs/common';
import type {
  AlertLogEntry,
  AlertLogPersister,
} from '@notification/types/alert-log-persister.interface';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';

/**
 * AlertLogPersister 的 biz/monitoring 实现：把 AlertNotifierService 发出的告警
 * 写入 monitoring_error_logs，让 dashboard "今日错误" / 错误列表能看到子系统告警
 * （群任务/Cron/Infra/Incident），不再只有消息处理失败链路。
 *
 * 通过 @notification 层定义的接口 + ALERT_LOG_PERSISTER token 注入，
 * 保持 notification 模块对 biz 零依赖。
 */
@Injectable()
export class AlertLogPersisterService implements AlertLogPersister {
  private readonly logger = new Logger(AlertLogPersisterService.name);

  constructor(private readonly errorLogRepository: MonitoringErrorLogRepository) {}

  async persist(entry: AlertLogEntry): Promise<void> {
    try {
      await this.errorLogRepository.saveErrorLog({
        messageId: entry.messageId,
        timestamp: entry.timestamp,
        error: entry.error,
        // alert_type 老语义保留：子系统告警归到 'system'，便于老前端按 type 聚合时不落空
        alertType: 'system',
        subsystem: entry.subsystem,
        component: entry.component,
        action: entry.action,
        severity: entry.severity,
        summary: entry.summary,
        code: entry.code,
        dedupeKey: entry.dedupeKey,
        throttled: entry.throttled,
        delivered: entry.delivered,
      });
    } catch (error) {
      // 持久化失败绝不影响告警发送主流程
      this.logger.warn(
        `持久化告警日志失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
