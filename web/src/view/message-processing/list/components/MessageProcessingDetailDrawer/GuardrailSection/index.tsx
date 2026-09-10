import GuardrailTrace from '@/components/GuardrailTrace';
import { guardrailInputDisplay } from '@/components/GuardrailTrace/outcome';
import GuardrailReviewDetail from './GuardrailReviewDetail';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

/**
 * 守卫 runtime 过程：入站转人工摘要 + 出站首审→受控修复→二审时间线。
 * 数据来自 message_processing_records.guardrail_input / guardrail_output；
 * 守卫命中的回合另有全程档案（guardrailReview，含首版/重写版全文与证据），
 * 有档案时展示全文视图，无档案（历史数据/纯放行）回退紧凑摘要。
 */
export default function GuardrailSection({ message }: { message: MessageRecord }) {
  const input = message.guardrailInput;
  const output = message.guardrailOutput;
  const review = message.guardrailReview;
  if (!input && !output && !review) return null;
  const inputDisplay = input ? guardrailInputDisplay(input.decision) : undefined;

  return (
    <>
      {input && inputDisplay && (
        <>
          <div className={styles.sideTitle}>入站守卫</div>
          <div className={styles.inputCard}>
            <div className={styles.inputHeader}>
              <span className={styles.stepStage}>预检</span>
              <span className={`status-badge ${inputDisplay.tone}`}>{inputDisplay.label}</span>
            </div>
            <div className={styles.inputDetail}>
              {input.riskLabel || input.riskType || '命中风险规则'}
              {input.reason ? ` · ${input.reason}` : ''}
            </div>
            {input.decision === 'handoff' && (
              <div className={styles.inputDetail}>介入派发状态以执行记录为准</div>
            )}
          </div>
        </>
      )}

      {review ? (
        <>
          <div className={styles.sideTitle}>出站守卫</div>
          <GuardrailReviewDetail review={review} />
        </>
      ) : (
        output && (
          <>
            <div className={styles.sideTitle}>出站守卫</div>
            <GuardrailTrace trace={output} />
          </>
        )
      )}
    </>
  );
}
