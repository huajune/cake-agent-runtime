import type {
  ConversionFunnelResponse,
  ConversionFunnelStage,
  ConversionMetricMode,
} from '@/api/types/conversion-analytics.types';
import type { CSSProperties } from 'react';
import heroArt from '@/assets/images/conversion-growth-hero.png';
import MetricModeTabs from '../MetricModeTabs';
import styles from '../../styles/index.module.scss';

interface CohortFunnelProps {
  data?: ConversionFunnelResponse;
  loading: boolean;
  mode: ConversionMetricMode;
  onModeChange: (mode: ConversionMetricMode) => void;
}

interface FunnelChartDatum extends ConversionFunnelStage {
  name: string;
  color: string;
  accent: string;
  value: number;
}

// 柔和马卡龙渐变：紫 → 蓝 → 青绿 → 粉 → 桃（参考玻璃碗漏斗）。
const FUNNEL_PALETTE = [
  { color: '#7c6ef2', accent: '#9d8bf8' },
  { color: '#56a6f4', accent: '#86c4f9' },
  { color: '#33d1bb', accent: '#6ce6d2' },
  { color: '#f5689f', accent: '#f99cc0' },
  { color: '#fb9d6b', accent: '#fdc197' },
  { color: '#a98bf4', accent: '#c4b2f8' },
];

// 漏斗形状参数：宽度大体跟随数值占比，但每层至少比上一层收窄 MIN_STEP，避免「直筒」；小值阶段有最小宽度。
const MIN_WIDTH_RATIO = 0.26;
const MIN_STEP = 0.14;

// 3D 漏斗几何（SVG 用户坐标）。
const VIEW_W = 360;
const CX = 180;
const TOP_PAD = 16;
const BODY_H = 58; // 顶层碗高度
const HEIGHT_STEP = 5; // 自上而下每层递减的高度（顶部最高，更像漏斗）
const GAP = 9; // 碗与碗之间的间隙
const MAX_HALF = 176; // 最宽阶段的半宽

