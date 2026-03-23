import { useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, History, Loader2, ChevronDown, ChevronRight, RotateCcw, Clock, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import * as strategyService from '@/api/services/strategy.service';
import type { StrategyChangelogRecord } from '@/api/types/strategy.types';
import styles from './index.module.scss';

const FIELD_META: Record<string, { label: string; color: string }> = {
  persona: { label: '人格设定', color: '#a78bfa' },
  stage_goals: { label: '阶段目标', color: '#f472b6' },
  red_lines: { label: '政策红线', color: '#fb923c' },
};

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChangelogModal({ isOpen, onClose }: ChangelogModalProps) {
  if (!isOpen) return null;
  return createPortal(<ChangelogModalContent onClose={onClose} />, document.body);
}

/** 提取可读的变更摘要 */
function summarizeChange(field: string, oldVal: unknown, newVal: unknown): string {
  try {
    const oldStr = JSON.stringify(oldVal);
    const newStr = JSON.stringify(newVal);
    const diffLen = newStr.length - oldStr.length;
    const prefix = FIELD_META[field]?.label || field;
    if (diffLen > 0) return `${prefix} 内容增加了 ${diffLen} 字符`;
    if (diffLen < 0) return `${prefix} 内容减少了 ${Math.abs(diffLen)} 字符`;
    return `${prefix} 内容已修改`;
  } catch {
    return '配置已变更';
  }
}

/** 检测是否为 {label, value} 模式的条目（用于 persona textDimensions 等） */
function isLabelValueItem(item: unknown): item is { label: string; value: unknown; key?: string } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'label' in item &&
    'value' in item &&
    typeof (item as Record<string, unknown>).label === 'string'
  );
}

