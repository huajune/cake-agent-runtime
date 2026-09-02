import { Injectable, Logger, Optional } from '@nestjs/common';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { AgentTracerService } from '@observability/agent-tracer.service';
import type { PromptInjectionAssessment } from './prompt-injection-detector';

export type PromptInjectionAlertStatus = 'sent' | 'failed' | 'skipped';

/** Prompt Injection 的观测/告警出口；失败只降级为日志，不阻断候选人回合。 */
@Injectable()
export class PromptSecurityObserverService {
  private readonly logger = new Logger(PromptSecurityObserverService.name);

  constructor(
    private readonly alerts: AlertNotifierService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  async record(
    userId: string,
    assessment: PromptInjectionAssessment,
  ): Promise<PromptInjectionAlertStatus> {
    if (!assessment.detected) return 'skipped';
    const reason = assessment.reason ?? assessment.ruleId ?? 'unknown_prompt_injection';
    this.logger.warn(
      `Prompt injection 检测: userId=${userId}, category=${assessment.category ?? '-'}, ruleId=${assessment.ruleId ?? '-'}, reason=${reason}`,
    );
    let alertStatus: PromptInjectionAlertStatus = 'sent';
    try {
      await this.alerts.sendAlert(
        this.alerts.createPromptInjectionAlert({
          userId,
          reason,
          contentPreview: assessment.evidencePreview ?? '[命中内容已省略]',
        }),
      );
    } catch (error) {
      alertStatus = 'failed';
      this.logger.warn(`Prompt injection 告警发送失败: ${toErrorMessage(error)}`);
    }
    this.tracer?.emit({
      type: 'prompt_injection_detected',
      userId,
      category: assessment.category,
      ruleId: assessment.ruleId,
      alertStatus,
      evidencePreview: assessment.evidencePreview,
    });
    return alertStatus;
  }
}
