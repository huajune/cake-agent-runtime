import { useState, useEffect, useRef, useCallback } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { X, Plus, ListChecks, ShieldAlert, MessageSquare, ChevronDown } from 'lucide-react';
import { useUpdateStageGoals } from '@/hooks/strategy/useStrategyConfig';
import type { StrategyConfigRecord, StageGoalConfig } from '@/api/types/strategy.types';
import styles from '../styles/index.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

export default function StageGoalsSection({ config }: Props) {
  const [stages, setStages] = useState<StageGoalConfig[]>(config.stage_goals.stages);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const updateMutation = useUpdateStageGoals();
  const stagesRef = useRef(stages);
  const savedRef = useRef(config.stage_goals.stages);

  useEffect(() => {
    setStages(config.stage_goals.stages);
    stagesRef.current = config.stage_goals.stages;
    savedRef.current = config.stage_goals.stages;
  }, [config.stage_goals.stages]);

  const handleFieldChange = (index: number, field: keyof StageGoalConfig, value: string) => {
    setStages((prev) => {
      const next = prev.map((s, i) => (i === index ? { ...s, [field]: value } : s));
      stagesRef.current = next;
      return next;
    });
  };

  const handleListChange = (
    stageIndex: number,
    field: 'successCriteria' | 'disallowedActions' | 'ctaStrategy',
    itemIndex: number,
    value: string,
  ) => {
    setStages((prev) => {
      const next = prev.map((s, i) => {
        if (i !== stageIndex) return s;
        const list = [...s[field]];
        list[itemIndex] = value;
        return { ...s, [field]: list };
      });
      stagesRef.current = next;
      return next;
    });
  };

  const handleAddListItem = (
    stageIndex: number,
    field: 'successCriteria' | 'disallowedActions' | 'ctaStrategy',
  ) => {
    setStages((prev) => {
      const next = prev.map((s, i) => {
        if (i !== stageIndex) return s;
        return { ...s, [field]: [...s[field], ''] };
      });
      stagesRef.current = next;
      return next;
    });
  };

  // 二次确认删除
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (confirmingKey !== null) {
      confirmTimerRef.current = setTimeout(() => setConfirmingKey(null), 3000);
      return () => clearTimeout(confirmTimerRef.current);
    }
  }, [confirmingKey]);

  const handleRemoveListItem = useCallback(
    (stageIndex: number, field: 'successCriteria' | 'disallowedActions' | 'ctaStrategy', itemIndex: number) => {
      const key = `${field}-${stageIndex}-${itemIndex}`;
      if (confirmingKey !== key) {
        setConfirmingKey(key);
        return;
      }
      setConfirmingKey(null);
      const next = stages.map((s, i) => {
        if (i !== stageIndex) return s;
        return { ...s, [field]: s[field].filter((_, j) => j !== itemIndex) };
      });
      setStages(next);
      stagesRef.current = next;
      updateMutation.mutate({ stages: next });
    },
    [confirmingKey, stages, updateMutation],
  );

  const isDirty = () =>
    JSON.stringify(stagesRef.current) !== JSON.stringify(savedRef.current);

  const handleBlur = () => {
    if (!isDirty()) return;
    updateMutation.mutate({ stages: stagesRef.current });
  };

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>阶段目标</h2>
        <p className={styles.sectionDesc}>
          定义候选人生命周期的 5 个阶段，每个阶段的目标和策略将作为工具上下文传递给 AI
        </p>
      </div>

      <div className={styles.stagesGrid}>
        {stages.map((stage, index) => (
          <div
            key={stage.stage}
            className={`${styles.stageCard} ${expandedIndex === index ? styles.stageCardExpanded : ''}`}
          >
            <div
              className={styles.stageHeader}
              onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
            >
              <div className={styles.stageHeaderLeft}>
                <span className={styles.stageIndex}>{stage.stage}</span>
                <span className={styles.stageName}>{stage.label}</span>
              </div>
              <ChevronDown
                size={16}
                className={`${styles.stageChevron} ${expandedIndex === index ? styles.stageChevronOpen : ''}`}
              />
            </div>

            {expandedIndex === index && <div className={styles.stageFields}>
              {/* 阶段定义 */}
              <div className={`${styles.fieldGroup} ${styles.fieldGroupFull}`}>
                <label className={styles.fieldLabel}>阶段定义</label>
                <TextareaAutosize
                  className={styles.fieldTextArea}
                  value={stage.description}
                  onChange={(e) => handleFieldChange(index, 'description', e.target.value)}
                  onBlur={handleBlur}
                  minRows={1}
                  maxRows={4}
                  placeholder="描述这个阶段的含义和定位"
                />
              </div>

              {/* 主要目标 */}
              <div className={`${styles.fieldGroup} ${styles.fieldGroupFull}`}>
                <label className={styles.fieldLabel}>主要目标</label>
                <TextareaAutosize
                  className={styles.fieldTextArea}
                  value={stage.primaryGoal}
                  onChange={(e) => handleFieldChange(index, 'primaryGoal', e.target.value)}
                  onBlur={handleBlur}
                  minRows={1}
                  maxRows={8}
                />
              </div>

              {/* CTA 策略 */}
              <div className={`${styles.fieldGroup} ${styles.fieldGroupFull}`}>
                <label className={styles.fieldLabel}>CTA 策略</label>
                <div className={styles.listField}>
                  {stage.ctaStrategy.length === 0 ? (
                    <div className={styles.emptyListState}>
                      <MessageSquare size={20} className={styles.emptyIcon} />
                      <span>暂无 CTA 策略</span>
                      <button
                        className={styles.addBtn}
                        onClick={() => handleAddListItem(index, 'ctaStrategy')}
                      >
                        <Plus size={14} /> 添加第一条
                      </button>
                    </div>
                  ) : (
                    <>
                      {stage.ctaStrategy.map((item, itemIdx) => (
                        <div key={itemIdx} className={styles.listItem}>
                          <span className={styles.listIndex}>{itemIdx + 1}.</span>
                          <TextareaAutosize
                            className={styles.fieldTextArea}
                            value={item}
                            onChange={(e) =>
                              handleListChange(index, 'ctaStrategy', itemIdx, e.target.value)
                            }
                            onBlur={handleBlur}
                            minRows={1}
                            maxRows={8}
                          />
                          <button
                            className={`${styles.removeBtn} ${confirmingKey === `ctaStrategy-${index}-${itemIdx}` ? styles.ruleRemoveConfirm : ''}`}
                            onClick={() => handleRemoveListItem(index, 'ctaStrategy', itemIdx)}
                            title={confirmingKey === `ctaStrategy-${index}-${itemIdx}` ? '再次点击确认删除' : '删除'}
                          >
                            {confirmingKey === `ctaStrategy-${index}-${itemIdx}` ? <>确认?</> : <X size={14} />}
                          </button>
                        </div>
                      ))}
                      <button
                        className={styles.addBtn}
                        onClick={() => handleAddListItem(index, 'ctaStrategy')}
                      >
                        <Plus size={14} /> 添加
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 成功标准 */}
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>成功标准</label>
                <div className={styles.listField}>
                  {stage.successCriteria.length === 0 ? (
                    <div className={styles.emptyListState}>
                      <ListChecks size={20} className={styles.emptyIcon} />
                      <span>暂无成功标准</span>
                      <button
                        className={styles.addBtn}
                        onClick={() => handleAddListItem(index, 'successCriteria')}
                      >
                        <Plus size={14} /> 添加第一条
                      </button>
                    </div>
                  ) : (
                    <>
                      {stage.successCriteria.map((item, itemIdx) => (
                        <div key={itemIdx} className={styles.listItem}>
                          <span className={styles.listIndex}>{itemIdx + 1}.</span>
                          <TextareaAutosize
                            className={styles.fieldTextArea}
                            value={item}
                            onChange={(e) =>
                              handleListChange(index, 'successCriteria', itemIdx, e.target.value)
                            }
                            onBlur={handleBlur}
                            minRows={1}
                            maxRows={8}
                          />
                          <button
                            className={`${styles.removeBtn} ${confirmingKey === `successCriteria-${index}-${itemIdx}` ? styles.ruleRemoveConfirm : ''}`}
                            onClick={() => handleRemoveListItem(index, 'successCriteria', itemIdx)}
                            title={confirmingKey === `successCriteria-${index}-${itemIdx}` ? '再次点击确认删除' : '删除'}
                          >
                            {confirmingKey === `successCriteria-${index}-${itemIdx}` ? <>确认?</> : <X size={14} />}
                          </button>
                        </div>
                      ))}
                      <button
                        className={styles.addBtn}
                        onClick={() => handleAddListItem(index, 'successCriteria')}
                      >
                        <Plus size={14} /> 添加
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 禁止行为 */}
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>禁止行为</label>
                <div className={styles.listField}>
                  {stage.disallowedActions.length === 0 ? (
                    <div className={styles.emptyListState}>
                      <ShieldAlert size={20} className={styles.emptyIcon} />
                      <span>暂无禁止行为</span>
                      <button
                        className={styles.addBtn}
                        onClick={() => handleAddListItem(index, 'disallowedActions')}
                      >
                        <Plus size={14} /> 添加第一条
                      </button>
                    </div>
                  ) : (
                    <>
                      {stage.disallowedActions.map((item, itemIdx) => (
                        <div key={itemIdx} className={styles.listItem}>
                          <span className={styles.listIndex}>{itemIdx + 1}.</span>
                          <TextareaAutosize
                            className={`${styles.fieldTextArea} ${styles.fieldTextAreaDanger}`}
                            value={item}
                            onChange={(e) =>
                              handleListChange(index, 'disallowedActions', itemIdx, e.target.value)
                            }
                            onBlur={handleBlur}
                            minRows={1}
                            maxRows={8}
                          />
                          <button
                            className={`${styles.removeBtn} ${confirmingKey === `disallowedActions-${index}-${itemIdx}` ? styles.ruleRemoveConfirm : ''}`}
                            onClick={() => handleRemoveListItem(index, 'disallowedActions', itemIdx)}
                            title={confirmingKey === `disallowedActions-${index}-${itemIdx}` ? '再次点击确认删除' : '删除'}
                          >
                            {confirmingKey === `disallowedActions-${index}-${itemIdx}` ? <>确认?</> : <X size={14} />}
                          </button>
                        </div>
                      ))}
                      <button
                        className={styles.addBtn}
                        onClick={() => handleAddListItem(index, 'disallowedActions')}
                      >
                        <Plus size={14} /> 添加
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>}
          </div>
        ))}
      </div>
    </div>
  );
}
