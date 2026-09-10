import { Fragment } from 'react';
import type { GuardrailTurnTrace } from '@/api/types/chat.types';
import { decisionBadge } from './decision';
import { guardrailOutcomeDisplay } from './outcome';
import {
  guardrailReasonLabel,
  guardrailRuleLabel,
  guardrailRuleListTitle,
  repairModeLabel,
} from './labels';
import styles from './index.module.scss';

export interface GuardrailTraceProps {
  trace: GuardrailTurnTrace;
  /** advisory=调试页流末只读审查（token 已发出，仅展示审查建议，不产生最终处置）。 */
  advisory?: boolean;
}

/**
 * 出站守卫全程 trace 视图（首审→受控修复→二审）。
 * 生产流水页详情抽屉与调试页共用；advisory 时区分审查建议与已执行回合的最终处置。
 */
export default function GuardrailTrace({ trace, advisory }: GuardrailTraceProps) {
  const final = guardrailOutcomeDisplay(trace, advisory);
  return (
    <div className={styles.container}>
      {trace.steps.map((step, index) => {
        const rules = step.ruleIds.length > 0 ? step.ruleIds : step.violationTypes;
        return (
          <Fragment key={`${step.stage}-${index}`}>
            <div className={styles.stepRow}>
              <div className={styles.stepHeader}>
                <span className={styles.stepStage}>{step.stage === 'first' ? '首审' : '二审'}</span>
                {decisionBadge(step.decision)}
                {step.reasonCode && (
                  <span className={styles.reasonCode} title={step.reasonCode}>
                    {guardrailReasonLabel(step.reasonCode)}
                  </span>
                )}
              </div>
              {rules.length > 0 && (
                <div className={styles.ruleList} title={guardrailRuleListTitle(rules)}>
                  {rules.map((rule) => (
                    <code key={rule} className={styles.ruleTag} title={rule}>
                      {guardrailRuleLabel(rule)}
                    </code>
                  ))}
                </div>
              )}
            </div>
            {/* 受控修复发生在首审与二审之间，插在时间线对应位置 */}
            {index === 0 && trace.repaired && (
              <div className={styles.repairNote}>
                ↳ 按 {repairModeLabel(trace.steps[0]?.repairMode)} 受控修复
              </div>
            )}
          </Fragment>
        );
      })}

      <div className={styles.finalRow}>
        <span className={styles.stepStage}>最终</span>
        <span className={`status-badge ${final.tone}`}>{final.label}</span>
        {trace.reasonCode && (
          <span className={styles.reasonCode} title={trace.reasonCode}>
            {guardrailReasonLabel(trace.reasonCode)}
          </span>
        )}
        {final.kind === 'advisory' && <span className={styles.advisoryHint}>未执行最终处置</span>}
        {final.kind === 'handoff' && (
          <span className={styles.blockHint}>本轮不自动回复；介入派发状态以执行记录为准</span>
        )}
      </div>
    </div>
  );
}
