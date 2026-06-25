import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type {
  FollowUpScenario,
  FollowUpScenarioCode,
  FollowUpScenarioContext,
  ShouldStopResult,
} from './reengagement.types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 9-21 时间窗（Asia/Shanghai，无 DST，恒 UTC+8）。 */
const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 21;
const SHANGHAI_OFFSET_MS = 8 * HOUR;

/** 收资必备字段（booking_incomplete 是否仍缺资料的判据）。 */
const BOOKING_REQUIRED_FIELDS = ['name', 'phone', 'age', 'gender'] as const;

function hasField(state: AuthoritativeSessionState, key: string): boolean {
  return Boolean((state.collectedFields as Record<string, unknown>)[key]);
}

function collectedFieldsComplete(state: AuthoritativeSessionState): boolean {
  return BOOKING_REQUIRED_FIELDS.every((k) => hasField(state, k));
}

/**
 * 7 个需求场景 → 锚点/延迟/stopUnless 映射（见 agent-reengagement-design.md §5）。
 *
 * 第一版只放事件锚点明确的三个 rolloutEnabled=true（opening_no_reply / booking_incomplete /
 * interview_reminder）；其余先 shadow（rolloutEnabled=false），new_job_for_waiting 外部事件最后开。
 */
export const FOLLOW_UP_SCENARIOS: readonly FollowUpScenario[] = [
  {
    code: 'opening_no_reply',
    anchorEvent: 'agent.opening_sent',
    triggerDelayMs: 15 * MINUTE,
    objective: '开场已发但候选人未回复，轻量关心一句、邀请其表达求职意向',
    requiredEvidence: ['lastCandidateMessageAt'],
    stopUnless: () => true, // 通用停止条件（已回/terminal）已在 shouldStop 覆盖
    generationPolicy: '只问候+一句邀请，不夸大、不承诺、不催促；候选人未回不重复骚扰',
    rolloutEnabled: true,
  },
  {
    code: 'address_missing',
    anchorEvent: 'agent.replied',
    triggerDelayMs: 30 * MINUTE,
    objective: '此前对话缺定位/地址，提醒候选人发一下位置以便就近推荐岗位',
    requiredEvidence: ['location'],
    stopUnless: (state) => !state.location,
    generationPolicy: '说明发位置的好处（就近推荐），不施压',
    rolloutEnabled: false,
  },
  {
    code: 'store_presented_no_reply',
    anchorEvent: 'agent.store_presented',
    triggerDelayMs: 3 * HOUR,
    objective: '已展示门店/岗位但候选人未回复，询问是否还有兴趣或需要换个方向',
    requiredEvidence: ['presentedStores'],
    stopUnless: (state) => state.presentedStores.length > 0,
    generationPolicy: '不复读岗位详情，只问意向是否仍在/要不要换方向',
    rolloutEnabled: false,
  },
  {
    code: 'booking_incomplete',
    anchorEvent: 'agent.collection_started',
    triggerDelayMs: 2 * HOUR,
    objective: '收资未完成，提醒候选人补齐剩余资料以便安排面试',
    requiredEvidence: ['collectedFields'],
    stopUnless: (state) => !collectedFieldsComplete(state),
    generationPolicy: '只提醒补资料、说明补齐后能更快约面，不催不压',
    rolloutEnabled: true,
  },
  {
    code: 'interview_reminder',
    anchorEvent: 'booking.succeeded',
    // 面试前 1h 提醒（依赖 interviewTime；缺失时回退到锚点 +1h）
    triggerDelayMs: (ctx: FollowUpScenarioContext) => {
      const interviewAt = resolveInterviewAt(ctx.state);
      if (interviewAt == null) return HOUR;
      return Math.max(0, interviewAt - HOUR - ctx.anchorAt);
    },
    objective: '面试前提醒候选人准时参加、带好证件',
    requiredEvidence: ['terminal'],
    stopUnless: (state) => state.terminal !== 'rejected',
    generationPolicy: '提醒时间地点、带身份证/健康证；不索取新资料',
    rolloutEnabled: true,
  },
  {
    code: 'post_interview_followup',
    anchorEvent: 'booking.succeeded',
    triggerDelayMs: (ctx: FollowUpScenarioContext) => {
      const interviewAt = resolveInterviewAt(ctx.state);
      if (interviewAt == null) return 25 * HOUR;
      return Math.max(0, interviewAt + HOUR - ctx.anchorAt);
    },
    objective: '面试后回访，了解面试结果、是否需要后续协助',
    requiredEvidence: [],
    stopUnless: () => true,
    generationPolicy: '关心面试体验、是否有问题需要协助；不施压入职',
    rolloutEnabled: false,
  },
  {
    code: 'new_job_for_waiting',
    anchorEvent: 'job.published',
    triggerDelayMs: 0,
    objective: '此前暂无岗位的候选人，现有新岗位上线，主动告知',
    requiredEvidence: [],
    stopUnless: () => true,
    generationPolicy: '简短告知有新岗位、询问是否要看；不夸大',
    rolloutEnabled: false,
  },
];

