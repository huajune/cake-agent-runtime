import GuardrailTrace from '@/components/GuardrailTrace';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

/**
 * 守卫 runtime 过程：入站拦截摘要 + 出站首审→受控修复→二审时间线。
 * 数据来自 message_processing_records.guardrail_input / guardrail_output。
 */
export default function GuardrailSection({ message }: { message: MessageRecord }) {
  const input = message.guardrailInput;
  const output = message.guardrailOutput;
  if (!input && !output) return null;

  return (
    <>
      {input && (
        <>
          <div className={styles.sideTitle}>入站守卫</div>
          <div className={styles.inputCard}>
            <div className={styles.inputHeader}>
              <span className={styles.stepStage}>预检</span>
              <span className="status-badge danger">拦截转人工</span>
            </div>
            <div className={styles.inputDetail}>
              {input.riskLabel || input.riskType || '命中风险规则'}
              {input.reason ? ` · ${input.reason}` : ''}
            </div>
          </div>
        </>
      )}

      {output && (
        <>
          <div className={styles.sideTitle}>出站守卫</div>
          <GuardrailTrace trace={output} />
        </>
      )}
    </>
  );
}
