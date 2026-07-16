import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { GuardrailReviewRepository } from '../repositories/guardrail-review.repository';
import type {
  GuardrailReviewInsertInput,
  GuardrailReviewRecord,
  GuardrailSemanticReviewInput,
  GuardrailReviewWriteOutcome,
} from '../types/guardrail-review.types';

/**
 * 出站守卫审查档案服务。
 *
 * 该服务是 guardrail_review_records 的唯一业务消费入口；上层不直接依赖 Repository，
 * 以便把「何时可写、如何幂等、失败不阻断主链路」这些约束集中在 service 层。
 */
@Injectable()
export class GuardrailReviewService {
  private readonly logger = new Logger(GuardrailReviewService.name);

  constructor(
    private readonly repository: GuardrailReviewRepository,
    private readonly alertNotifier: AlertNotifierService,
  ) {}

  async recordReview(input: GuardrailReviewInsertInput): Promise<GuardrailReviewWriteOutcome> {
    if (!this.isWritableReview(input)) {
      this.logger.warn(`[guardrailReview] 非法审查档案写入被拒绝: traceId=${input.traceId}`);
      this.alertPersistFailure(input, 'invalid_review_input');
      return 'failed';
    }
    const outcome = await this.repository.insertReviewRecord(input);
    if (outcome === 'failed') {
      this.alertPersistFailure(input, 'db_write_failed');
    }
    return outcome;
  }

  async findByTraceId(traceId: string): Promise<GuardrailReviewRecord | null> {
    return this.repository.findByTraceId(traceId);
  }

  /** 追加完整 Semantic Reviewer 判例；失败可见但不阻塞回复主链。 */
  async recordSemanticReview(input: GuardrailSemanticReviewInput): Promise<boolean> {
    if (!input.traceId || !input.draftReply) {
      this.alertSemanticPersistFailure(input, 'invalid_semantic_review_input');
      return false;
    }
    const appended = await this.repository.appendSemanticReview(input);
    if (!appended) {
      this.alertSemanticPersistFailure(input, 'db_write_failed');
    }
    return appended;
  }

  async cleanupExpiredReviews(retentionDays: number): Promise<number> {
    return this.repository.cleanupExpiredReviews(retentionDays);
  }

  /**
   * 落库失败必须可见（守卫命中档案是低频高价值数据，静默丢失过一次坏 3 天没人发现）：
   * 发飞书告警群 + 落 monitoring_error_logs（AlertNotifier 自带 5 分钟/3 次节流与持久化）。
   * fire-and-forget，告警自身失败不反噬回复链路。
   */
  private alertPersistFailure(input: GuardrailReviewInsertInput, reason: string): void {
    void this.alertNotifier
      .sendAlert({
        code: 'guardrail_review_persist_failed',
        severity: AlertLevel.ERROR,
        summary: '出站守卫审查档案落库失败，该回合的首版/重写版全文将无法在详情页还原',
        source: {
          subsystem: 'agent',
          component: 'output-guardrail',
          action: 'persist_review_record',
        },
        scope: {
          messageId: input.traceId,
          chatId: input.chatId,
          userId: input.userId,
          contactName: input.contactName,
        },
        diagnostics: {
          category: reason,
          payload: {
            firstDecision: input.first?.decision,
            finalDecision: input.finalDecision,
            ruleIds: input.first?.ruleIds,
            repaired: input.repaired,
          },
        },
        dedupe: { key: `guardrail_review_persist_failed:${reason}` },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[guardrailReview] 落库失败告警发送异常: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private isWritableReview(input: GuardrailReviewInsertInput): boolean {
    if (!input.traceId || !input.firstReply || !input.first) return false;
    if (!input.repaired) {
      return input.repairMode == null && input.revisedReply == null && input.revised == null;
    }
    return Boolean(input.repairMode && input.revisedReply && input.revised);
  }

  private alertSemanticPersistFailure(input: GuardrailSemanticReviewInput, reason: string): void {
    void this.alertNotifier
      .sendAlert({
        code: 'guardrail_review_persist_failed',
        severity: AlertLevel.ERROR,
        summary: '语义守卫判例落库失败，该回合的 shadow/enforce 证据将无法回放',
        source: {
          subsystem: 'agent',
          component: 'output-guardrail',
          action: 'persist_semantic_review',
        },
        scope: {
          messageId: input.traceId,
          chatId: input.chatId,
          userId: input.userId,
          contactName: input.contactName,
        },
        diagnostics: {
          category: reason,
          payload: {
            mode: input.mode,
            decision: input.decision,
            confidence: input.confidence,
            findingCodes: input.findings.map((finding) => finding.code),
          },
        },
        dedupe: { key: `guardrail_semantic_review_persist_failed:${reason}` },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[guardrailReview] 语义判例落库失败告警发送异常: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
