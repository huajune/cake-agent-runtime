import type { ConversionHandoffResponse } from '@/api/types/conversion-analytics.types';
import { CHART_COLORS } from '../../types';
import styles from '../../styles/index.module.scss';

interface HandoffPieChartProps {
  data?: ConversionHandoffResponse;
  loading: boolean;
  standalone?: boolean;
}

export default function HandoffPieChart({
  data,
  loading,
  standalone = false,
}: HandoffPieChartProps) {
  const reasons = data?.reasons ?? [];
  const topReason = reasons[0];
  const donutSegments = buildDonutSegments(reasons);

  return (
    <section
      className={`${styles.panel} ${styles.handoffPanel} ${standalone ? styles.handoffStandalone : ''}`}
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.sectionKicker}>转人工原因</span>
          <h2>转人工原因榜单</h2>
          <span>按原因统计</span>
        </div>
        <div className={styles.panelTotal}>
          <span>转人工次数</span>
          <strong>{loading ? '-' : (data?.total ?? 0)}</strong>
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>加载中</div>
      ) : reasons.length > 0 ? (
        <>
          <div className={styles.handoffLayout}>
            <div className={styles.handoffChartCard}>
              <div className={styles.handoffDonutWrap}>
                <svg className={styles.handoffDonut} viewBox="0 0 240 240" aria-label="转人工原因占比图">
                  <circle className={styles.handoffDonutTrack} cx="120" cy="120" r="84" />
                  {donutSegments.map((segment) => (
                    <path
                      key={segment.key}
                      d={describeArc(120, 120, 84, segment.startAngle, segment.endAngle)}
                      fill="none"
                      stroke={segment.color}
                      strokeWidth="30"
                    />
                  ))}
                </svg>
                <div className={styles.handoffDonutCenter}>
                  <span>转人工</span>
                  <strong>{data?.total ?? 0}</strong>
                  <em>次</em>
                </div>
              </div>

              <div className={styles.handoffTopReason}>
                <span>主要原因</span>
                <strong>{reasonLabel(topReason.reasonCode, topReason.displayName)}</strong>
                <p>
                  {topReason.count} 次，占 {formatPercent(topReason.percent)}
                </p>
              </div>
            </div>

            <div className={styles.reasonList}>
              {reasons.map((item, index) => {
                const color = CHART_COLORS[index % CHART_COLORS.length];
                return (
                  <div key={item.reasonCode} className={styles.reasonRow}>
                    <span
                      className={styles.reasonRank}
                      style={{ background: `linear-gradient(135deg, ${color}, ${CHART_COLORS[(index + 1) % CHART_COLORS.length]})` }}
                    >
                      {index + 1}
                    </span>
                    <div className={styles.reasonContent}>
                      <div className={styles.reasonMeta}>
                        <strong>{reasonLabel(item.reasonCode, item.displayName)}</strong>
                        <em>{item.count} 次</em>
                      </div>
                      <div className={styles.reasonMeterRow}>
                        <div className={styles.reasonMeter}>
                          <i
                            style={{
                              width: `${Math.min(100, Math.max(item.percent * 100, item.count > 0 ? 4 : 0))}%`,
                              background: `linear-gradient(90deg, ${color}, ${CHART_COLORS[(index + 1) % CHART_COLORS.length]})`,
                            }}
                          />
                        </div>
                        <span>{formatPercent(item.percent)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <div className={styles.emptyState}>暂无转人工数据</div>
      )}
    </section>
  );
}

function formatPercent(value?: number) {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

function buildDonutSegments(reasons: ConversionHandoffResponse['reasons']) {
  let cursor = -90;
  return reasons
    .filter((item) => item.count > 0 && item.percent > 0)
    .map((item, index) => {
      const rawAngle = item.percent * 360;
      const startAngle = cursor;
      const endAngle = cursor + Math.max(rawAngle - 2, 1);
      cursor += rawAngle;
      return {
        key: item.reasonCode,
        color: CHART_COLORS[index % CHART_COLORS.length],
        startAngle,
        endAngle,
      };
    });
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function reasonLabel(reasonCode: string, fallback: string) {
  const labels: Record<string, string> = {
    cannot_find_store: '找不到候选人想去的门店',
    no_reception: '到店无人接待',
    booking_conflict: '预约时间冲突',
    onboarding_paperwork: '入职材料或办理问题',
    interview_result_inquiry: '候选人追问面试结果',
    modify_appointment: '改期或取消预约',
    self_recruited_or_completed: '已自招或已入职',
    no_match_or_group_full: '无匹配岗位/群满需维护',
    system_blocked: '工具/系统卡死',
    booking_capacity_full: '岗位报名人数已满',
    group_invite_failed: '拉群失败需人工维护',
    salary_admin_inquiry: '薪资/考勤/证明类咨询',
    interview_slot_coordination: '面试时段需人工协调',
    identity_age_exception: '身份/年龄边界需人工裁量',
    other: '其他原因',
  };
  return labels[reasonCode] ?? fallback;
}
