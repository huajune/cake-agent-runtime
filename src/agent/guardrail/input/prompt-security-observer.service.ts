import { Injectable, Logger } from '@nestjs/common';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { toErrorMessage } from '@infra/utils/error.util';
import type { PromptInjectionAssessment } from './prompt-injection-detector';

/** Prompt Injection 的观测/告警出口；失败只降级为日志，不阻断候选人回合。 */
@Injectable()
export class PromptSecurityObserverService {
  private readonly logger = new Logger(PromptSecurityObserverService.name);

  constructor(private readonly alerts: AlertNotifierService) {}

  async record(
    userId: string,
    assessment: PromptInjectionAssessment,
    contentPreview: string,
  ): Promise<void> {
    if (!assessment.detected) return;
    const reason = assessment.reason ?? assessment.ruleId ?? 'unknown_prompt_injection';
    this.logger.warn(
      `Prompt injection 检测: userId=${userId}, category=${assessment.category ?? '-'}, ruleId=${assessment.ruleId ?? '-'}, reason=${reason}`,
    );
    try {
      await this.alerts.sendAlert(
        this.alerts.createPromptInjectionAlert({
          userId,
          reason,
          contentPreview: contentPreview.slice(0, 200),
        }),
      );
    } catch (error) {
      this.logger.warn(`Prompt injection 告警发送失败: ${toErrorMessage(error)}`);
    }
  }
}
