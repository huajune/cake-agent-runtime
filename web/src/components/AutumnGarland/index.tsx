/**
 * 秋日装饰 - 顶栏几片早秋落叶
 *
 * 只是装饰层：色值取粉彩早秋色（黄绿 / 秋金 / 赭黄 / 古铜），不动全站 token。
 * 2026-09 由春日樱花枝换成早秋落叶：不画枝也不画树，只有几片叶子从顶边随风向左飘落。
 * 每片叶：叶基到叶尖的渐变、主脉与侧脉、叶柄、极淡描边。
 */

interface AutumnGarlandProps {
  sidebarCollapsed: boolean;
}

// 粉彩早秋色三阶：light 叶基 / base 叶面 / deep 叶尖与叶脉
interface LeafTone {
  light: string;
  base: string;
  deep: string;
}
const OCHRE: LeafTone = { light: '#ecc98f', base: '#d9a55a', deep: '#c48c44' };
const GOLD: LeafTone = { light: '#f5dc9a', base: '#e9c46a', deep: '#d1a94a' };
const APRICOT: LeafTone = { light: '#f5d29e', base: '#e9b56e', deep: '#d19a50' };
const BRONZE: LeafTone = { light: '#f0c6a6', base: '#e2a37a', deep: '#c98858' };
const YELLOW_GREEN: LeafTone = { light: '#e3e2a8', base: '#cfcf7e', deep: '#b3b25f' };
const TURNING: LeafTone = { light: '#d8e3ad', base: '#bfcf8a', deep: '#a0b46c' };
const PETIOLE = '#a68f72';

type LeafKind = 'simple' | 'plane';

// 叶子都以叶柄基点为原点、叶尖朝上（-y）绘制，叶身高约 20
function LeafShape({ kind, tone, gradientId }: { kind: LeafKind; tone: LeafTone; gradientId: string }) {
  const fill = `url(#${gradientId})`;
  const vein = tone.deep;

  if (kind === 'plane') {
    // 梧桐：五裂掌状阔叶，中裂片最长，基部两片小裂片向两侧张开
    return (
      <>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={tone.light} />
            <stop offset="0.55" stopColor={tone.base} />
            <stop offset="1" stopColor={tone.deep} />
          </linearGradient>
        </defs>
        <path d="M0 2 L0 6" stroke={PETIOLE} strokeWidth="1" strokeLinecap="round" />
        <path
          d="M0 1 C-2.2 0 -4.6 0.6 -6.2 2.4 C-8.6 1 -9.6 -1 -9.2 -3.4 C-7.6 -4.2 -6 -4 -4.6 -3.2 C-7 -6.8 -8.6 -11 -7.4 -14.6 C-5.2 -14.4 -3.4 -12.6 -2.4 -10.2 C-2.2 -14.4 -1.2 -17.8 0 -20 C1.2 -17.8 2.2 -14.4 2.4 -10.2 C3.4 -12.6 5.2 -14.4 7.4 -14.6 C8.6 -11 7 -6.8 4.6 -3.2 C6 -4 7.6 -4.2 9.2 -3.4 C9.6 -1 8.6 1 6.2 2.4 C4.6 0.6 2.2 0 0 1 Z"
          fill={fill}
          stroke={tone.deep}
          strokeWidth="0.35"
          strokeOpacity="0.3"
          strokeLinejoin="round"
        />
        {/* 五条主脉沿各裂片，侧脉两对 */}
        <g stroke={vein} strokeWidth="0.45" strokeOpacity="0.5" strokeLinecap="round" fill="none">
          <path d="M0 1 L0 -18" />
          <path d="M0 -2 L-6.6 -13" />
          <path d="M0 -2 L6.6 -13" />
          <path d="M0 -1 L-8 -3" />
          <path d="M0 -1 L8 -3" />
          <path d="M0 -8 L-1.6 -11.5 M0 -12 L-1.2 -14.5 M0 -8 L1.6 -11.5 M0 -12 L1.2 -14.5" strokeWidth="0.3" />
        </g>
      </>
    );
  }

  // 普通叶：尖头、略不对称的卵形，叶缘微波
  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="0.3" y2="0">
          <stop offset="0" stopColor={tone.light} />
          <stop offset="0.5" stopColor={tone.base} />
          <stop offset="1" stopColor={tone.deep} />
        </linearGradient>
      </defs>
      <path d="M0 0 C0.4 2 0.2 4 -0.6 6" stroke={PETIOLE} strokeWidth="0.9" strokeLinecap="round" fill="none" />
      <path
        d="M0 0 C-4.4 -2 -7.4 -6.4 -6.6 -11.4 C-6 -15.4 -3.2 -18.4 0.4 -20 C3.6 -17 6.4 -13.2 6.2 -8.6 C6 -4.2 3.6 -1.2 0 0 Z"
        fill={fill}
        stroke={tone.deep}
        strokeWidth="0.35"
        strokeOpacity="0.3"
        strokeLinejoin="round"
      />
      <g stroke={vein} strokeWidth="0.45" strokeOpacity="0.5" strokeLinecap="round" fill="none">
        <path d="M0 0 C0.6 -6 0.6 -12 0.4 -19" />
        <path d="M0.3 -4 C-1.8 -5.4 -3.6 -7.4 -5 -9.6" />
        <path d="M0.4 -8 C-1.4 -9.4 -3 -11.4 -4.2 -13.6" />
        <path d="M0.4 -12 C-0.8 -13.2 -1.8 -14.8 -2.6 -16.4" />
        <path d="M0.3 -5 C2 -6.4 3.6 -8.2 4.8 -10.4" />
        <path d="M0.4 -9 C1.8 -10.4 3 -12.2 4 -14.2" />
        <path d="M0.4 -13 C1.2 -14.2 2 -15.8 2.6 -17.2" />
      </g>
    </>
  );
}

