import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import { useReengagementWeeklyFunnel } from '@/hooks/reengagement/useReengagementRecords';
import styles from './index.module.scss';

/** 周度漏斗最小展示：登记 → 发出 → 6h 回复 + 回复率；后端默认最近 8 周。 */
export default function WeeklyFunnel() {
  const { data, isLoading, isError } = useReengagementWeeklyFunnel();

  // 最近一周排最前，方便运营看当周
  const rows = useMemo(() => [...(data ?? [])].reverse(), [data]);

  const formatRate = (rate: number | null) =>
    rate == null ? '-' : `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h3 className={styles.title}>
          <TrendingUp aria-hidden="true" size={15} />
          周度漏斗
        </h3>
        <span
          className={styles.note}
          title="登记 = 该周创建的复聊任务（不含「不适用」底账）；发出 = 其中已投递；6h 回复 = 投递后 6 小时内候选人有消息。按任务创建周归组（周一起算）。"
        >
          登记 → 发出 → 6h 内回复 · 最近 8 周
        </span>
      </div>

      {isError ? (
        <div className={styles.empty}>漏斗数据加载失败</div>
      ) : isLoading ? (
        <div className={styles.empty}>加载中...</div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>暂无数据</div>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>周（周一）</th>
                <th className={styles.thRight}>登记</th>
                <th className={styles.thRight}>发出</th>
                <th className={styles.thRight}>6h 回复</th>
                <th className={styles.thRight}>回复率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.weekStart}>
                  <td className={styles.weekCell}>{row.weekStart}</td>
                  <td className={styles.cellRight}>{row.registered}</td>
                  <td className={styles.cellRight}>{row.sent}</td>
                  <td className={styles.cellRight}>{row.replied6h}</td>
                  <td className={`${styles.cellRight} ${styles.rateCell}`}>
                    {formatRate(row.replyRate)}
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