export default function CohortFunnel({ data, loading, mode, onModeChange }: CohortFunnelProps) {
  const chartData: FunnelChartDatum[] = (data?.stages ?? []).map((stage, index) => {
    const palette = FUNNEL_PALETTE[index % FUNNEL_PALETTE.length];
    return {
      ...stage,
      name: stageLabel(stage.stage, stage.displayName),
      color: palette.color,
      accent: palette.accent,
      value: Math.max(stage.count, 0),
    };
  });
  const total = data?.totalCohort ?? 0;
  const cohortSubject = '新增好友';
  const cohortDescription = funnelDescription(mode, total, loading);

  const n = chartData.length;
  const widths = funnelWidths(chartData);
  // 各层 y 位置：自上而下逐层变矮（顶部最高），更像漏斗。
  const layout: Array<{ topY: number; height: number }> = [];
  let cursorY = TOP_PAD;
  for (let i = 0; i < n; i++) {
    const height = Math.max(34, BODY_H - i * HEIGHT_STEP);
    layout.push({ topY: cursorY, height });
    cursorY += height + GAP;
  }
  const viewH = cursorY - GAP + 18;

  return (
    <section className={`${styles.panel} ${styles.funnelPanel}`}>
      <img className={styles.funnelPanelArt} src={heroArt} alt="" aria-hidden="true" />
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.sectionKicker}>转化路径</span>
          <h2>{mode === 'period' ? '同一时段漏斗' : '批次转化漏斗'}</h2>
          <span>{cohortDescription}</span>
        </div>
        <MetricModeTabs mode={mode} onChange={onModeChange} label="漏斗口径" />
      </div>

      <div className={styles.funnelLayout}>
        <div className={styles.chartFrame}>
          {loading ? (
            <div className={styles.emptyState}>加载中</div>
          ) : n > 0 ? (
            <div className={styles.funnelShape}>
              <svg
                className={styles.funnelSvg}
                viewBox={`0 0 ${VIEW_W} ${viewH}`}
                width="100%"
                height="100%"
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label="批次转化漏斗图"
              >
                <defs>
                  {chartData.map((stage, index) => (
                    <linearGradient
                      key={stage.stage}
                      id={`funnel3d-${index}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor={shade(stage.color, 0.3)} />
                      <stop offset="55%" stopColor={stage.accent} />
                      <stop offset="100%" stopColor={stage.color} />
                    </linearGradient>
                  ))}
                  <linearGradient id="funnelGloss" x1="0.18" y1="0" x2="0.62" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
                    <stop offset="14%" stopColor="#ffffff" stopOpacity="0.1" />
                    <stop offset="42%" stopColor="#ffffff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {chartData.map((stage, index) => {
                  const topR = widths[index] * MAX_HALF;
                  const botR = (index < n - 1 ? widths[index + 1] : widths[index] * 0.7) * MAX_HALF;
                  const topRy = ellipseRy(topR);
                  const botRy = ellipseRy(botR);
                  const { topY, height } = layout[index];
                  const botY = topY + height;
                  const body = [
                    `M ${(CX - topR).toFixed(1)} ${topY}`,
                    `A ${topR.toFixed(1)} ${topRy.toFixed(1)} 0 0 0 ${(CX + topR).toFixed(1)} ${topY}`,
                    `L ${(CX + botR).toFixed(1)} ${botY}`,
                    `A ${botR.toFixed(1)} ${botRy.toFixed(1)} 0 0 1 ${(CX - botR).toFixed(1)} ${botY}`,
                    'Z',
                  ].join(' ');
                  return (
                    <g key={stage.stage}>
                      <title>{`${stage.name} ${stage.count}人 · 总体 ${formatPercent(stage.overallRate)} · 阶段 ${formatPercent(stage.stageRate)}`}</title>
                      <path
                        d={body}
                        fill={`url(#funnel3d-${index})`}
                        stroke="rgba(255,255,255,0.5)"
                        strokeWidth={1}
                      />
                      <path d={body} fill="url(#funnelGloss)" />
                      <ellipse
                        cx={CX}
                        cy={topY}
                        rx={topR}
                        ry={topRy}
                        fill={shade(stage.color, 0.3)}
                      />
                      <ellipse
                        cx={CX}
                        cy={topY + topRy * 0.22}
                        rx={topR * 0.9}
                        ry={topRy * 0.84}
                        fill={stage.accent}
                      />
                      <text x={CX} y={topY + height * 0.5 - 3} className={styles.funnelSvgLabel}>
                        <tspan x={CX}>{stage.name}</tspan>
                        <tspan x={CX} dy="13" className={styles.funnelSvgSub}>
                          {stage.count}人 · {formatPercent(stage.stageRate)}
                        </tspan>
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          ) : (
            <div className={styles.emptyState}>暂无数据</div>
          )}
        </div>

        <div className={styles.stageStack}>
          <div className={styles.stageLegend}>
            两个百分比：
            <b className={styles.legendOverall}>占总数</b>（这一级 ÷ {cohortSubject}总数，看整体留存）
            <span className={styles.legendSlash}>/</span>
            <b className={styles.legendStage}>阶段率</b>（这一级 ÷ 上一步，看单步转化）
          </div>
          <div className={styles.stageHead} aria-hidden="true">
            <span>转化阶段</span>
            <span>整体留存进度</span>
            <span className={styles.stageHeadMetrics}>
              人数 · <em className={styles.legendOverall}>占总数</em> /{' '}
              <em className={styles.legendStage}>阶段率</em>
            </span>
          </div>
          {chartData.map((stage, index) => (
            <div
              key={stage.stage}
              className={styles.stageRow}
              style={{ '--stage-tone': stage.color } as CSSProperties}
            >
              <div className={styles.stageLabel}>
                <span
                  style={{ background: `linear-gradient(135deg, ${stage.color}, ${stage.accent})` }}
                >
                  {index + 1}
                </span>
                <strong>{stage.name}</strong>
              </div>
              <div className={styles.stageMeter}>
                <i
                  style={{
                    width: `${Math.min(100, Math.max(stage.overallRate * 100, stage.count > 0 ? 4 : 0))}%`,
                    background: `linear-gradient(90deg, ${stage.color}, ${stage.accent})`,
                  }}
                />
              </div>
              <div className={styles.stageMetrics}>
                <strong>{stage.count}</strong>
                <span title={metricTooltip(stage, total, cohortSubject)}>
                  <em className={styles.legendOverall}>{formatPercent(stage.overallRate)}</em> /{' '}
                  <em className={styles.legendStage}>{formatPercent(stage.stageRate)}</em>
                </span>
              </div>
            </div>
          ))}
          {!loading && (data?.stages.length ?? 0) === 0 ? (
            <div className={styles.emptyState}>暂无阶段数据</div>
          ) : null}
        </div>
      </div>

      <p className={styles.funnelNote}>{funnelNote(mode, cohortSubject)}</p>
    </section>
  );
}

// 计算每层宽度比例：跟随数值占比，但强制逐层至少收窄 MIN_STEP（杜绝直筒），并带最小宽度。
function funnelWidths(stages: FunnelChartDatum[]): number[] {
  const base = stages[0]?.value || 1;
  const widths: number[] = [];
  let prev = 1;
  stages.forEach((stage, index) => {
    if (index === 0) {
      widths.push(1);
      prev = 1;
      return;
    }
    const raw = Math.max(MIN_WIDTH_RATIO, Math.min(1, stage.value / base));
    const w = Math.max(MIN_WIDTH_RATIO * 0.72, Math.min(raw, prev - MIN_STEP));
    widths.push(w);
    prev = w;
  });
  return widths;
}

// 椭圆碗口纵向半径：随宽度成比例（窄层更扁），保持自然的透视厚度。
function ellipseRy(rx: number): number {
  return Math.min(15, Math.max(5, rx * 0.16));
}

// 把十六进制色向白(pct>0)或黑(pct<0)混合，用于做体积明暗。
function shade(hex: string, pct: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const target = pct < 0 ? 0 : 255;
  const p = Math.abs(pct);
  const mix = (c: number) => Math.round((target - c) * p + c);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function formatPercent(value?: number) {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

// 鼠标悬停在两个百分比上时的解释，帮运营理解口径。
function metricTooltip(stage: ConversionFunnelStage, total: number, subject: string): string {
  return [
    `占总数 ${formatPercent(stage.overallRate)}：${stage.count} ÷ ${total}（${subject}总数），看从头到此还剩多少人`,
    `阶段率 ${formatPercent(stage.stageRate)}：相对上一阶段的转化率（邀请进群、报名的分母均为破冰）`,
  ].join('\n');
}

function stageLabel(stage: string, fallback: string) {
  const labels: Record<string, string> = {
    friend_added: '新增好友',
    break_ice: '破冰',
    booking: '报名',
    group_invite: '邀请进群',
    interview_pass: '面试通过',
  };
  return labels[stage] ?? fallback;
}

function funnelDescription(mode: ConversionMetricMode, total: number, loading: boolean) {
  if (mode === 'period') {
    return loading || total === 0
      ? '查看本时间段内各阶段发生量'
      : `本时间段 ${total} 位新增好友对应的阶段发生量`;
  }
  return loading || total === 0
    ? '追踪本期新增好友这同一批人的后续进展'
    : `追踪本期 ${total} 位新增好友这同一批人的后续进展`;
}

function funnelNote(mode: ConversionMetricMode, subject: string) {
  if (mode === 'period') {
    return '口径：同一时段发生量快照。新增好友、破冰、邀请进群、报名、面试通过分别取本时间窗内去重事件（均按人去重）；邀请进群是破冰后的运营侧支，阶段率分母=破冰，不进入线性单调链。注意：各阶段独立计数，下游可能超过上一阶段（如窗口外加的好友在本期破冰/报名），故本图非严格收口漏斗、阶段率可能 >100%；如需「同一批人逐级 ⊆」请切到同批追踪。';
  }

  return `口径：以本期${subject}为同一批人逐级追踪（按人去重、线性阶段每级 ⊆ 上一级，比率天然 ≤100%）。邀请进群是破冰后的运营侧支，阶段率分母=破冰，不影响报名阶段分母；无入职级。注意：下游只统计落在所选时间窗内的事件，越靠近今天的批次后续转化可能尚未发生（右侧截断），近几日数值偏低属正常；时间窗越长该影响越小。`;
}
