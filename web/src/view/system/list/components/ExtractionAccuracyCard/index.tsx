import { useExtractionAccuracy } from '@/hooks/analytics/useExtractionAccuracy';
import type { ExtractionAccuracyField } from '@/api/types/monitoring.types';
import styles from './index.module.scss';

const DAYS_OPTIONS = [7, 14, 30] as const;

const FIELD_LABELS: Record<string, string> = {
  name: '姓名',
  phone: '手机号',
  age: '年龄',
  gender: '性别',
};

interface ExtractionAccuracyCardProps {
  days: number;
  onDaysChange: (days: number) => void;
}

export default function ExtractionAccuracyCard({
  days,
  onDaysChange,
}: ExtractionAccuracyCardProps) {
  const { data, isLoading, isError } = useExtractionAccuracy(days);
  const fields = data?.fields ?? [];

  return (
    <section className={styles.card}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>提取质量对账</h2>
          <p className={styles.subtitle}>
            真值=报名提交字段；提取值=报名前最近一轮记忆快照；覆盖率低=靠现收、准确率低=提取在污染预填
          </p>
        </div>
        <div className={styles.daysTabs} role="tablist" aria-label="统计天数">
          {DAYS_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={days === option}
              className={`${styles.daysTab} ${days === option ? styles.daysTabActive : ''}`}
              onClick={() => onDaysChange(option)}
            >
              {option}天
            </button>
          ))}
        </div>
      </div>

      {isError && fields.length === 0 ? (
        <div className={styles.error}>对账数据加载失败，请稍后重试</div>
      ) : isLoading && fields.length === 0 ? (
        <div className={styles.empty}>加载中</div>
      ) : fields.length === 0 ? (
        <div className={styles.empty}>该时间窗内暂无对账样本（需新版 booking 事件）</div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.fieldCol}>字段</th>
                <th className={styles.numCol}>样本数</th>
                <th className={styles.numCol}>覆盖率</th>
                <th className={styles.numCol}>准确率</th>
                <th className={styles.numCol}>高置信准确率</th>
                <th className={styles.numCol}>错配数</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.field}>
                  <td className={styles.fieldCol}>{FIELD_LABELS[field.field] ?? field.field}</td>
                  <td className={styles.numCol}>{field.bookings.toLocaleString('zh-CN')}</td>
                  <td className={styles.numCol}>
                    <span className={rateClass(field.coveragePct)}>
                      {formatPercent(field.coveragePct)}
                    </span>
                  </td>
                  <td className={styles.numCol}>
                    <span className={rateClass(field.accuracyPct)}>
                      {formatPercent(field.accuracyPct)}
                    </span>
                  </td>
                  <td className={styles.numCol}>
                    <span className={rateClass(field.highConfAccuracyPct)}>
                      {formatPercent(field.highConfAccuracyPct)}
                    </span>
                    <span className={styles.subValue}>
                      n={field.highConf.toLocaleString('zh-CN')}
                    </span>
                  </td>
                  <td className={styles.numCol}>
                    <span className={field.mismatches > 0 ? styles.mismatch : undefined}>
                      {field.mismatches.toLocaleString('zh-CN')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${value.toFixed(1)}%`;
}

function rateClass(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return styles.rateMuted;
  }
  if (value >= 90) return styles.rateGood;
  if (value >= 70) return styles.rateWarn;
  return styles.rateBad;
}

export type { ExtractionAccuracyField };
