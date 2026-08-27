import { decisionBadge } from '@/components/GuardrailTrace/decision';
import {
  guardrailReasonLabel,
  guardrailRuleLabel,
  guardrailRuleTitle,
} from '@/components/GuardrailTrace/labels';
import type {
  GuardrailReviewRecord,
  GuardrailReviewStepDetail,
  GuardrailSemanticReview,
} from '@/api/types/chat.types';
import styles from './index.module.scss';

function normalizeReviewText(text: string) {
  return text.trim().replace(/\s+/g, ' ');
}

function shouldShowStepFeedback(step: GuardrailReviewStepDetail) {
  const feedback = step.feedback?.trim();
  if (!feedback) return false;

  const normalizedSuggestions = step.violations
    .map((violation) => violation.suggestion?.trim())
    .filter((suggestion): suggestion is string => Boolean(suggestion))
    .map(normalizeReviewText);
  if (normalizedSuggestions.length === 0) return true;

  const suggestionSet = new Set(normalizedSuggestions);
  const normalizedFeedback = normalizeReviewText(feedback);
  if (suggestionSet.has(normalizedFeedback)) return false;

  const feedbackLines = feedback.split('\n').map(normalizeReviewText).filter(Boolean);
  if (feedbackLines.length > 0 && feedbackLines.every((line) => suggestionSet.has(line))) {
    return false;
  }

  return (
    normalizeReviewText(
      step.violations
        .map((violation) => violation.suggestion?.trim())
        .filter(Boolean)
        .join('\n'),
    ) !== normalizedFeedback
  );
}

