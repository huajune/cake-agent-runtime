import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';

export type FollowUpScenarioCode =
  | 'opening_no_reply'
  | 'address_missing'
  | 'store_presented_no_reply'
  | 'booking_incomplete'
  | 'interview_reminder'
  | 'post_interview_followup'
  | 'new_job_for_waiting';

export interface FollowUpScenarioContext {
  anchorAt: number;
  state: AuthoritativeSessionState;
  /** 实时岗位详情解析出的面试形式；仅用于需要按形式区分触发时间的场景。 */
  interviewType?: string;
}

/** 场景所属大阶段：报名前 / 报名后（报名后流程复杂，支持独立大开关）。 */
export type FollowUpScenarioPhase = 'pre_booking' | 'post_booking';

/** 场景级灰度的运行时配置切片（来自 Dashboard 托管配置，即时生效）。字段缺失按不收紧处理。 */
export interface ScenarioRolloutConfig {
  /** 报名后大场景独立开关：显式 false 时报名后场景全部只 shadow；缺失视为开。 */
  reengagementPostBookingEnabled?: boolean;
  /** 场景级开关 map（key=场景 code）；未配置的场景回退代码默认值。 */
  reengagementScenarioRollout?: Record<string, boolean>;
  /** 场景触发偏移分钟数（key=场景 code），缺失时回退代码默认值。 */
  reengagementScenarioDelayMinutes?: Record<string, number>;
}

export type FollowUpDelayMode = 'after_anchor' | 'before_interview' | 'after_interview';

/** 结构化场景配置（非 prompt 常量）。 */
export interface FollowUpScenario {
  code: FollowUpScenarioCode;
  /** 所属大阶段：报名后场景受 reengagementPostBookingEnabled 大开关额外约束。 */
  phase: FollowUpScenarioPhase;
  /** 场景中文名（Dashboard 配置页只读展示）。 */
  displayName: string;
  /** 锚点事件名（ops_events / turn-end hook）。 */
  anchorEvent: string;
  /** 锚点事件中文说明（Dashboard 配置页只读展示）。 */
  anchorLabel: string;
  /** 相对锚点延迟；面试提醒等依赖 interviewTime 的传函数。 */
  triggerDelayMs: number | ((ctx: FollowUpScenarioContext) => number);
  /** 触发延迟人话描述（triggerDelayMs 为函数时无法直接序列化，展示走这里）。 */
  delayLabel: string;
  /** Dashboard 可配置的时间偏移语义与默认分钟数。 */
  delayMode: FollowUpDelayMode;
  defaultDelayMinutes: number;
  /** 跟进目标（喂 runner 的 proactive directive）。 */
  objective: string;
  /** 排程前/触发时必须具备的权威状态字段（审计用）。 */
  requiredEvidence: string[];
  /** 场景是否仍成立；返回 false → 丢弃，不触发。 */
  stopUnless: (state: AuthoritativeSessionState) => boolean;
  /** 语气与禁止项（不夸大/不承诺/不骚扰/拒绝即止）。 */
  generationPolicy: string;
  /** 允许注入本场景 prompt 的结构化事实标签；近期对话不受此白名单影响。 */
  relevantFactLabels: readonly string[];
  /** 场景级灰度默认值：运行时以托管配置 reengagementScenarioRollout 为准，未配置时回退此值。 */
  defaultRolloutEnabled: boolean;
  /** 该场景触发后应取消的低优先级待触达场景，由 scheduler 统一解析 jobId。 */
  supersedes?: FollowUpScenarioCode[];
  /** 稳定锚点事件 id（用于被 supersedes 的固定锚点场景，例如 opening）。 */
  canonicalAnchorEventId?: string;
  /** 时间锚定场景不参与跨场景 session 冷却，例如面试前 1 小时提醒。 */
  sessionCooldownExempt?: boolean;
}