/** 将任意值递归渲染为人类可读内容 */
function renderValue(value: unknown, depth = 0): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className={styles.nullValue}>（空）</span>;
  }

  if (typeof value === 'string') {
    return <p className={styles.textValue}>{value}</p>;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className={styles.textValue}>{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.nullValue}>（空列表）</span>;

    // label+value 模式 → 渲染为带标题的段落（如 persona.textDimensions）
    if (value.every(isLabelValueItem)) {
      return (
        <div className={styles.lvList}>
          {value.map((item, i) => (
            <div key={(item as { key?: string }).key ?? i} className={styles.lvItem}>
              <div className={styles.lvLabel}>{item.label}</div>
              <div className={styles.lvValue}>{renderValue(item.value, depth + 1)}</div>
            </div>
          ))}
        </div>
      );
    }

    // 普通列表（字符串/数字/混合）
    return (
      <ul className={styles.listValue}>
        {value.map((item, i) => (
          <li key={i} className={styles.listItem}>
            {typeof item === 'object' && item !== null
              ? renderValue(item, depth + 1)
              : String(item)}
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return <span className={styles.nullValue}>（空对象）</span>;

    // 只有一个 value 字段时直接展开（简单包装对象）
    if (entries.length === 1) {
      return renderValue(entries[0][1], depth);
    }

    return (
      <dl className={styles.dictValue}>
        {entries.map(([k, v]) => (
          <div key={k} className={`${styles.dictRow} ${depth > 0 ? styles.dictRowNested : ''}`}>
            <dt className={styles.dictKey}>{k}</dt>
            <dd className={styles.dictVal}>{renderValue(v, depth + 1)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span className={styles.textValue}>{String(value)}</span>;
}

function ChangelogModalContent({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const { data: logs, isLoading } = useQuery({
    queryKey: ['strategy-changelog'],
    queryFn: () => strategyService.getChangelog(30),
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const handleToggleDiff = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleRollback = useCallback(
    async (log: StrategyChangelogRecord) => {
      if (confirmingId !== log.id) {
        setConfirmingId(log.id);
        setTimeout(() => setConfirmingId((prev) => (prev === log.id ? null : prev)), 3000);
        return;
      }

      setRollingBack(true);
      try {
        await strategyService.rollbackConfig(log.field, log.old_value);
        queryClient.invalidateQueries({ queryKey: ['strategy-config'] });
        queryClient.invalidateQueries({ queryKey: ['strategy-changelog'] });
        toast.success(`已回滚「${FIELD_META[log.field]?.label}」到变更前状态`);
        setConfirmingId(null);
      } catch {
        toast.error('回滚失败，请重试');
      } finally {
        setRollingBack(false);
      }
    },
    [confirmingId, queryClient],
  );

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return isToday ? `今天 ${time}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
  };

  // 按日期分组
  const grouped = useMemo(() => {
    if (!logs?.length) return [];
    const groups: { date: string; items: StrategyChangelogRecord[] }[] = [];
    let currentDate = '';
    for (const log of logs) {
      const d = new Date(log.changed_at);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (dateStr !== currentDate) {
        currentDate = dateStr;
        groups.push({ date: dateStr, items: [] });
      }
      groups[groups.length - 1].items.push(log);
    }
    return groups;
  }, [logs]);

  const formatDateHeader = (dateStr: string) => {
    const today = new Date();
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    if (target.toDateString() === today.toDateString()) return '今天';
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (target.toDateString() === yesterday.toDateString()) return '昨天';
    return `${m}月${d}日`;
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        {/* 装饰 */}
        <div className={styles.decorCircle1} />
        <div className={styles.decorCircle2} />

        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}>
              <History size={18} />
            </div>
            <div>
              <h3>变更记录</h3>
              <p className={styles.headerSub}>策略配置的修改历史与回滚入口</p>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.body}>
          {isLoading ? (
            <div className={styles.empty}>
              <Loader2 size={24} className={styles.spinIcon} />
              <span>加载中...</span>
            </div>
          ) : !logs?.length ? (
            <div className={styles.empty}>
              <div className={styles.emptyIconWrap}>
                <FileText size={28} />
              </div>
              <span className={styles.emptyTitle}>暂无变更记录</span>
              <span className={styles.emptyHint}>修改策略配置后，变更历史会自动记录在这里</span>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.date} className={styles.dateGroup}>
                <div className={styles.dateHeader}>
                  <Clock size={12} />
                  {formatDateHeader(group.date)}
                </div>
                {group.items.map((log) => {
                  const meta = FIELD_META[log.field] || { label: log.field, color: '#94a3b8' };
                  const isExpanded = expandedId === log.id;
                  const isConfirming = confirmingId === log.id;

                  return (
                    <div
                      key={log.id}
                      className={`${styles.logItem} ${isExpanded ? styles.logItemExpanded : ''}`}
                    >
                      <div className={styles.logMain} onClick={() => handleToggleDiff(log.id)}>
                        <div className={styles.logLeft}>
                          <span
                            className={styles.fieldBadge}
                            style={{ background: `${meta.color}18`, color: meta.color, borderColor: `${meta.color}30` }}
                          >
                            {meta.label}
                          </span>
                          <span className={styles.logSummary}>
                            {summarizeChange(log.field, log.old_value, log.new_value)}
                          </span>
                        </div>
                        <div className={styles.logRight}>
                          <span className={styles.logTime}>{formatTime(log.changed_at)}</span>
                          <button
                            className={`${styles.rollbackBtn} ${isConfirming ? styles.rollbackConfirm : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRollback(log);
                            }}
                            disabled={rollingBack}
                          >
                            <RotateCcw size={12} />
                            {isConfirming ? '确认回滚?' : '回滚'}
                          </button>
                          <span className={styles.expandIcon}>
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </span>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className={styles.diffSection}>
                          <div className={styles.diffCol}>
                            <div className={`${styles.diffHeader} ${styles.diffHeaderOld}`}>
                              <span className={styles.diffDot} />
                              变更前
                            </div>
                            <div className={styles.diffContent}>
                              {renderValue(log.old_value)}
                            </div>
                          </div>
                          <div className={styles.diffDivider} />
                          <div className={styles.diffCol}>
                            <div className={`${styles.diffHeader} ${styles.diffHeaderNew}`}>
                              <span className={styles.diffDot} />
                              变更后
                            </div>
                            <div className={styles.diffContent}>
                              {renderValue(log.new_value)}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