const SCENARIO_BY_CODE = new Map(FOLLOW_UP_SCENARIOS.map((s) => [s.code, s]));

export function getScenario(code: FollowUpScenarioCode): FollowUpScenario | undefined {
  return SCENARIO_BY_CODE.get(code);
}

/** interviewTime（毫秒）从权威态推断；缺失返回 null。 */
function resolveInterviewAt(state: AuthoritativeSessionState): number | null {
  const raw = (state as { interviewAt?: unknown }).interviewAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export function resolveDelayMs(scenario: FollowUpScenario, ctx: FollowUpScenarioContext): number {
  const d = scenario.triggerDelayMs;
  return typeof d === 'function' ? d(ctx) : d;
}

/** Shanghai 墙钟小时（0-23）。 */
function shanghaiHour(ts: number): number {
  return new Date(ts + SHANGHAI_OFFSET_MS).getUTCHours();
}

/** ts 是否落在 9-21 触达窗口内。 */
export function inWindow(ts: number): boolean {
  const hour = shanghaiHour(ts);
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

/**
 * 计算绝对触发时间戳（已对齐 9-21 窗口）。
 *
 * 先算 anchorAt + delay；落在 <9:00 推到当日 9:00，>=21:00 推到次日 9:00（Asia/Shanghai）。
 * ⚠️ 调用方排程时 Bull `delay = max(0, fireAt - now)`（相对 ms），别把绝对 fireAt 当 delay。
 */
export function computeFireAt(scenario: FollowUpScenario, ctx: FollowUpScenarioContext): number {
  const base = ctx.anchorAt + resolveDelayMs(scenario, ctx);
  const hour = shanghaiHour(base);
  if (hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR) return base;

  const sh = new Date(base + SHANGHAI_OFFSET_MS);
  // 当日 09:00 Shanghai = 当日 01:00 UTC
  const todayNineUtc = Date.UTC(
    sh.getUTCFullYear(),
    sh.getUTCMonth(),
    sh.getUTCDate(),
    WINDOW_START_HOUR - 8,
    0,
    0,
  );
  // >=21 推到次日 9:00；<9 推到当日 9:00
  return hour >= WINDOW_END_HOUR ? todayNineUtc + 24 * HOUR : todayNineUtc;
}

/**
 * 调 LLM 之前的代码停止条件（读权威状态）。
 *
 * - terminal ∈ {booked, handed_off, rejected, onboarded} → 停
 *   booking.succeeded 锚点允许 terminal:booked 继续，由场景 stopUnless 自己判断。
 * - lastCandidateMessageAt > anchorAt（候选人在锚点后已回话）→ 停
 * - 场景特定 stopUnless 不成立 → 停
 */
export function shouldStop(
  scenario: FollowUpScenario,
  state: AuthoritativeSessionState,
  anchorAt: number,
): ShouldStopResult {
  const bookedFollowUp =
    scenario.anchorEvent === 'booking.succeeded' && state.terminal === 'booked';
  if (state.terminal && !bookedFollowUp) {
    return { stop: true, reason: `terminal:${state.terminal}` };
  }
  if (state.lastCandidateMessageAt != null && state.lastCandidateMessageAt > anchorAt) {
    return { stop: true, reason: 'candidate_replied_after_anchor' };
  }
  if (!scenario.stopUnless(state)) {
    return { stop: true, reason: 'scenario_no_longer_holds' };
  }
  return { stop: false };
}
