import { Injectable } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from './alert-notifier.service';

/**
 * 语义出站守卫（SemanticReviewer）故障通知器。
 *
 * reviewer 故障（fail-close 丢回复 / fail-open 放行）是运行事故信号，
 * 走 AlertNotifier 飞书告警通道（自带节流与 monitoring_error_logs 落库）。
 */
@Injectable()
export class SemanticReviewNotifierService {
  constructor(private readonly alertNotifier: AlertNotifierService) {}

  /**
   * reviewer 故障告警。
   * - fail_close：高风险回复因 reviewer 不可用被 block（候选人本轮收不到回复）——error 级；
   * - fail_open：语义档故障放行、回退 rule 档裁决——warning 级；
   * - shadow：shadow 试跑失败，不影响线上但灰度评估缺样本——warning 级。
   */
  async notifyReviewerFailure(params: {
    failMode: 'fail_close' | 'fail_open' | 'shadow';
    error: string;
    chatId?: string;
    userId?: string;
    contactName?: string;
    replyPreview?: string;
  }): Promise<void> {
    const isFailClose = params.failMode === 'fail_close';
    await this.alertNotifier.sendAlert({
      code: isFailClose ? 'output_semantic_review_fail_close' : 'output_semantic_review_degraded',
      severity: isFailClose ? AlertLevel.ERROR : AlertLevel.WARNING,
      summary: isFailClose
        ? '语义出站守卫故障，高风险回复已 fail-close 拦截（候选人本轮未收到回复）'
        : `语义出站守卫故障（${params.failMode === 'shadow' ? 'shadow 试跑失败' : 'fail-open 回退 rule 档'}）`,
      source: {
        subsystem: 'agent',
        component: 'output-guardrail',
        action: 'semantic_review',
      },
      scope: {
        chatId: params.chatId,
        userId: params.userId,
        contactName: params.contactName,
      },
      impact: {
        userVisible: isFailClose,
        requiresHumanIntervention: isFailClose,
      },
      diagnostics: {
        errorMessage: params.error,
        payload: params.replyPreview ? { replyPreview: params.replyPreview } : undefined,
      },
      dedupe: { key: `semantic_review_failure:${params.failMode}` },
    });
  }
}