// 位置 / 大小 / 时长 / 延迟全部错开，靠 CSS 关键帧 leafFall 下落、随风向左漂、旋转、淡出
const FALLING_LEAVES: Array<{
  left: number;
  kind: LeafKind;
  tone: LeafTone;
  scale: number;
  duration: number;
  delay: number;
}> = [
  { left: 5, kind: 'plane', tone: OCHRE, scale: 0.7, duration: 12, delay: 0 },
  { left: 16, kind: 'simple', tone: YELLOW_GREEN, scale: 0.6, duration: 14, delay: 5 },
  { left: 27, kind: 'plane', tone: GOLD, scale: 0.72, duration: 13, delay: 8.5 },
  { left: 38, kind: 'simple', tone: BRONZE, scale: 0.58, duration: 12.5, delay: 2.5 },
  { left: 49, kind: 'plane', tone: TURNING, scale: 0.66, duration: 14.5, delay: 10.5 },
  { left: 60, kind: 'simple', tone: GOLD, scale: 0.64, duration: 13.5, delay: 4 },
  { left: 71, kind: 'plane', tone: APRICOT, scale: 0.72, duration: 12, delay: 7 },
  { left: 82, kind: 'simple', tone: OCHRE, scale: 0.58, duration: 13, delay: 12 },
  { left: 92, kind: 'plane', tone: BRONZE, scale: 0.62, duration: 14, delay: 1.5 },
];

export default function AutumnGarland({ sidebarCollapsed }: AutumnGarlandProps) {
  return (
    <div className="season-garland" style={{ left: sidebarCollapsed ? '72px' : '260px', padding: 0 }}>
      {FALLING_LEAVES.map((leaf, index) => (
        <div
          key={index}
          className="falling-leaf"
          style={{
            left: `${leaf.left}%`,
            animationDuration: `${leaf.duration}s`,
            animationDelay: `${leaf.delay}s`,
          }}
        >
          <svg width="30" height="30" viewBox="-15 -22 30 30" fill="none">
            <g transform={`scale(${leaf.scale})`} opacity="0.9">
              <LeafShape kind={leaf.kind} tone={leaf.tone} gradientId={`autumn-leaf-grad-${index}`} />
            </g>
          </svg>
        </div>
      ))}
    </div>
  );
}
