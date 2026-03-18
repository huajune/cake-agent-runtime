import { useState, useEffect, useRef, useCallback } from 'react';
import { X, AlertTriangle, Plus } from 'lucide-react';
import { useUpdateRedLines } from '@/hooks/strategy/useStrategyConfig';
import type { StrategyConfigRecord, RiskScenario } from '@/api/types/strategy.types';
import styles from '../styles/index.module.scss';
import scenarioStyles from '../styles/risk-scenarios.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

const EMPTY_SCENARIO: RiskScenario = { flag: '', label: '', signals: '', strategy: '' };

export default function RiskScenariosSection({ config }: Props) {
  const [scenarios, setScenarios] = useState<RiskScenario[]>(
    () => config.red_lines.riskScenarios ?? [],
  );
  const updateMutation = useUpdateRedLines();
  const scenariosRef = useRef(scenarios);
  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const next = config.red_lines.riskScenarios ?? [];
    setScenarios(next);
    scenariosRef.current = next;
  }, [config.red_lines.riskScenarios]);

  useEffect(() => {
    if (confirmingIndex !== null) {
      confirmTimerRef.current = setTimeout(() => setConfirmingIndex(null), 3000);
      return () => clearTimeout(confirmTimerRef.current);
    }
  }, [confirmingIndex]);

  const save = (updated: RiskScenario[]) => {
    updateMutation.mutate({
      rules: config.red_lines.rules,
      riskScenarios: updated,
    });
  };

  const handleFieldChange = (index: number, field: keyof RiskScenario, value: string) => {
    setScenarios((prev) => {
      const next = prev.map((s, i) => (i === index ? { ...s, [field]: value } : s));
      scenariosRef.current = next;
      return next;
    });
  };

  const handleBlur = () => {
    const current = scenariosRef.current;
    const saved = config.red_lines.riskScenarios ?? [];
    const dirty = JSON.stringify(current) !== JSON.stringify(saved);
    if (!dirty) return;
    save(current);
  };

  const handleAdd = () => {
    const updated = [...scenarios, { ...EMPTY_SCENARIO }];
    setScenarios(updated);
    scenariosRef.current = updated;
  };

  const handleRemove = useCallback(
    (index: number) => {
      if (confirmingIndex !== index) {
        setConfirmingIndex(index);
        return;
      }
      setConfirmingIndex(null);
      const updated = scenarios.filter((_, i) => i !== index);
      setScenarios(updated);
      scenariosRef.current = updated;
      save(updated);
    },
    [confirmingIndex, scenarios, config.red_lines.rules],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          风险场景
          <span className={styles.rulesCount}>({scenarios.length})</span>
        </h2>
        <p className={styles.sectionDesc}>
          定义 AI 需要特别注意的风险场景。当分类器检测到对应风险信号时，AI 将按此策略应对。
        </p>
      </div>

      {scenarios.length === 0 && (
        <div className={styles.emptyListState}>
          <AlertTriangle size={24} className={styles.emptyIcon} />
          <span>暂未配置风险场景</span>
          <span className={styles.emptyHint}>点击下方按钮添加第一个风险场景</span>
        </div>
      )}

      <div className={scenarioStyles.scenariosList}>
        {scenarios.map((scenario, index) => (
          <div key={index} className={scenarioStyles.scenarioCard}>
            <div className={scenarioStyles.scenarioHeader}>
              <span className={scenarioStyles.scenarioIndex}>{index + 1}</span>
              <div className={scenarioStyles.scenarioHeaderFields}>
                <input
                  className={scenarioStyles.flagInput}
                  value={scenario.flag}
                  onChange={(e) => handleFieldChange(index, 'flag', e.target.value)}
                  onBlur={handleBlur}
                  placeholder="flag 标识 (如 age_sensitive)"
                />
                <input
                  className={scenarioStyles.labelInput}
                  value={scenario.label}
                  onChange={(e) => handleFieldChange(index, 'label', e.target.value)}
                  onBlur={handleBlur}
                  placeholder="中文标签 (如 年龄敏感)"
                />
              </div>
              <button
                className={`${styles.ruleRemoveBtn} ${confirmingIndex === index ? styles.ruleRemoveConfirm : ''}`}
                onClick={() => handleRemove(index)}
                title={confirmingIndex === index ? '再次点击确认删除' : '删除此场景'}
              >
                {confirmingIndex === index ? <>确认?</> : <X size={14} />}
              </button>
            </div>

            <div className={scenarioStyles.scenarioBody}>
              <div className={scenarioStyles.fieldRow}>
                <label className={scenarioStyles.fieldLabel}>触发信号</label>
                <textarea
                  className={scenarioStyles.fieldTextarea}
                  value={scenario.signals}
                  onChange={(e) => handleFieldChange(index, 'signals', e.target.value)}
                  onBlur={handleBlur}
                  placeholder="描述触发此风险的用户信号..."
                  rows={2}
                />
              </div>
              <div className={scenarioStyles.fieldRow}>
                <label className={scenarioStyles.fieldLabel}>应对策略</label>
                <textarea
                  className={scenarioStyles.fieldTextarea}
                  value={scenario.strategy}
                  onChange={(e) => handleFieldChange(index, 'strategy', e.target.value)}
                  onBlur={handleBlur}
                  placeholder="AI 检测到此风险时应如何应对..."
                  rows={2}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <button className={scenarioStyles.addScenarioBtn} onClick={handleAdd}>
        <Plus size={14} />
        添加风险场景
      </button>
    </div>
  );
}
