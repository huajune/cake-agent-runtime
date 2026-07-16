import { Injectable, Logger } from '@nestjs/common';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import type {
  GuardrailSemanticFinding,
  GuardrailSemanticReviewMode,
} from '@biz/message/types/guardrail-review.types';
import type { OutputDecision } from '@shared-types/guardrail.contract';

export interface SemanticReviewRecordParams {
  mode: GuardrailSemanticReviewMode;
  decision: OutputDecision;
  confidence: string;
  findings: GuardrailSemanticFinding[];
  draftReply: string;
  traceId?: string;
  chatId?: string;
  userId?: string;
  botUserName?: string;
  contactName?: string;
  userMessage?: string;
}

/** 把 Semantic Reviewer 的完整判例归档到统一守卫日志，不创建 BadCase。 */
@Injectable()
export class SemanticReviewRecorderService {
  private readonly logger = new Logger(SemanticReviewRecorderService.name);

  constructor(private readonly guardrailReviews: GuardrailReviewService) {}

  async record(params: SemanticReviewRecordParams): Promise<boolean> {
    if (!params.traceId) {
      // debug-chat / test-suite 没有生产 traceId，证据由各自 execution trace 承载。
      return false;
    }

    try {
      return await this.guardrailReviews.recordSemanticReview({
        traceId: params.traceId,
        chatId: params.chatId,
        userId: params.userId,
        botUserName: params.botUserName,
        contactName: params.contactName,
        userMessage: params.userMessage,
        mode: params.mode,
        decision: params.decision,
        confidence: params.confidence,
        findings: params.findings,
        draftReply: params.draftReply,
      });
    } catch (error: unknown) {
      this.logger.error(
        `[SemanticReview] 守卫判例落库异常: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
