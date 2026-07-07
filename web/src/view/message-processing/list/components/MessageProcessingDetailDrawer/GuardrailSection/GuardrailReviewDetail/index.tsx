import { decisionBadge } from '@/components/GuardrailTrace/decision';
import {
  guardrailReasonLabel,
  guardrailRuleLabel,
  guardrailRuleTitle,
} from '@/components/GuardrailTrace/labels';
import type { GuardrailReviewRecord, GuardrailReviewStepDetail } from '@/api/types/chat.types';
import styles from './index.module.scss';

function StepVerdict({ step }: { step: GuardrailReviewStepDetail }) {
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
      {step.feedback && (
        <div className={styles.feedback}>
          <span className={styles.violationLabel}>重写反馈</span>
          <span className={styles.violationContent}>{step.feedback}</span>
        </div>
      )}
    </>
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
