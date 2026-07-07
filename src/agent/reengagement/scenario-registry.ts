import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import type {
  FollowUpScenario,
  FollowUpScenarioCode,
  FollowUpScenarioContext,
  ScenarioRolloutConfig,
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
 * 场景级灰度以托管配置 reengagementScenarioRollout 为准（Dashboard 可配，即时生效），
 * defaultRolloutEnabled 只是未配置时的回退：第一版放开锚点明确的三个
 * （opening_no_reply / booking_incomplete / interview_reminder），其余默认只 shadow。
 * 报名后场景（phase=post_booking）额外受 reengagementPostBookingEnabled 大开关约束。
 */
export const FOLLOW_UP_SCENARIOS: readonly FollowUpScenario[] = [
  {
    code: 'opening_no_reply',
    phase: 'pre_booking',
    displayName: '开场未回',
    anchorEvent: 'agent.opening_sent',
    anchorLabel: '开场白已发',
    triggerDelayMs: 15 * MINUTE,
    delayLabel: '15 分钟',
    objective: '开场已发但候选人未回复，轻量关心一句、邀请其表达求职意向',
    requiredEvidence: ['lastCandidateMessageAt'],
    stopUnless: () => true, // 通用停止条件（已回/terminal）已在 shouldStop 覆盖
    generationPolicy: '只问候+一句邀请，不夸大、不承诺、不催促；候选人未回不重复骚扰',
    defaultRolloutEnabled: true,
  },
  {
    code: 'address_missing',
    phase: 'pre_booking',
    displayName: '缺定位',
    anchorEvent: 'agent.replied',
    anchorLabel: 'Agent 已回复',
    triggerDelayMs: 30 * MINUTE,
    delayLabel: '30 分钟',
    objective: '此前对话缺定位/地址，提醒候选人发一下位置以便就近推荐岗位',
    requiredEvidence: ['lastCandidateMessageAt'],
    // 无场景专属停止条件：候选人发定位就是一条入站消息，由通用
    // candidate_replied_after_anchor 规则停发。曾有 state.location 检查，但该字段
    // 全链路无生产者（微信定位消息只被解析成文本进对话流），恒 undefined 属死代码，已删。
    stopUnless: () => true,
    generationPolicy: '说明发位置的好处（就近推荐），不施压',
    defaultRolloutEnabled: false,
  },
  {
    code: 'store_presented_no_reply',
    phase: 'pre_booking',
    displayName: '推店未回',
    anchorEvent: 'agent.store_presented',
    anchorLabel: '已展示门店/岗位',
    triggerDelayMs: 3 * HOUR,
    delayLabel: '3 小时',
    objective: '已展示门店/岗位但候选人未回复，询问是否还有兴趣或需要换个方向',
    requiredEvidence: ['presentedStores'],
    stopUnless: (state) => state.presentedStores.length > 0,
    generationPolicy: '不复读岗位详情，只问意向是否仍在/要不要换方向',
    defaultRolloutEnabled: false,
  },
  {
    code: 'booking_incomplete',
    phase: 'pre_booking',
    displayName: '收资未完成',
    anchorEvent: 'agent.collection_started',
    anchorLabel: '开始收集资料',
    triggerDelayMs: 2 * HOUR,
    delayLabel: '2 小时',
    objective: '收资未完成，提醒候选人补齐剩余资料以便安排面试',
    requiredEvidence: ['collectedFields'],
    stopUnless: (state) => !collectedFieldsComplete(state),
    generationPolicy: '只提醒补资料、说明补齐后能更快约面，不催不压',
    defaultRolloutEnabled: true,
  },
  {
    code: 'interview_reminder',
    phase: 'post_booking',
    displayName: '面试提醒',
    anchorEvent: 'booking.succeeded',
    anchorLabel: '报名成功',
    // 面试前 1h 提醒（依赖 interviewTime；无面试时间的等通知岗位不排主动触达）
    triggerDelayMs: (ctx: FollowUpScenarioContext) => {
      const interviewAt = resolveInterviewAt(ctx.state);
      if (interviewAt == null) return 0;
      return Math.max(0, interviewAt - HOUR - ctx.anchorAt);
    },
    delayLabel: '面试前 1 小时（无面试时间不触发）',
    objective: '面试前提醒候选人准时参加、带好证件',
    requiredEvidence: ['terminal', 'interviewAt'],
    stopUnless: (state) => state.terminal !== 'rejected' && hasInterviewAt(state),
    generationPolicy: '提醒时间地点、带身份证/健康证；不索取新资料',
    defaultRolloutEnabled: true,
  },
  {
    code: 'post_interview_followup',
    phase: 'post_booking',
    displayName: '面试后回访',
    anchorEvent: 'booking.succeeded',
    anchorLabel: '报名成功',
    triggerDelayMs: (ctx: FollowUpScenarioContext) => {
      const interviewAt = resolveInterviewAt(ctx.state);
      if (interviewAt == null) return 0;
      return Math.max(0, interviewAt + HOUR - ctx.anchorAt);
    },
    delayLabel: '面试后 1 小时（无面试时间不触发）',
    objective: '面试后回访，了解面试结果、是否需要后续协助',
    requiredEvidence: ['interviewAt'],
    stopUnless: hasInterviewAt,
    generationPolicy: '关心面试体验、是否有问题需要协助；不施压入职',
    defaultRolloutEnabled: false,
  },
  {
    code: 'new_job_for_waiting',
    phase: 'pre_booking',
    displayName: '新岗上线',
    anchorEvent: 'job.published',
    anchorLabel: '岗位发布（外部事件）',
    triggerDelayMs: 0,
    delayLabel: '立即',
    objective: '此前暂无岗位的候选人，现有新岗位上线，主动告知',
    requiredEvidence: [],
    stopUnless: () => true,
    generationPolicy: '简短告知有新岗位、询问是否要看；不夸大',
    defaultRolloutEnabled: false,
  },
];

const SCENARIO_BY_CODE = new Map(FOLLOW_UP_SCENARIOS.map((s) => [s.code, s]));

export function getScenario(code: FollowUpScenarioCode): FollowUpScenario | undefined {
  return SCENARIO_BY_CODE.get(code);
}

/** interviewTime（毫秒）从权威态推断；缺失返回 null。 */
export function resolveInterviewAt(state: AuthoritativeSessionState): number | null {
  const raw = (state as { interviewAt?: unknown }).interviewAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export function hasInterviewAt(state: AuthoritativeSessionState): boolean {
  return resolveInterviewAt(state) != null;
}

/**
 * 报名后跟进任务的幂等锚点 ID：同一工单同一面试时间只存在一个任务。
 *
 * 聊天改约锚点（anchor.service）与到点改期发现（processor 排替代任务）共用此 ID，
 * 两条路径撞同一个 Bull jobId 自然去重，不会给候选人重复发提醒。
 * 已知取舍：同工单改回曾用过的时间，若旧 job 仍在 removeOnComplete 保留期内会被去重吞掉。
 */
export function bookingFollowUpAnchorId(
  workOrderId: number,
  interviewAtMs: number,
  scenarioCode: string,
): string {
  return `wo${workOrderId}:iv${interviewAtMs}:${scenarioCode}`;
}

/**
 * 面试时间原始值 → 毫秒时间戳。接受数字时间戳或 `YYYY-MM-DD HH:mm`（海绵格式，按 Asia/Shanghai 解析）。
 * anchor 锚点提取与 processor 到点改期比对共用，保证两端解析口径一致。
 */
export function parseInterviewTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + '+08:00';
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : undefined;
}

/**
 * 场景当前是否放开真发（场景级灰度 × 报名后大开关叠加）。
 *
 * - 场景开关：托管配置 reengagementScenarioRollout[code]，未配置回退 defaultRolloutEnabled
 * - 报名后场景（post_booking）还要求 reengagementPostBookingEnabled=true
 *
 * 返回 false 时到点任务照常走判断与生成，但只 shadow 记录不投递。
 */
export function resolveRolloutEnabled(
  scenario: FollowUpScenario,
  config: ScenarioRolloutConfig,
): boolean {
  const scenarioEnabled =
    config.reengagementScenarioRollout?.[scenario.code] ?? scenario.defaultRolloutEnabled;
  if (!scenarioEnabled) return false;
  // 大开关缺失视为开（不收紧），只有显式 false 才拦报名后场景
  if (scenario.phase === 'post_booking' && config.reengagementPostBookingEnabled === false) {
    return false;
  }
  return true;
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
 *   booking.succeeded 锚点允许 booked/handed_off 继续，由场景 stopUnless 自己判断。
 * - lastCandidateMessageAt > anchorAt（候选人在锚点后已回话）→ 停
 *   例外：booking.succeeded 锚点且任务带 workOrderId（opts.externallyVerifiable）时豁免——
 *   候选人报名后回一句"好的"不该杀掉面试提醒；报名是否仍有效改由 processor 到点向
 *   海绵工单现状 + active_booking 面试时间核验（external_cancelled / interview_time_changed）。
 *   不带 workOrderId 的存量任务无核验能力，保留回话即停的旧行为。
 * - 场景特定 stopUnless 不成立 → 停
 */
export function shouldStop(
  scenario: FollowUpScenario,
  state: AuthoritativeSessionState,
  anchorAt: number,
  opts?: { externallyVerifiable?: boolean },
): ShouldStopResult {
  const bookingSucceededFollowUp =
    scenario.anchorEvent === 'booking.succeeded' &&
    (state.terminal === 'booked' || state.terminal === 'handed_off');
  if (state.terminal && !bookingSucceededFollowUp) {
    return { stop: true, reason: `terminal:${state.terminal}` };
  }
  const repliedRuleExempt =
    scenario.anchorEvent === 'booking.succeeded' && opts?.externallyVerifiable === true;
  if (
    !repliedRuleExempt &&
    state.lastCandidateMessageAt != null &&
    state.lastCandidateMessageAt > anchorAt
  ) {
    return { stop: true, reason: 'candidate_replied_after_anchor' };
  }
  if (!scenario.stopUnless(state)) {
    return { stop: true, reason: 'scenario_no_longer_holds' };
  }
  return { stop: false };
}
