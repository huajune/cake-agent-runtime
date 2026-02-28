import { useState, useEffect, useRef, useCallback } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X, Shield, GripVertical } from 'lucide-react';
import { useUpdateRedLines } from '@/hooks/strategy/useStrategyConfig';
import type { StrategyConfigRecord } from '@/types/strategy';
import styles from '../styles/index.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

// 稳定 id 生成：每条规则绑定一个持久 id，避免拖拽时因 index 变动导致闪烁
let nextId = 1;
function generateId() {
  return `rule-${nextId++}`;
}

interface RuleItem {
  id: string;
  text: string;
}

// ==================== 可拖拽规则项 ====================

interface SortableRuleItemProps {
  item: RuleItem;
  index: number;
  confirmingIndex: number | null;
  onChange: (index: number, value: string) => void;
  onBlur: () => void;
  onRemove: (index: number) => void;
}

function SortableRuleItem({ item, index, confirmingIndex, onChange, onBlur, onRemove }: SortableRuleItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.ruleItem} ${isDragging ? styles.ruleItemDragging : ''}`}
    >
      <button className={styles.ruleDragHandle} {...attributes} {...listeners}>
        <GripVertical size={14} />
      </button>
      <span className={styles.ruleIndex}>{index + 1}.</span>
      <input
        className={styles.ruleInput}
        value={item.text}
        onChange={(e) => onChange(index, e.target.value)}
        onBlur={onBlur}
      />
      <button
        className={`${styles.ruleRemoveBtn} ${confirmingIndex === index ? styles.ruleRemoveConfirm : ''}`}
        onClick={() => onRemove(index)}
        title={confirmingIndex === index ? '再次点击确认删除' : '删除此规则'}
      >
        {confirmingIndex === index ? <>确认?</> : <X size={14} />}
      </button>
    </div>
  );
}

// ==================== 红线规则面板 ====================

export default function RedLinesSection({ config }: Props) {
  const [items, setItems] = useState<RuleItem[]>(() =>
    config.red_lines.rules.map((text) => ({ id: generateId(), text })),
  );
  const [newRule, setNewRule] = useState('');
  const updateMutation = useUpdateRedLines();
  const itemsRef = useRef(items);
  const savedRef = useRef(config.red_lines.rules);

  useEffect(() => {
    const newItems = config.red_lines.rules.map((text) => ({ id: generateId(), text }));
    setItems(newItems);
    itemsRef.current = newItems;
    savedRef.current = config.red_lines.rules;
  }, [config.red_lines.rules]);

  const getRulesTexts = (list: RuleItem[]) => list.map((item) => item.text);

  const handleChange = (index: number, value: string) => {
    setItems((prev) => {
      const next = prev.map((item, i) => (i === index ? { ...item, text: value } : item));
      itemsRef.current = next;
      return next;
    });
  };

  const handleBlur = () => {
    const currentTexts = getRulesTexts(itemsRef.current);
    const dirty = currentTexts.some((r, i) => r !== savedRef.current[i]);
    if (!dirty) return;
    updateMutation.mutate({ rules: currentTexts });
  };

  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (confirmingIndex !== null) {
      confirmTimerRef.current = setTimeout(() => setConfirmingIndex(null), 3000);
      return () => clearTimeout(confirmTimerRef.current);
    }
  }, [confirmingIndex]);

  const handleRemove = useCallback(
    (index: number) => {
      if (confirmingIndex !== index) {
        setConfirmingIndex(index);
        return;
      }
      setConfirmingIndex(null);
      const updated = items.filter((_, i) => i !== index);
      setItems(updated);
      itemsRef.current = updated;
      updateMutation.mutate({ rules: getRulesTexts(updated) });
    },
    [confirmingIndex, items, updateMutation],
  );

  const handleAdd = () => {
    const trimmed = newRule.trim();
    if (!trimmed) return;
    const newItem: RuleItem = { id: generateId(), text: trimmed };
    const updated = [newItem, ...items];
    setItems(updated);
    itemsRef.current = updated;
    setNewRule('');
    updateMutation.mutate({ rules: getRulesTexts(updated) });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  // 拖拽排序
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((item) => item.id === active.id);
    const newIndex = items.findIndex((item) => item.id === over.id);
    const reordered = arrayMove(items, oldIndex, newIndex);

    setItems(reordered);
    itemsRef.current = reordered;
    updateMutation.mutate({ rules: getRulesTexts(reordered) });
  };

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          红线规则
          <span className={styles.rulesCount}>({items.length})</span>
        </h2>
        <p className={styles.sectionDesc}>
          AI 绝对不可违反的底线规则，将作为强制约束注入到系统提示词中
        </p>
      </div>

      <div className={styles.addRuleRow}>
        <input
          className={styles.addRuleInput}
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入新规则，按回车添加..."
        />
        <button className={styles.addRuleBtn} onClick={handleAdd} disabled={!newRule.trim()}>
          添加
        </button>
      </div>

      {items.length === 0 && (
        <div className={styles.emptyListState}>
          <Shield size={24} className={styles.emptyIcon} />
          <span>暂未设置红线规则</span>
          <span className={styles.emptyHint}>在上方输入框添加第一条规则</span>
        </div>
      )}

      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className={styles.rulesList}>
            {items.map((item, index) => (
              <SortableRuleItem
                key={item.id}
                item={item}
                index={index}
                confirmingIndex={confirmingIndex}
                onChange={handleChange}
                onBlur={handleBlur}
                onRemove={handleRemove}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
