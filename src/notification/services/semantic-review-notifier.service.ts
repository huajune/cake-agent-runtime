import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';
import { AlertNotifierService } from './alert-notifier.service';

/** 判例来源：shadow=只观测未拦截；enforce=结论参与裁决；confidence_downgraded=低置信被代码层降级 observe。 */
export type SemanticReviewVerdictMode = 'shadow' | 'enforce' | 'confidence_downgraded';

export interface SemanticReviewFindingSummary {
  code: string;
  evidenceQuote: string;
  userImpact: string;
  feedbackToGenerator: string;
}

export interface SemanticReviewVerdictNotification {
  mode: SemanticReviewVerdictMode;
  decision: string;
  confidence: string;
  findings: SemanticReviewFindingSummary[];
  replyPreview: string;
  userMessage?: string;
  chatId?: string;
  userId?: string;
  traceId?: string;
  contactName?: string;
  botUserName?: string;
}

const MODE_LABEL: Record<SemanticReviewVerdictMode, string> = {
  shadow: '【shadow 观测，未拦截】',
  enforce: '【enforce，已拦截/打回】',
  confidence_downgraded: '【低置信降级 observe，未拦截】',
};

/**
 * 语义出站守卫（SemanticReviewer）判例与故障通知器。
 *
 * 灰度期 shadow / enforce 的每条命中判例都是评估 precision 的原材料，
 * 只进日志等于白跑——统一写入飞书 badcase 多维表（与 rule 档 ReplyFactGuardNotifier 同表），
 * 运营与研发在同一张表里核对"reviewer 想拦的对不对"。
 *
 * reviewer 故障（fail-close 丢回复 / fail-open 放行）是运行事故信号，
 * 走 AlertNotifier 飞书告警通道（自带节流与 monitoring_error_logs 落库）。
 */
@Injectable()
export class SemanticReviewNotifierService {
  private readonly logger = new Logger(SemanticReviewNotifierService.name);

  constructor(
    private readonly bitableSyncService: FeishuBitableSyncService,
    private readonly alertNotifier: AlertNotifierService,
  ) {}

  /** 写一条语义审查判例到 badcase 多维表（fire-and-forget 由调用方决定）。 */
  async notifyVerdict(params: SemanticReviewVerdictNotification): Promise<boolean> {
    const findingCodes = params.findings.map((f) => f.code).join(', ') || '(no findings)';
    const findingLines = params.findings.map(
      (f, i) =>
        `${i + 1}. ${f.code}\n   证据: ${f.evidenceQuote}\n   影响: ${f.userImpact}\n   改写建议: ${f.feedbackToGenerator}`,
    );

    const chatHistory = [
      params.userMessage ? `[候选人] ${params.userMessage}` : null,
      `[招募经理] ${params.replyPreview}`,
    ]
      .filter(Boolean)
      .join('\n');

    const remark = [
      `${MODE_LABEL[params.mode]}语义出站守卫 decision=${params.decision}, confidence=${params.confidence}`,
      `命中 finding：${findingCodes}`,
      ...findingLines,
    ].join('\n');

    try {
      const result = await this.bitableSyncService.writeAgentTestFeedback({
        type: 'badcase',
        chatHistory,
        userMessage: params.userMessage,
        errorType: `semantic_review:${findingCodes}`,
        remark,
        chatId: params.chatId,
        traceId: params.traceId,
        candidateName: params.contactName,
        managerName: params.botUserName,
      });
      if (!result.success) {
        this.logger.error(
          `[SemanticReview] 判例写入 badcase 表失败: chatId=${params.chatId ?? '-'}, error=${result.error}`,
        );
      }
      return result.success;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SemanticReview] 判例写入 badcase 表异常: ${message}`);
      return false;
    }
  }

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
