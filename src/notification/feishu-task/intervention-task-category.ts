/**
 * 介入原因码 → 任务大类（T1–T8）临时映射。
 *
 * TODO(批次 C)：批次 C 正在建 `src/enums/handoff-reason.enum.ts` 权威枚举
 * （原因码 → 中文标签 / urgent / manualResumeOnly / 任务大类）。枚举落地后本文件的
 * `REASON_CODE_CATEGORY` / `REASON_CODE_LABELS` / `URGENT_REASON_CODES` 三张表应改为从
 * 该枚举读取，只保留大类元数据（时限、负责人、优先级）。表内容按 PRD R5.2 抄录。
 */

export type InterventionTaskCategory =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'T7'
  | 'T8'
  | 'UNCLASSIFIED';

export type InterventionTaskPriority = 'urgent' | 'today' | 'normal';

export const PRIORITY_LABELS: Record<InterventionTaskPriority, string> = {
  urgent: '急',
  today: '当日',
  normal: '常规',
};

const PRIORITY_RANK: Record<InterventionTaskPriority, number> = {
  urgent: 3,
  today: 2,
  normal: 1,
};

/** 时限规则：固定上班分钟数，或 T3/T8 的「16:30 前取当天 18:30，否则次日 12:00」。 */
export type CategoryDeadlineRule =
  | { kind: 'working_minutes'; minutes: number }
  | { kind: 'same_day_or_next_noon' };

export interface InterventionTaskCategoryMeta {
  code: InterventionTaskCategory;
  label: string;
  deadline: CategoryDeadlineRule;
  /** 大类默认优先级（原因码标急 / 面试临近可抬到 urgent）。 */
  basePriority: InterventionTaskPriority;
  /** 面试上限只对 T2、T6 生效（PRD R6 第 4 条）。 */
  interviewCapApplies: boolean;
  /** 负责人取向：托管账号对应运营 / 运营主管 / 单独配置的对接人。 */
  owner: 'hosting_account' | 'supervisor' | 'configured';
}

const WORKDAY_MINUTES = 9 * 60;

export const CATEGORY_META: Record<InterventionTaskCategory, InterventionTaskCategoryMeta> = {
  T1: {
    code: 'T1',
    label: '现场急件',
    deadline: { kind: 'working_minutes', minutes: 30 },
    basePriority: 'urgent',
    interviewCapApplies: false,
    owner: 'hosting_account',
  },
  T2: {
    code: 'T2',
    label: '预约协调',
    deadline: { kind: 'working_minutes', minutes: 120 },
    basePriority: 'today',
    interviewCapApplies: true,
    owner: 'hosting_account',
  },
  T3: {
    code: 'T3',
    label: '面试后跟进',
    deadline: { kind: 'same_day_or_next_noon' },
    basePriority: 'today',
    interviewCapApplies: false,
    owner: 'hosting_account',
  },
  T4: {
    code: 'T4',
    label: '薪资考勤个案',
    deadline: { kind: 'working_minutes', minutes: WORKDAY_MINUTES },
    basePriority: 'normal',
    interviewCapApplies: false,
    owner: 'configured',
  },
  T5: {
    code: 'T5',
    label: '岗位数据/口径缺口',
    deadline: { kind: 'working_minutes', minutes: 3 * WORKDAY_MINUTES },
    basePriority: 'normal',
    interviewCapApplies: false,
    owner: 'configured',
  },
  T6: {
    code: 'T6',
    label: '系统卡点',
    deadline: { kind: 'working_minutes', minutes: 120 },
    basePriority: 'today',
    interviewCapApplies: true,
    owner: 'hosting_account',
  },
  T7: {
    code: 'T7',
    label: '风险与合规',
    deadline: { kind: 'working_minutes', minutes: 60 },
    basePriority: 'urgent',
    interviewCapApplies: false,
    owner: 'supervisor',
  },
  T8: {
    code: 'T8',
    label: '平台操作问题',
    deadline: { kind: 'same_day_or_next_noon' },
    basePriority: 'today',
    interviewCapApplies: false,
    owner: 'configured',
  },
  UNCLASSIFIED: {
    code: 'UNCLASSIFIED',
    label: '未归类',
    deadline: { kind: 'working_minutes', minutes: 120 },
    basePriority: 'today',
    interviewCapApplies: false,
    owner: 'hosting_account',
  },
};

