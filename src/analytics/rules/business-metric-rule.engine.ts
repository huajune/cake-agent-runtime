import { Injectable } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';

export interface BusinessMetricThresholds {
  successRateCritical: number;
  avgDurationCritical: number;
  queueDepthCritical: number;
  errorRateCritical: number;
}

export interface BusinessMetricSnapshot {
  totalMessages: number;
  successRate: number;
  avgDuration: number;
  activeRequests: number;
  errorCountLast24Hours: number;
}

export interface BusinessMetricAlert {
  key: string;
  title: string;
  message: string;
  level: AlertLevel;
}

@Injectable()
export class BusinessMetricRuleEngine {
  evaluate(params: {
    snapshot: BusinessMetricSnapshot;
    minSamples: number;
    thresholds: BusinessMetricThresholds;
  }): BusinessMetricAlert[] {
    const { snapshot, minSamples, thresholds } = params;
    const alerts: BusinessMetricAlert[] = [];

    if (snapshot.totalMessages >= minSamples) {
      alerts.push(
        ...this.checkSuccessRate(snapshot.successRate, snapshot.totalMessages, thresholds),
      );
      alerts.push(
        ...this.checkAvgDuration(snapshot.avgDuration, snapshot.totalMessages, thresholds),
      );
    }

    alerts.push(...this.checkQueueDepth(snapshot.activeRequests, thresholds));
    alerts.push(...this.checkErrorRate(snapshot.errorCountLast24Hours, thresholds));

    return alerts;
  }

  private checkSuccessRate(
    currentValue: number,
    totalMessages: number,
    thresholds: BusinessMetricThresholds,
  ): BusinessMetricAlert[] {
    if (!Number.isFinite(currentValue)) return [];

    const critical = thresholds.successRateCritical;
    const warning = critical + 10;

    if (currentValue < critical) {
      return [
        {
          key: 'success-rate',
          title: '成功率严重下降',
          message: `当前成功率: ${currentValue.toFixed(1)}%\n阈值: ${critical}%\n今日消息数: ${totalMessages}`,
          level: AlertLevel.CRITICAL,
        },
      ];
    }

    if (currentValue < warning) {
      return [
        {
          key: 'success-rate',
          title: '成功率下降',
          message: `当前成功率: ${currentValue.toFixed(1)}%\n阈值: ${warning}%\n今日消息数: ${totalMessages}`,
          level: AlertLevel.WARNING,
        },
      ];
    }

    return [];
  }

  private checkAvgDuration(
    currentValue: number,
    totalMessages: number,
    thresholds: BusinessMetricThresholds,
  ): BusinessMetricAlert[] {
    if (!Number.isFinite(currentValue) || currentValue <= 0) return [];

    const critical = thresholds.avgDurationCritical;
    const warning = Math.floor(critical / 2);

    if (currentValue > critical) {
      return [
        {
          key: 'avg-duration',
          title: '响应时间过长',
          message: `当前平均响应: ${(currentValue / 1000).toFixed(1)}s\n阈值: ${critical / 1000}s\n今日消息数: ${totalMessages}`,
          level: AlertLevel.CRITICAL,
        },
      ];
    }

    if (currentValue > warning) {
      return [
        {
          key: 'avg-duration',
          title: '响应时间偏高',
          message: `当前平均响应: ${(currentValue / 1000).toFixed(1)}s\n阈值: ${warning / 1000}s\n今日消息数: ${totalMessages}`,
          level: AlertLevel.WARNING,
        },
      ];
    }

    return [];
  }

  private checkQueueDepth(
    currentValue: number,
    thresholds: BusinessMetricThresholds,
  ): BusinessMetricAlert[] {
    const critical = thresholds.queueDepthCritical;
    const warning = Math.floor(critical / 2);

    if (currentValue > critical) {
      return [
        {
          key: 'queue-depth',
          title: '在途请求严重积压',
          message: `当前在途请求: ${currentValue}条\n阈值: ${critical}条`,
          level: AlertLevel.CRITICAL,
        },
      ];
    }

    if (currentValue > warning) {
      return [
        {
          key: 'queue-depth',
          title: '在途请求积压',
          message: `当前在途请求: ${currentValue}条\n阈值: ${warning}条`,
          level: AlertLevel.WARNING,
        },
      ];
    }

    return [];
  }

  private checkErrorRate(
    errorCount: number,
    thresholds: BusinessMetricThresholds,
  ): BusinessMetricAlert[] {
    const critical = thresholds.errorRateCritical;
    const warning = Math.floor(critical / 2);
    const hourlyRate = errorCount / 24;

    if (hourlyRate > critical) {
      return [
        {
          key: 'error-rate',
          title: '错误率过高',
          message: `24h错误数: ${errorCount}\n平均: ${hourlyRate.toFixed(1)}/h\n阈值: ${critical}/h`,
          level: AlertLevel.CRITICAL,
        },
      ];
    }

    if (hourlyRate > warning) {
      return [
        {
          key: 'error-rate',
          title: '错误率偏高',
          message: `24h错误数: ${errorCount}\n平均: ${hourlyRate.toFixed(1)}/h\n阈值: ${warning}/h`,
          level: AlertLevel.WARNING,
        },
      ];
    }

    return [];
  }
}
