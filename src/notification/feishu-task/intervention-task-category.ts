/**
 * 介入原因码 → 飞书任务大类 / 优先级。
 *
 * 原因码的大类（T1–T8）、中文标签、标急三项属性一律从 `@enums/handoff-reason.enum` 权威目录
 * 读取，本文件不再维护任何原因码副本；这里只保留飞书任务侧特有的大类元数据：
 * 机器可算的时限规则、默认优先级、面试上限开关、负责人取向。大类名称同样取自
 * 枚举的 `HANDOFF_TASK_CATEGORY_META.name`（枚举里的 `sla` / `owner` 是展示用文案，
 * 与此处的结构化规则一一对应，见 PRD R5.2 / R6）。
 */

import { Logger } from '@nestjs/common';
import {
  HANDOFF_TASK_CATEGORY_META,
  getHandoffReasonDefinition,
  getHandoffReasonLabel,
  isUrgentHandoffReason,
  type HandoffTaskCategory,
} from '@enums/handoff-reason.enum';

const logger = new Logger('InterventionTaskCategory');

/** 飞书任务大类：T1–T8 + 「未归类」（原因码为空或目录标记归不了类的 `other`）。 */
export type InterventionTaskCategory = HandoffTaskCategory | 'UNCLASSIFIED';

export const UNCLASSIFIED_LABEL = '未归类';

/** 目录里查无此码时的兜底大类：按预约协调（2 小时、托管账号运营）处理并记警告。 */
const UNKNOWN_REASON_FALLBACK_CATEGORY: HandoffTaskCategory = 'T2';

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

/** 飞书任务侧的大类规则（名称取自枚举，其余为本模块特有）。 */
export const CATEGORY_META: Record<InterventionTaskCategory, InterventionTaskCategoryMeta> = {
  T1: {
    code: 'T1',
    label: HANDOFF_TASK_CATEGORY_META.T1.name,
    deadline: { kind: 'working_minutes', minutes: 30 },
    basePriority: 'urgent',
    interviewCapApplies: false,
    owner: 'hosting_account',
  },
  T2: {
    code: 'T2',
    label: HANDOFF_TASK_CATEGORY_META.T2.name,
    deadline: { kind: 'working_minutes', minutes: 120 },
    basePriority: 'today',
    interviewCapApplies: true,
    owner: 'hosting_account',
  },
  T3: {
    code: 'T3',
    label: HANDOFF_TASK_CATEGORY_META.T3.name,
    deadline: { kind: 'same_day_or_next_noon' },
    basePriority: 'today',
    interviewCapApplies: false,
    owner: 'hosting_account',
  },
  T4: {
    code: 'T4',
    label: HANDOFF_TASK_CATEGORY_META.T4.name,
    deadline: { kind: 'working_minutes', minutes: WORKDAY_MINUTES },
    basePriority: 'normal',
    interviewCapApplies: false,
    owner: 'configured',
  },
  T5: {
    code: 'T5',
    label: HANDOFF_TASK_CATEGORY_META.T5.name,
    deadline: { kind: 'working_minutes', minutes: 3 * WORKDAY_MINUTES },
    basePriority: 'normal',
    interviewCapApplies: false,
    owner: 'configured',
  },
  T6: {
    code: 'T6',
    label: HANDOFF_TASK_CATEGORY_META.T6.name,
    deadline: { kind: 'working_minutes', minutes: 120 },
    basePriority: 'today',
    interviewCapApplies: true,
    owner: 'hosting_account',
  },
  T7: {
    code: 'T7',
    label: HANDOFF_TASK_CATEGORY_META.T7.name,
    deadline: { kind: 'working_minutes', minutes: 60 },
    basePriority: 'urgent',
    interviewCapApplies: false,
    owner: 'supervisor',
  },
  T8: {
    code: 'T8',
    label: HANDOFF_TASK_CATEGORY_META.T8.name,
    deadline: { kind: 'same_day_or_next_noon' },
    basePriority: 'today',
    interviewCapApplies: false,
    owner: 'configured',
  },
  UNCLASSIFIED: {
    code: 'UNCLASSIFIED',
    label: UNCLASSIFIED_LABEL,
    deadline: { kind: 'working_minutes', minutes: 120 },
    basePriority: 'today',
    interviewCapApplies: false,
    owner: 'hosting_account',
  },
};

/**
 * 原因码 → 大类：空码或目录标记归不了类（`other`）→ 未归类；
 * 目录里查无此码 → 回退 T2 并记警告（码表漂移应尽快补进权威目录）。
 */
export function resolveTaskCategory(
  reasonCode: string | null | undefined,
): InterventionTaskCategory {
  if (!reasonCode) return 'UNCLASSIFIED';
  const definition = getHandoffReasonDefinition(reasonCode);
  if (!definition) {
    logger.warn(
      `[FeishuTask] 原因码不在权威目录，按 ${UNKNOWN_REASON_FALLBACK_CATEGORY} 处理: reasonCode=${reasonCode}`,
    );
    return UNKNOWN_REASON_FALLBACK_CATEGORY;
  }
  return definition.category ?? 'UNCLASSIFIED';
}

/** 原因码中文标签（飞书单选「原因码」选项名），空码或未知码取「未归类」。 */
export function resolveReasonCodeLabel(reasonCode: string | null | undefined): string {
  if (!reasonCode) return UNCLASSIFIED_LABEL;
  return getHandoffReasonLabel(reasonCode, UNCLASSIFIED_LABEL);
}

export function isUrgentReasonCode(reasonCode: string | null | undefined): boolean {
  return isUrgentHandoffReason(reasonCode);
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