function StepVerdict({ step }: { step: GuardrailReviewStepDetail }) {
  const showFeedback = shouldShowStepFeedback(step);

  return (
    <>
      {step.ruleIds.length > 0 && (
        <div className={styles.ruleList}>
          {step.ruleIds.map((rule) => (
            <code key={rule} className={styles.ruleTag} title={guardrailRuleTitle(rule)}>
              {guardrailRuleLabel(rule)}
            </code>
          ))}
        </div>
      )}
      <div className={styles.verdictMeta}>
        <span className={`${styles.riskBadge} ${styles[`risk${step.riskLevel}`]}`}>
          风险 {step.riskLevel}
        </span>
        {step.blockedRuleIds.map((rule) => (
          <code key={rule} className={styles.blockedRuleTag} title={guardrailRuleTitle(rule)}>
            阻断 · {guardrailRuleLabel(rule)}
          </code>
        ))}
      </div>
      {step.violations.length > 0 && (
        <div className={styles.violationList}>
          {step.violations.map((v, i) => (
            <div key={`${v.type}-${i}`} className={styles.violation}>
              <div className={styles.violationHead}>
                <code className={styles.ruleTag} title={guardrailRuleTitle(v.type)}>
                  {guardrailRuleLabel(v.type)}
                </code>
                {v.severity && <span className={styles.severity}>{v.severity}</span>}
              </div>
              {v.evidence && (
                <div className={styles.violationLine}>
                  <span className={styles.violationLabel}>证据</span>
                  <span className={styles.violationContent}>{v.evidence}</span>
                </div>
              )}
              {v.suggestion && (
                <div className={styles.violationLine}>
                  <span className={styles.violationLabel}>建议</span>
                  <span className={styles.violationContent}>{v.suggestion}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {showFeedback && step.feedback && (
        <div className={styles.feedback}>
          <span className={styles.violationLabel}>重写反馈</span>
          <span className={styles.violationContent}>{step.feedback}</span>
        </div>
      )}
    </>
  );
}

function SemanticReview({ review, index }: { review: GuardrailSemanticReview; index: number }) {
  return (
    <div className={styles.semanticReview}>
      <div className={styles.semanticHeader}>
        <span className={styles.semanticIndex}>判例 {index + 1}</span>
        <code className={styles.semanticMode}>{review.mode}</code>
        {decisionBadge(review.decision)}
        <span className={styles.confidence}>置信度 {review.confidence}</span>
      </div>
      {review.findings.length > 0 ? (
        <div className={styles.findingList}>
          {review.findings.map((finding, findingIndex) => (
            <div key={`${finding.code}-${findingIndex}`} className={styles.finding}>
              <code className={styles.findingCode}>{finding.code}</code>
              {finding.evidenceQuote && (
                <div className={styles.findingLine}>
                  <span>证据</span>
                  <div>{finding.evidenceQuote}</div>
                </div>
              )}
              {finding.userImpact && (
                <div className={styles.findingLine}>
                  <span>影响</span>
                  <div>{finding.userImpact}</div>
                </div>
              )}
              {finding.feedbackToGenerator && (
                <div className={styles.findingLine}>
                  <span>反馈</span>
                  <div>{finding.feedbackToGenerator}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.noFindings}>无语义问题</div>
      )}
      {review.draftReply && (
        <details className={styles.draftReply}>
          <summary>审查回复草稿</summary>
          <div>{review.draftReply}</div>
        </details>
      )}
    </div>
  );
}

/**
 * 出站守卫审查全程档案视图：首版全文 → 首审意见（证据/建议全文）→ 重写版全文 → 二审 → 最终。
 * 数据来自 guardrail_review_records（详情接口 guardrailReview 字段），仅守卫命中回合存在；
 * 历史数据没有档案时详情抽屉回退到紧凑 GuardrailTrace。
 */
export default function GuardrailReviewDetail({ review }: { review: GuardrailReviewRecord }) {
  return (
    <div className={styles.container}>
      {review.userMessage && (
        <div className={styles.userMessage}>
          <span className={styles.stepStage}>用户消息</span>
          <div className={styles.replyText}>{review.userMessage}</div>
        </div>
      )}

      <div className={styles.stepRow}>
        <div className={styles.stepHeader}>
          <span className={styles.stepStage}>首版</span>
          {review.repaired && <span className={styles.discardHint}>已丢弃未发送</span>}
        </div>
        <div className={styles.replyText}>{review.firstReply}</div>
      </div>

      <div className={styles.stepRow}>
        <div className={styles.stepHeader}>
          <span className={styles.stepStage}>首审</span>
          {decisionBadge(review.first.decision)}
        </div>
        <StepVerdict step={review.first} />
      </div>

      {review.repaired && (
        <div className={styles.repairNote}>
          ↳ 按 {review.repairMode === 'replan' ? '重查（只读工具）' : '无工具重写'} 受控修复
          {review.committedSideEffects && (
            <div className={styles.sideEffectNote}>{review.committedSideEffects}</div>
          )}
        </div>
      )}

      {review.repaired && (
        <div className={styles.stepRow}>
          <div className={styles.stepHeader}>
            <span className={styles.stepStage}>重写版</span>
          </div>
          <div className={styles.replyText}>
            {review.revisedReply || <span className={styles.emptyReply}>（重写为空）</span>}
          </div>
        </div>
      )}

      {review.revised && (
        <div className={styles.stepRow}>
          <div className={styles.stepHeader}>
            <span className={styles.stepStage}>二审</span>
            {decisionBadge(review.revised.decision)}
          </div>
          <StepVerdict step={review.revised} />
        </div>
      )}

      {review.semanticReviews.length > 0 && (
        <div className={styles.semanticSection}>
          <div className={styles.semanticTitle}>语义审查</div>
          {review.semanticReviews.map((semanticReview, index) => (
            <SemanticReview
              key={`${semanticReview.reviewedAt ?? semanticReview.mode}-${index}`}
              review={semanticReview}
              index={index}
            />
          ))}
        </div>
      )}

      <div className={styles.finalRow}>
        <span className={styles.stepStage}>最终</span>
        {decisionBadge(review.finalDecision)}
        {review.reasonCode && (
          <span className={styles.reasonCode} title={review.reasonCode}>
            {guardrailReasonLabel(review.reasonCode)}
          </span>
        )}
        {review.finalDecision === 'block' && (
          <span className={styles.blockHint}>本轮回复未发送</span>
        )}
      </div>
    </div>
  );
}
