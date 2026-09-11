import { CornerDownRight } from 'lucide-react';
import { decisionBadge } from '@/components/GuardrailTrace/decision';
import { guardrailOutcomeDisplay } from '@/components/GuardrailTrace/outcome';
import {
  guardrailReasonLabel,
  guardrailRuleLabel,
  guardrailRuleTitle,
  repairModeLabel,
} from '@/components/GuardrailTrace/labels';
import type {
  GuardrailReviewRecord,
  GuardrailReviewStepDetail,
  GuardrailSemanticReview,
} from '@/api/types/chat.types';
import styles from './index.module.scss';

const RISK_LABELS: Record<GuardrailReviewStepDetail['riskLevel'], string> = {
  low: '低',
  medium: '中',
  high: '高',
};

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

function isHighSeverity(severity: string) {
  return /^p[01]$/i.test(severity.trim());
}

/**
 * 首审/二审裁决。每个阶段只保留一个胶囊（裁决），其余信息降为文字：
 * 风险等级一行小字，命中规则、级别、阻断都在违规卡片头部同一行用文字表达，
 * 不再堆叠 rule / P1 / 阻断 三个胶囊。同一规则只露一次。
 */
function StepVerdict({ step }: { step: GuardrailReviewStepDetail }) {
  const showFeedback = shouldShowStepFeedback(step);
  const violationTypes = new Set(step.violations.map((violation) => violation.type));
  const blockedSet = new Set(step.blockedRuleIds);
  const standaloneRules = step.ruleIds.filter((rule) => !violationTypes.has(rule));

  return (
    <>
      <div className={styles.verdictMeta}>
        <span className={`${styles.riskText} ${styles[`risk${step.riskLevel}`]}`}>
          <i className={styles.riskDot} />
          风险{RISK_LABELS[step.riskLevel]}
        </span>
        {standaloneRules.length > 0 && (
          <span className={styles.ruleList}>
            命中
            {standaloneRules.map((rule) => (
              <span key={rule} className={styles.ruleName} title={guardrailRuleTitle(rule)}>
                {blockedSet.has(rule) ? '阻断 · ' : ''}
                {guardrailRuleLabel(rule)}
              </span>
            ))}
          </span>
        )}
      </div>
      {step.violations.length > 0 && (
        <div className={styles.violationList}>
          {step.violations.map((v, i) => (
            <div key={`${v.type}-${i}`} className={styles.violation}>
              <div className={styles.violationHead}>
                <span className={styles.ruleName} title={guardrailRuleTitle(v.type)}>
                  {guardrailRuleLabel(v.type)}
                </span>
                {v.severity && (
                  <span
                    className={`${styles.severity} ${isHighSeverity(v.severity) ? styles.severityHigh : ''}`}
                  >
                    {v.severity.toUpperCase()}
                  </span>
                )}
                {blockedSet.has(v.type) && <span className={styles.blockedMark}>阻断</span>}
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
        <span className={styles.semanticMode}>{review.mode}</span>
        {decisionBadge(review.decision)}
        <span className={styles.confidence}>置信度 {review.confidence}</span>
      </div>
      {review.findings.length > 0 ? (
        <div className={styles.findingList}>
          {review.findings.map((finding, findingIndex) => (
            <div key={`${finding.code}-${findingIndex}`} className={styles.finding}>
              <span className={styles.findingCode}>{finding.code}</span>
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
 * 出站守卫档案：首版全文 → 首审意见 → 可选修复全文与真实二审 → Runner 最终处置。
 * 数据来自 guardrail_review_records（详情接口 guardrailReview 字段），仅守卫命中回合存在；
 * 历史数据没有档案时详情抽屉回退到紧凑 GuardrailTrace。
 * 视觉：左侧时间线轨道串起各阶段，受控修复以连接线形式挂在首审与重写版之间。
 */
export default function GuardrailReviewDetail({ review }: { review: GuardrailReviewRecord }) {
  const final = guardrailOutcomeDisplay(review);
  return (
    <div className={styles.container}>
      {review.userMessage && (
        <div className={styles.stepRow}>
          <div className={styles.stepHeader}>
            <span className={styles.stepStage}>用户消息</span>
          </div>
          <div className={`${styles.replyText} ${styles.userText}`}>{review.userMessage}</div>
        </div>
      )}

      <div className={styles.stepRow}>
        <div className={styles.stepHeader}>
          <span className={styles.stepStage}>首版</span>
          {review.repaired && <span className={styles.discardHint}>已尝试修复</span>}
        </div>
        <div className={`${styles.replyText} ${review.repaired ? styles.discardedText : ''}`}>
          {review.firstReply}
        </div>
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
          <CornerDownRight size={13} strokeWidth={1.75} className={styles.repairIcon} />
          <div className={styles.repairBody}>
            <div className={styles.repairTitle}>
              按「{repairModeLabel(review.repairMode)}」受控修复
            </div>
            {review.committedSideEffects && (
              <div className={styles.sideEffectNote}>{review.committedSideEffects}</div>
            )}
          </div>
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

      {review.repaired && !review.revised && (
        <div className={styles.repairNote}>修复后未进入二审，保留首审证据</div>
      )}

      {review.semanticReviews.length > 0 && (
        <div className={`${styles.stepRow} ${styles.semanticSection}`}>
          <div className={styles.stepHeader}>
            <span className={styles.stepStage}>语义审查</span>
          </div>
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
        <span className={`status-badge ${final.tone}`}>{final.label}</span>
        {review.reasonCode && (
          <span className={styles.reasonCode} title={review.reasonCode}>
            {guardrailReasonLabel(review.reasonCode)}
          </span>
        )}
        {final.kind === 'handoff' && (
          <span className={styles.blockHint}>本轮不自动回复；介入派发状态以执行记录为准</span>
        )}
      </div>
    </div>
  );
}
