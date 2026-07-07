import { Fragment } from 'react';
import type { GuardrailTurnTrace } from '@/api/types/chat.types';
import { decisionBadge } from './decision';
import { guardrailReasonLabel, guardrailRuleLabel, guardrailRuleListTitle } from './labels';
import styles from './index.module.scss';

export interface GuardrailTraceProps {
  trace: GuardrailTurnTrace;
  /** advisory=调试页流末只读审查（token 已发出，仅展示"守卫会怎么判"，不代表真实拦截）。 */
  advisory?: boolean;
}

/**
 * 出站守卫全程 trace 视图（首审→受控修复→二审）。
 * 生产流水页详情抽屉与调试页共用；advisory 时加提示区分"会怎么判"与"真实拦截"。
 */
export default function GuardrailTrace({ trace, advisory }: GuardrailTraceProps) {
  return (
    <div className={styles.container}>
      {trace.steps.map((step, index) => {
        const rules = step.ruleIds.length > 0 ? step.ruleIds : step.violationTypes;
        return (
          <Fragment key={`${step.stage}-${index}`}>
            <div className={styles.stepRow}>
              <div className={styles.stepHeader}>
                <span className={styles.stepStage}>
                  {step.stage === 'first' ? '首审' : '二审'}
                </span>
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
                ↳ 首版丢弃，按{' '}
                {trace.steps[0]?.repairMode === 'replan' ? '重查（只读工具）' : '无工具重写'}{' '}
                受控修复
              </div>
            )}
          </Fragment>
        );
      })}

      <div className={styles.finalRow}>
        <span className={styles.stepStage}>最终</span>
        {decisionBadge(trace.finalDecision)}
        {trace.reasonCode && (
          <span className={styles.reasonCode} title={trace.reasonCode}>
            {guardrailReasonLabel(trace.reasonCode)}
          </span>
        )}
        {advisory ? (
          <span className={styles.advisoryHint}>advisory（不代表真实拦截）</span>
        ) : (
          trace.finalDecision === 'block' && <span className={styles.blockHint}>本轮回复未发送</span>
        )}
      </div>
    </div>
  );
}
