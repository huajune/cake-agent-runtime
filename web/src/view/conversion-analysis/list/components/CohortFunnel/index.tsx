import type {
  ConversionFunnelResponse,
  ConversionFunnelStage,
  ConversionMetricMode,
} from '@/api/types/conversion-analytics.types';
import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BadgeCheck,
  CalendarCheck2,
  MessageCircle,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';
import heroArt from '@/assets/images/conversion-growth-hero.png';
import MetricModeTabs from '../MetricModeTabs';
import styles from '../../styles/index.module.scss';

interface CohortFunnelProps {
  data?: ConversionFunnelResponse;
  loading: boolean;
  mode: ConversionMetricMode;
  maturityDays: number;
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

// 小人占比图的图标个数（参考信息图：填充个数 = 占总数比例）。
const CROWD_SIZE = 8;

// 3D 漏斗几何（SVG 用户坐标）。
// 参考 3D 渲染图：层宽是「等比收窄的纯装饰几何」而非数据比例（数据由标签与右侧卡片承载），
// 上一层碗底 = 下一层碗口，层层嵌套成连续漏斗轮廓。
const VIEW_W = 360;
const CX = 180;
const TOP_PAD = 10;
const BODY_H = 94; // 顶层碗高度
const HEIGHT_STEP = 6; // 自上而下每层递减的高度
const OVERLAP = 5; // 下一层碗口嵌进上一层碗底的深度
const MAX_HALF = 172; // 顶层碗口半宽
const SHRINK = 0.8; // 每层收窄比例
const RY_RATIO = 0.25; // 碗口椭圆纵横比（略俯视，能看到顶层碗腔）

// 碗内白色图标（参考渲染图的「图标 + 01 阶段名」排版）。
const STAGE_ICONS: Record<string, LucideIcon> = {
  friend_added: UserPlus,
  break_ice: MessageCircle,
  group_invite: Users,
  booking: CalendarCheck2,
  interview_pass: BadgeCheck,
};

// 顶碗撒糖装饰：位置（相对碗腔中心的比例坐标）、旋转角、颜色索引，全部确定值避免重渲染抖动。
const SPRINKLES: Array<[number, number, number, number]> = [
  [-0.55, -0.2, 24, 0],
  [-0.3, 0.35, -18, 1],
  [-0.05, -0.4, 65, 2],
  [0.2, 0.3, 12, 3],
  [0.45, -0.15, -40, 4],
  [0.62, 0.25, 30, 5],
  [-0.72, 0.18, -55, 3],
  [0.05, 0.05, 80, 1],
  [0.32, -0.45, -12, 5],
  [-0.18, -0.05, 40, 4],
];
const SPRINKLE_COLORS = ['#f9a8d4', '#fcd34d', '#86efac', '#93c5fd', '#fda4af', '#c4b5fd'];

export default function CohortFunnel({
  data,
  loading,
  mode,
  maturityDays,
  onModeChange,
}: CohortFunnelProps) {
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
  const cohortDescription = funnelDescription(mode, total, loading, maturityDays);

  const n = chartData.length;
  // 层边界半宽：等比收窄；layer i 的碗口 = boundaries[i]，碗底 = boundaries[i+1]。
  const boundaries = Array.from({ length: n + 1 }, (_, i) => MAX_HALF * Math.pow(SHRINK, i));
  const layout: Array<{ topY: number; height: number }> = [];
  let cursorY = TOP_PAD + boundaries[0] * RY_RATIO;
  for (let i = 0; i < n; i++) {
    const height = Math.max(40, BODY_H - i * HEIGHT_STEP);
    layout.push({ topY: cursorY, height });
    cursorY += height - OVERLAP;
  }
  const funnelBottom = cursorY + OVERLAP;
  const viewH = funnelBottom + 34;
  // 嵌套堆叠：先画下层再画上层，让上层碗体压住下层碗口的衔接处。
  const paintOrder = chartData.map((stage, index) => ({ stage, index })).reverse();

  return (
    <section className={`${styles.panel} ${styles.funnelPanel}`}>
      <img className={styles.funnelPanelArt} src={heroArt} alt="" aria-hidden="true" />
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.sectionKicker}>转化路径</span>
          <h2>{mode === 'period' ? '同一时段阶段发生量' : '成熟批次转化漏斗'}</h2>
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
                      x2="1"
                      y2="0"
                    >
                      <stop offset="0%" stopColor={shade(stage.color, 0.26)} />
                      <stop offset="34%" stopColor={shade(stage.color, 0.4)} />
                      <stop offset="62%" stopColor={stage.accent} />
                      <stop offset="100%" stopColor={shade(stage.color, -0.08)} />
                    </linearGradient>
                  ))}
                  <linearGradient id="funnelGloss" x1="0.2" y1="0" x2="0.66" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
                    <stop offset="18%" stopColor="#ffffff" stopOpacity="0.16" />
                    <stop offset="46%" stopColor="#ffffff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id="funnelGround" cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0%" stopColor="#0f172a" stopOpacity="0.16" />
                    <stop offset="70%" stopColor="#0f172a" stopOpacity="0.05" />
                    <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="funnelPedestal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="100%" stopColor="#eef0fa" />
                  </linearGradient>
                  <radialGradient id="funnelSphereA" cx="0.35" cy="0.3" r="0.8">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="58%" stopColor="#e4e7fb" />
                    <stop offset="100%" stopColor="#c9cff6" />
                  </radialGradient>
                  <radialGradient id="funnelSphereB" cx="0.35" cy="0.3" r="0.8">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="58%" stopColor="#fdebd2" />
                    <stop offset="100%" stopColor="#f8d6a4" />
                  </radialGradient>
                  <filter id="funnelSeam" x="-20%" y="-120%" width="140%" height="340%">
                    <feGaussianBlur stdDeviation="2.6" />
                  </filter>
                  <marker
                    id="funnelArrowHead"
                    viewBox="0 0 8 8"
                    refX="6"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L8 4 L0 8 z" fill="#a5b4fc" />
                  </marker>
                  <clipPath id="funnelCavityClip">
                    <ellipse
                      cx={CX}
                      cy={layout[0].topY + boundaries[0] * RY_RATIO * 0.14}
                      rx={boundaries[0] * 0.85}
                      ry={boundaries[0] * RY_RATIO * 0.76}
                    />
                  </clipPath>
                </defs>
                {/* 氛围装饰：漂浮小球 + 左侧虚线弧线箭头（参考渲染图构图） */}
                <circle
                  cx={20}
                  cy={layout[Math.min(2, n - 1)].topY + 4}
                  r={12}
                  fill="url(#funnelSphereA)"
                  opacity={0.85}
                />
                <circle
                  cx={30}
                  cy={funnelBottom - 26}
                  r={10}
                  fill="url(#funnelSphereB)"
                  opacity={0.9}
                />
                <circle
                  cx={340}
                  cy={funnelBottom - 64}
                  r={8}
                  fill="url(#funnelSphereA)"
                  opacity={0.8}
                />
                <path
                  d={`M 42 ${layout[Math.min(1, n - 1)].topY + 6} C 10 ${layout[Math.min(1, n - 1)].topY + 86}, 12 ${funnelBottom - 96}, 48 ${funnelBottom - 18}`}
                  fill="none"
                  stroke="#a5b4fc"
                  strokeWidth={1.6}
                  strokeDasharray="5 6"
                  markerEnd="url(#funnelArrowHead)"
                  opacity={0.8}
                />
                {/* 底座圆盘 + 投影（参考渲染图的展示台） */}
                <ellipse
                  cx={CX}
                  cy={funnelBottom + 18}
                  rx={boundaries[n] * 3.1}
                  ry={15}
                  fill="url(#funnelGround)"
                />
                <ellipse
                  cx={CX}
                  cy={funnelBottom + 9}
                  rx={boundaries[n] * 2.6}
                  ry={12}
                  fill="url(#funnelPedestal)"
                  stroke="rgba(15, 23, 42, 0.06)"
                  strokeWidth={1}
                />
                {/* 底座上的撒糖点缀 */}
                {[
                  [-2.1, 4, -30, 0],
                  [-1.4, 8, 20, 2],
                  [1.2, 7, 50, 4],
                  [1.9, 3, -15, 1],
                  [0.4, 10, 70, 5],
                ].map(([dx, dy, rot, c], i) => (
                  <rect
                    key={`pedestal-sprinkle-${i}`}
                    x={-3}
                    y={-1.2}
                    width={6}
                    height={2.4}
                    rx={1.2}
                    fill={SPRINKLE_COLORS[c]}
                    transform={`translate(${CX + dx * boundaries[n]} ${funnelBottom + dy}) rotate(${rot})`}
                  />
                ))}
                {paintOrder.map(({ stage, index }) => {
                  // 碗口宽度不外扩：外扩会让下层碗口在衔接处两侧露出"翘角"
                  // （上层碗壁斜率在该高度只能遮住 ~5px 的嵌入量）
                  const topR = boundaries[index];
                  const botR = boundaries[index + 1];
                  const topRy = topR * RY_RATIO;
                  const botRy = botR * RY_RATIO;
                  const { topY, height } = layout[index];
                  const botY = topY + height;
                  const body = [
                    `M ${(CX - topR).toFixed(1)} ${topY}`,
                    `A ${topR.toFixed(1)} ${topRy.toFixed(1)} 0 0 0 ${(CX + topR).toFixed(1)} ${topY}`,
                    `L ${(CX + botR).toFixed(1)} ${botY}`,
                    `A ${botR.toFixed(1)} ${botRy.toFixed(1)} 0 0 1 ${(CX - botR).toFixed(1)} ${botY}`,
                    'Z',
                  ].join(' ');
                  const isTop = index === 0;
                  // 未知阶段没有内置图标，纯文字渲染
                  const Icon = stage.stage in STAGE_ICONS ? STAGE_ICONS[stage.stage] : undefined;
                  const iconSize = 26;
                  const iconGap = Icon ? iconSize + 12 : 0;
                  // 图标固定列靠左对齐：四层共用同一左起点，避免随标题长度横向乱跳。
                  // 起点以最窄的底层碗为约束（底层半宽 ~88，内容区 ±79 内放得下）。
                  const startX = CX - 72;
                  // 在"可见色带"内垂直居中：上边界 = 顶层碗腔底缘 / 上一层碗体下垂弧的最低点，
                  // 下边界 = 本层碗底下垂弧的最低点。直接用几何高度会让文字整体偏高 ~16px。
                  const bandTop =
                    topY + (isTop ? topRy * 0.95 : OVERLAP + boundaries[index] * RY_RATIO);
                  const bandBottom = topY + height + boundaries[index + 1] * RY_RATIO;
                  const centerY = (bandTop + bandBottom) / 2 - 2;
                  return (
                    <g
                      key={stage.stage}
                      className={styles.funnelLayer}
                      style={{ '--i': index } as CSSProperties}
                    >
                      <title>{`${stage.name} ${stage.count}人 · 总体 ${formatPercent(stage.overallRate)} · 阶段 ${formatPercent(stage.stageRate)}`}</title>
                      <path
                        d={body}
                        fill={`url(#funnel3d-${index})`}
                        stroke="rgba(255,255,255,0.55)"
                        strokeWidth={1}
                      />
                      <path d={body} fill="url(#funnelGloss)" />
                      {/* 碗口：顶层画完整碗腔；下层只画下垂的唇边高光弧——
                          完整椭圆的上半弧会翘出衔接线，在接缝两侧形成怪异的"上翘月牙" */}
                      {isTop ? (
                        <>
                          <ellipse
                            cx={CX}
                            cy={topY}
                            rx={topR}
                            ry={topRy}
                            fill={shade(stage.color, 0.34)}
                          />
                          <ellipse
                            cx={CX}
                            cy={topY + topRy * 0.14}
                            rx={topR * 0.88}
                            ry={topRy * 0.8}
                            fill={shade(stage.color, -0.06)}
                          />
                          <ellipse
                            cx={CX}
                            cy={topY + topRy * 0.3}
                            rx={topR * 0.74}
                            ry={topRy * 0.62}
                            fill={shade(stage.color, 0.08)}
                          />
                          {/* 顶碗撒糖 */}
                          <g clipPath="url(#funnelCavityClip)">
                            {SPRINKLES.map(([dx, dy, rot, c], i) => (
                              <rect
                                key={`sprinkle-${i}`}
                                x={-3.5}
                                y={-1.4}
                                width={7}
                                height={2.8}
                                rx={1.4}
                                fill={SPRINKLE_COLORS[c]}
                                transform={`translate(${CX + dx * topR * 0.78} ${topY + topRy * 0.18 + dy * topRy * 0.66}) rotate(${rot})`}
                              />
                            ))}
                          </g>
                        </>
                      ) : (
                        <>
                          {/* 唇边高光：沿碗口前缘的下垂弧线 */}
                          <path
                            d={`M ${(CX - topR).toFixed(1)} ${topY} A ${topR.toFixed(1)} ${topRy.toFixed(1)} 0 0 0 ${(CX + topR).toFixed(1)} ${topY}`}
                            fill="none"
                            stroke={shade(stage.color, 0.42)}
                            strokeWidth={5}
                            strokeLinecap="round"
                            opacity={0.9}
                          />
                          {/* 上一层碗体投下的柔和阴影缝隙 */}
                          <ellipse
                            cx={CX}
                            cy={topY + OVERLAP + 3}
                            rx={topR * 0.92}
                            ry={6.5}
                            fill="rgba(15, 23, 42, 0.85)"
                            opacity={0.14}
                            filter="url(#funnelSeam)"
                          />
                        </>
                      )}
                      {/* 碗内排版：白色图标 + 大号「0X 阶段名」+ 副标签（参考渲染图）。
                          图标与「标题+副标签」整个文字块垂直居中（块视觉中心 ≈ centerY+1）。 */}
                      {Icon ? (
                        <Icon
                          x={startX}
                          y={centerY + 1 - iconSize / 2}
                          width={iconSize}
                          height={iconSize}
                          color="#ffffff"
                          strokeWidth={2.4}
                          aria-hidden="true"
                        />
                      ) : null}
                      <text
                        x={startX + iconGap}
                        y={centerY - 2}
                        textAnchor="start"
                        className={styles.funnelBowlTitle}
                      >
                        <tspan className={styles.funnelBowlNo}>{`0${index + 1}`}</tspan>
                        <tspan dx="7">{stage.name}</tspan>
                      </text>
                      <text
                        x={startX + iconGap}
                        y={centerY + 17}
                        textAnchor="start"
                        className={styles.funnelBowlSub}
                      >
                        {stage.count}人 · {formatPercent(stage.stageRate)}
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
          {chartData.map((stage, index) => {
            // 非零阶段至少点亮 1 个小人，避免低比率档位看起来"全灭"。
            const filled =
              stage.overallRate > 0
                ? Math.max(1, Math.round(Math.min(1, stage.overallRate) * CROWD_SIZE))
                : 0;
            return (
              <div
                key={stage.stage}
                className={styles.stageCard}
                style={{ '--stage-tone': stage.color, '--i': index } as CSSProperties}
              >
                <span className={styles.stageCardLabel}>
                  <em>{String(index + 1).padStart(2, '0')}</em>
                  {stageCaption(stage.stage, stage.name)}
                </span>
                <div className={styles.stageCardBody}>
                  <strong
                    className={styles.stageCardRate}
                    title={`占总数 ${formatPercent(stage.overallRate)}：${stage.count} ÷ ${total}（${cohortSubject}总数）`}
                  >
                    {formatPercent(stage.overallRate)}
                  </strong>
                  <span className={styles.stageCrowd} aria-hidden="true">
                    {Array.from({ length: CROWD_SIZE }, (_, i) => (
                      <UserRound
                        key={i}
                        size={15}
                        fill="currentColor"
                        strokeWidth={0}
                        className={i < filled ? styles.stageCrowdOn : undefined}
                      />
                    ))}
                  </span>
                </div>
                <span
                  className={styles.stageCardMeta}
                  title={metricTooltip(stage, total, cohortSubject)}
                >
                  <b>{stage.count}</b> 人 · 阶段率 <em>{formatPercent(stage.stageRate)}</em>
                </span>
              </div>
            );
          })}
          {!loading && (data?.stages.length ?? 0) === 0 ? (
            <div className={styles.emptyState}>暂无阶段数据</div>
          ) : null}
        </div>
      </div>

      <p className={styles.funnelNote}>{funnelNote(mode, cohortSubject, maturityDays)}</p>
    </section>
  );
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
    `阶段率 ${formatPercent(stage.stageRate)}：相对上一阶段的转化率`,
  ].join('\n');
}

// 统计卡标题：阶段动作描述（参考信息图的「访客进入网站 / 页面」式文案）。
function stageCaption(stage: string, fallback: string) {
  const captions: Record<string, string> = {
    friend_added: '新增好友 · 进入私域',
    break_ice: '候选人回复 · 完成破冰',
    group_invite: '受邀加入群聊',
    booking: '报名成功 · 预约面试',
    interview_pass: '面试通过 · 转化达成',
  };
  return captions[stage] ?? fallback;
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

function funnelDescription(
  mode: ConversionMetricMode,
  total: number,
  loading: boolean,
  maturityDays: number,
) {
  if (mode === 'period') {
    return loading || total === 0
      ? '查看本时间段内各阶段发生量'
      : `本时间段 ${total} 位新增好友对应的阶段发生量`;
  }
  return loading || total === 0
    ? `追踪至少成熟 ${maturityDays} 天的新增好友批次`
    : `追踪 ${total} 位至少成熟 ${maturityDays} 天的新增好友后续进展`;
}

function funnelNote(mode: ConversionMetricMode, subject: string, maturityDays: number) {
  if (mode === 'period') {
    return '口径：同一时段发生量快照。新增好友、破冰、报名、面试通过分别取本时间窗内去重事件（均按人去重）。注意：各阶段独立计数，下游可能超过上一阶段（如窗口外加的好友在本期破冰/报名），故本图非严格收口漏斗、阶段率可能 >100%；如需「同一批人逐级 ⊆」请切到同批追踪。';
  }

  return `口径：以至少成熟 ${maturityDays} 天的${subject}为同一批人逐级追踪（按人去重、线性阶段每级 ⊆ 上一级，比率天然 ≤100%）；每位候选人都有完整的 ${maturityDays} 天观察期，避免近期批次尚未来得及转化造成的低估；收口到面试通过，无入职级。`;
}
