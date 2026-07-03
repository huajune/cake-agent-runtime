import { Injectable, Logger } from '@nestjs/common';
import { GuardrailReviewRepository } from '../repositories/guardrail-review.repository';
import type {
  GuardrailReviewInsertInput,
  GuardrailReviewRecord,
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

  constructor(private readonly repository: GuardrailReviewRepository) {}

  async recordReview(input: GuardrailReviewInsertInput): Promise<GuardrailReviewWriteOutcome> {
    if (!this.isWritableReview(input)) {
      this.logger.warn(`[guardrailReview] 非法审查档案写入被拒绝: traceId=${input.traceId}`);
      return 'failed';
    }
    return this.repository.insertReviewRecord(input);
  }

  async findByTraceId(traceId: string): Promise<GuardrailReviewRecord | null> {
    return this.repository.findByTraceId(traceId);
  }

  private isWritableReview(input: GuardrailReviewInsertInput): boolean {
    if (!input.traceId || !input.firstReply || !input.first) return false;
    if (!input.repaired) {
      return input.repairMode == null && input.revisedReply == null && input.revised == null;
    }
    return Boolean(input.repairMode && input.revisedReply && input.revised);
  }
}
