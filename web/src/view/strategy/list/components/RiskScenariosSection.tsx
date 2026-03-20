import { useState, useEffect, useRef, useCallback } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { useUpdateRedLines } from '@/hooks/strategy/useStrategyConfig';
import type { StrategyConfigRecord } from '@/api/types/strategy.types';
import styles from '../styles/index.module.scss';
import s from '../styles/risk-scenarios.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

function scenariosToLabels(scenarios?: { label?: string }[]): string[] {
  if (!scenarios) return [];
  return scenarios.map((item) => item.label || '').filter(Boolean);
}

function labelsToScenarios(labels: string[]) {
  return labels.map((label) => ({ flag: '', label, signals: '', strategy: '' }));
}

export default function RiskScenariosSection({ config }: Props) {
  const [labels, setLabels] = useState<string[]>(() =>
    scenariosToLabels(config.red_lines.riskScenarios),
  );
  const [newLabel, setNewLabel] = useState('');
  const updateMutation = useUpdateRedLines();
  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLabels(scenariosToLabels(config.red_lines.riskScenarios));
  }, [config.red_lines.riskScenarios]);

  useEffect(() => {
    if (confirmingIndex !== null) {
      confirmTimerRef.current = setTimeout(() => setConfirmingIndex(null), 3000);
      return () => clearTimeout(confirmTimerRef.current);
    }
  }, [confirmingIndex]);

  const save = (updated: string[]) => {
    updateMutation.mutate({
      rules: config.red_lines.rules,
      riskScenarios: labelsToScenarios(updated),
    });
  };

  const handleAdd = () => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    const updated = [...labels, trimmed];
    setLabels(updated);
    setNewLabel('');
    save(updated);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleRemove = useCallback(
    (index: number) => {
      if (confirmingIndex !== index) {
        setConfirmingIndex(index);
        return;
      }
      setConfirmingIndex(null);
      const updated = labels.filter((_, i) => i !== index);
      setLabels(updated);
      save(updated);
    },
    [confirmingIndex, labels, config.red_lines.rules],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          风险场景
          <span className={styles.rulesCount}>({labels.length})</span>
        </h2>
        <p className={styles.sectionDesc}>
          定义 AI 需要特别注意的风险场景，将注入到系统提示词中作为安全约束
        </p>
      </div>

      {labels.length === 0 && (
        <div className={styles.emptyListState}>
          <AlertTriangle size={24} className={styles.emptyIcon} />
          <span>暂未配置风险场景</span>
        </div>
      )}

      <div className={s.tagList}>
        {labels.map((label, index) => (
          <span key={index} className={s.tag}>
            {label}
            <button
              className={`${s.tagRemove} ${confirmingIndex === index ? s.tagRemoveConfirm : ''}`}
              onClick={() => handleRemove(index)}
              title={confirmingIndex === index ? '再次点击确认删除' : '删除'}
            >
              {confirmingIndex === index ? '删?' : <X size={10} />}
            </button>
          </span>
        ))}
        <input
          className={s.addInput}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="+ 添加..."
        />
      </div>
    </div>
  );
}