export interface ShouldStopResult {
  stop: boolean;
  reason?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SHANGHAI_UTC_OFFSET_MS = 8 * HOUR;

function isAiInterview(interviewType?: string): boolean {
  return typeof interviewType === 'string' && /ai\s*面试/i.test(interviewType);
}

/** 上海时区无夏令时：返回面试日期当天指定整点的绝对时间。 */
function shanghaiHourOnInterviewDay(interviewAt: number, hour: number): number {
  const localDate = new Date(interviewAt + SHANGHAI_UTC_OFFSET_MS);
  return (
    Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), hour) -
    SHANGHAI_UTC_OFFSET_MS
  );
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
    delayMode: 'after_anchor',
    defaultDelayMinutes: 15,
    objective: '开场已发但候选人未回复，轻量确认是否还在看机会，并继续询问所在位置以便就近推荐',
    requiredEvidence: ['lastCandidateMessageAt'],
    stopUnless: () => true, // 通用停止条件（已回/terminal）已在 shouldStop 覆盖
    generationPolicy:
      '优先使用“还在看机会吗”，再自然询问候选人目前在哪个区域、商圈或地铁站附近，说明可以帮忙看看附近岗位；不要使用“求职意向”这个词，不要问“在忙吗”“怎么没回”，不夸大、不承诺、不催促',
    relevantFactLabels: ['意向城市', '意向区域', '意向地点'],
    defaultRolloutEnabled: true,
    canonicalAnchorEventId: 'opening',
  },
  {
    code: 'address_missing',
    phase: 'pre_booking',
    displayName: '缺定位',
    anchorEvent: 'agent.replied',
    anchorLabel: 'Agent 已回复',
    triggerDelayMs: 30 * MINUTE,
    delayLabel: '30 分钟',
    delayMode: 'after_anchor',
    defaultDelayMinutes: 30,
    objective: '此前对话缺定位/地址，提醒候选人发一下位置以便就近推荐岗位',
    requiredEvidence: ['lastCandidateMessageAt'],
    // 无场景专属停止条件：候选人发定位就是一条入站消息，由通用
    // candidate_replied_after_anchor 规则停发。曾有 state.location 检查，但该字段
    // 全链路无生产者（微信定位消息只被解析成文本进对话流），恒 undefined 属死代码，已删。
    stopUnless: () => true,
    generationPolicy: '说明发位置的好处（就近推荐），不施压',
    relevantFactLabels: ['意向城市', '意向区域', '意向地点'],
    defaultRolloutEnabled: false,
    supersedes: ['opening_no_reply'],
  },
  {
    code: 'store_presented_no_reply',
    phase: 'pre_booking',
    displayName: '推店未回',
    anchorEvent: 'agent.store_presented',
    anchorLabel: '已展示门店/岗位',
    triggerDelayMs: 30 * MINUTE,
    delayLabel: '30 分钟',
    delayMode: 'after_anchor',
    defaultDelayMinutes: 30,
    objective: '已展示满足候选人条件的门店/岗位但候选人未回复，承接该岗位询问考虑得如何',
    requiredEvidence: ['presentedStores'],
    stopUnless: (state) => state.presentedStores.length > 0,
    generationPolicy:
      '简短承接近期对话里已经明确推荐且满足条件的岗位、门店或关键条件，帮助候选人确认在说哪个机会；只能复述已有证据，不新增或改写细节，然后只询问考虑得如何或是否感兴趣。禁止重新查岗，禁止说暂无岗位，禁止询问换品牌、换岗位、换区域或换城市',
    relevantFactLabels: [
      '应聘门店',
      '应聘岗位',
      '用工形式',
      '意向品牌',
      '意向薪资',
      '意向岗位',
      '意向班次',
      '意向城市',
      '意向区域',
      '意向地点',
      '短期工意向',
      '可用时间窗口',
      '结构化排班约束',
      '最早可面试日期',
    ],
    defaultRolloutEnabled: false,
  },
  {
    code: 'booking_incomplete',
    phase: 'pre_booking',
    displayName: '收资未完成',
    anchorEvent: 'agent.collection_started',
    anchorLabel: '开始收集资料',
    triggerDelayMs: 30 * MINUTE,
    delayLabel: '30 分钟',
    delayMode: 'after_anchor',
    defaultDelayMinutes: 30,
    objective: '收资未完成，提醒候选人补齐剩余资料以便安排面试',
    requiredEvidence: ['collectedFields'],
    // 收资必填项随岗位/业务配置变化，不能在复聊层写死为姓名/手机号/年龄/性别。
    // 是否已完成由候选人回话、报名成功终态和外部业务流程推进来收敛。
    stopUnless: () => true,
    generationPolicy:
      '只提醒继续补充资料、说明补齐后便于推进约面；不要猜具体缺少哪些字段，不使用“现在补”“尽快发”等催促表达',
    relevantFactLabels: [],
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
    delayMode: 'before_interview',
    defaultDelayMinutes: 60,
    objective: '根据面试形式提醒候选人按时参加；AI 面试提醒在线完成，线下面试才提醒到店',
    requiredEvidence: ['terminal', 'interviewAt'],
    stopUnless: (state) => state.terminal !== 'rejected' && hasInterviewAt(state),
    generationPolicy:
      '仅在当前工单仍进行中，且近期对话没有取消、不参加、已有面试结果、已询问面试结果或已发送本次面试提醒时生成。必须按状态摘要里的面试形式生成：AI 面试说明无需到店，提醒按面试通知的入口和要求在线完成，不提门店、到店或携带证件；线下面试才提醒时间、地点和已有证据中的证件；仅写“线上面试”但未明确 AI 时，不得说成 AI 面试。若状态摘要明确写着“工单未提供，不得猜测”，只能中性提醒候选人按面试通知中的时间和要求参加，不得提线上、线下、到店、地址、入口、材料或证件。使用中性表达，不索取新资料',
    relevantFactLabels: [],
    defaultRolloutEnabled: true,
    sessionCooldownExempt: true,
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
      // AI 面试是候选人在通知入口自助完成，统一在面试日期当天 17:00 询问是否完成；
      // 其他面试保持按工单面试时间后 2 小时回访。Dashboard 显式偏移仍由
      // resolveDelayMs 优先处理，便于运营临时覆盖。
      const followUpAt = isAiInterview(ctx.interviewType)
        ? shanghaiHourOnInterviewDay(interviewAt, 17)
        : interviewAt + 2 * HOUR;
      return Math.max(0, followUpAt - ctx.anchorAt);
    },
    delayLabel: 'AI 面试当天 17:00；其他面试在工单面试时间后 2 小时（无面试时间不触发）',
    delayMode: 'after_interview',
    defaultDelayMinutes: 120,
    objective: '面试后回访，了解面试结果、是否需要后续协助',
    requiredEvidence: ['interviewAt'],
    stopUnless: hasInterviewAt,
    generationPolicy:
      '仅在当前工单仍进行中，且近期对话没有取消、不参加、已有面试结果或招募经理已经询问本次面试结果时生成；此前只发过面试提醒不影响回访。按状态摘要里的面试形式询问：AI 面试询问是否已经完成、是否遇到问题；其他面试询问是否顺利、体验如何、是否需要协助。不要直接断言候选人已完成面试，不施压入职',
    relevantFactLabels: [],
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
    delayMode: 'after_anchor',
    defaultDelayMinutes: 0,
    objective: '此前暂无岗位的候选人，现有新岗位上线，主动告知',
    requiredEvidence: [],
    stopUnless: () => true,
    generationPolicy: '简短告知有新岗位、询问是否要看；不夸大',
    relevantFactLabels: [
      '求职类型',
      '用工形式',
      '意向品牌',
      '意向薪资',
      '意向岗位',
      '意向班次',
      '可接受班次',
      '意向城市',
      '意向区域',
      '意向地点',
      '推迟意向',
      '短期工意向',
      '可用时间窗口',
      '结构化排班约束',
      '最早可面试日期',
    ],
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
  interviewType?: string,
): string {
  // AI 17:00 是独立排程版本。版本后缀既避免新任务与旧“面试后 +2h”任务撞 Bull
  // jobId，也让存量旧任务到点校准时能成功补排 17:00 的替代任务。
  const scheduleVersion =
    scenarioCode === 'post_interview_followup' && isAiInterview(interviewType) ? ':ai17' : '';
  return `wo${workOrderId}:iv${interviewAtMs}:${scenarioCode}${scheduleVersion}`;
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

export function resolveDelayMs(
  scenario: FollowUpScenario,
  ctx: FollowUpScenarioContext,
  configuredDelayMinutes?: number,
): number {
  if (configuredDelayMinutes != null) {
    const offsetMs = configuredDelayMinutes * MINUTE;
    if (scenario.delayMode === 'after_anchor') return offsetMs;
    const interviewAt = resolveInterviewAt(ctx.state);
    if (interviewAt == null) return 0;
    const fireAt =
      scenario.delayMode === 'before_interview' ? interviewAt - offsetMs : interviewAt + offsetMs;
    return Math.max(0, fireAt - ctx.anchorAt);
  }
  const d = scenario.triggerDelayMs;
  return typeof d === 'function' ? d(ctx) : d;
}

/** 计算绝对触发时间戳；发送资格由到点时的托管状态决定，不再限制发送时段。 */
export function computeFireAt(
  scenario: FollowUpScenario,
  ctx: FollowUpScenarioContext,
  configuredDelayMinutes?: number,
): number {
  return ctx.anchorAt + resolveDelayMs(scenario, ctx, configuredDelayMinutes);
}

/**
 * 调 LLM 之前的代码停止条件（读权威状态）。
 *
 * - terminal ∈ {booked, handed_off, rejected, onboarded} → 停
 *   booking.succeeded 锚点允许 booked/handed_off 继续，由场景 stopUnless 自己判断。
 * - lastCandidateMessageAt > anchorAt（候选人在锚点后已回话）→ 停
 *   例外：booking.succeeded 锚点且任务带 workOrderId（opts.externallyVerifiable）时豁免——
 *   候选人报名后回一句"好的"不该杀掉面试提醒；报名是否仍有效改由 processor 到点向
 *   海绵工单现状 + active_booking 面试时间核验（work_order_not_active / interview_time_changed）。
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
  if (
    scenario.code === 'store_presented_no_reply' &&
    state.invitedGroups != null &&
    state.invitedGroups.length > 0
  ) {
    return { stop: true, reason: 'candidate_invited_to_group' };
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