/** 原因码 → 大类（PRD R5.2）。TODO(批次 C)：改读权威枚举。 */
const REASON_CODE_CATEGORY: Record<string, InterventionTaskCategory> = {
  no_reception: 'T1',
  booking_conflict: 'T1',
  cannot_find_store: 'T1',
  store_no_show: 'T1',
  interview_group_invite_required: 'T2',
  modify_appointment: 'T2',
  interview_slot_coordination: 'T2',
  booking_capacity_full: 'T2',
  group_invite_failed: 'T2',
  no_match_or_group_full: 'T2',
  out_of_band_booking_inquiry: 'T2',
  store_hiring_status_check: 'T2',
  duplicate_signup: 'T2',
  interview_result_inquiry: 'T3',
  onboarding_paperwork: 'T3',
  onboarding_failed: 'T3',
  self_recruited_or_completed: 'T3',
  onboarding_follow_up_required: 'T3',
  employment_affairs: 'T3',
  personal_pay_attendance: 'T4',
  salary_admin_inquiry: 'T5',
  system_blocked: 'T6',
  identity_age_exception: 'T7',
  platform_operation: 'T8',
  // 入站风险类（conversation_risk.riskType）
  abuse: 'T7',
  complaint_risk: 'T7',
  escalation: 'T7',
  human_handoff_request: 'T7',
  disability_disclosure: 'T7',
};

/** 原因码中文标签（飞书单选「原因码」选项名）。TODO(批次 C)：改读权威枚举。 */
const REASON_CODE_LABELS: Record<string, string> = {
  no_reception: '到店无人接待',
  booking_conflict: '门店查不到预约',
  cannot_find_store: '找不到门店',
  store_no_show: '门店/面试官未履约',
  interview_group_invite_required: '需手动发面试群邀请',
  modify_appointment: '改约/取消',
  interview_slot_coordination: '面试时段协调',
  booking_capacity_full: '名额已满',
  group_invite_failed: '拉群失败',
  no_match_or_group_full: '无岗且群满',
  out_of_band_booking_inquiry: '带外预约核实',
  store_hiring_status_check: '门店招聘状态核实',
  duplicate_signup: '重复报名核实',
  interview_result_inquiry: '面试结果追问',
  onboarding_paperwork: '入职流程',
  onboarding_failed: '入职失败',
  self_recruited_or_completed: '门店自招/已通过',
  onboarding_follow_up_required: '入职跟进巡检',
  employment_affairs: '在职事务',
  personal_pay_attendance: '个人薪资考勤个案',
  salary_admin_inquiry: '岗位口径缺口',
  system_blocked: '系统卡住',
  identity_age_exception: '年龄身份裁量',
  platform_operation: '平台操作问题',
  other: '其他',
  abuse: '辱骂/攻击',
  complaint_risk: '投诉风险',
  escalation: '情绪升级',
  human_handoff_request: '主动要人工',
  disability_disclosure: '残障披露',
};

/** 标急原因码（PRD R5.2「标急」列 = 是）。TODO(批次 C)：改读权威枚举 urgent。 */
const URGENT_REASON_CODES: ReadonlySet<string> = new Set([
  'no_reception',
  'booking_conflict',
  'cannot_find_store',
  'store_no_show',
  'interview_group_invite_required',
  'modify_appointment',
  'out_of_band_booking_inquiry',
  'abuse',
  'complaint_risk',
  'escalation',
  'human_handoff_request',
]);

export function resolveTaskCategory(
  reasonCode: string | null | undefined,
): InterventionTaskCategory {
  if (!reasonCode) return 'UNCLASSIFIED';
  return REASON_CODE_CATEGORY[reasonCode] ?? 'UNCLASSIFIED';
}

export function resolveReasonCodeLabel(reasonCode: string | null | undefined): string {
  if (!reasonCode) return '未归类';
  return REASON_CODE_LABELS[reasonCode] ?? '未归类';
}

export function isUrgentReasonCode(reasonCode: string | null | undefined): boolean {
  return reasonCode != null && URGENT_REASON_CODES.has(reasonCode);
}

/** 在职事务里只有工伤标急（PRD R5.2）。 */
const WORK_INJURY_PATTERN = /工伤/;

export function resolveBasePriority(params: {
  category: InterventionTaskCategory;
  reasonCode: string | null | undefined;
  reasonText: string;
}): InterventionTaskPriority {
  if (isUrgentReasonCode(params.reasonCode)) return 'urgent';
  if (params.reasonCode === 'employment_affairs' && WORK_INJURY_PATTERN.test(params.reasonText)) {
    return 'urgent';
  }
  return CATEGORY_META[params.category].basePriority;
}

export function maxPriority(
  a: InterventionTaskPriority,
  b: InterventionTaskPriority,
): InterventionTaskPriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}

export function parsePriority(value: unknown): InterventionTaskPriority | null {
  return value === 'urgent' || value === 'today' || value === 'normal' ? value : null;
}
