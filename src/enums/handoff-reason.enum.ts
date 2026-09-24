/**
 * 人工介入原因码权威目录（唯一居所）。
 *
 * 此前四份标签表（request_handoff 工具枚举、转化分析标签、Dashboard 饼图标签、飞书同步脚本）
 * 各自维护字面副本，飞书脚本只剩 10 项、卡片「时效敏感」集合与 intervention 的永久暂停集合
 * 又各自散落。本文件把原因码及其三项属性收拢为一份目录，其余消费方一律从这里派生：
 *
 * - `label`            中文标签（卡片标题 / 饼图 / 飞书表「原因分类」）
 * - `urgent`           卡片标急、飞书任务优先级急
 * - `manualResumeOnly` 暂停到人工在 Dashboard 恢复为止（其余次日零点自动恢复）
 * - `category`         任务大类 T1–T8（谁处理、多久内处理，见 PRD
 *                      `36185ecb1^:docs/todo/prd-ops-followup-2026-09.md` §R5.2——文件已删除，
 *                      用 `git show 36185ecb1^:docs/todo/prd-ops-followup-2026-09.md` 取）
 * - `toolSelectable`   是否允许模型在 request_handoff 里直接选用；系统专用码（入站风险、booking
 *                      侧发、复聊巡检）只由代码写入
 *
 * 本文件零依赖（不 import 任何路径别名）：scripts/sync-handoff-events-to-feishu.js 会经 ts-node
 * 直接加载它，别在这里引入 Nest/业务模块。
 */

export const HANDOFF_TASK_CATEGORY = {
  T1: 'T1',
  T2: 'T2',
  T3: 'T3',
  T4: 'T4',
  T5: 'T5',
  T6: 'T6',
  T7: 'T7',
  T8: 'T8',
} as const;

export type HandoffTaskCategory =
  (typeof HANDOFF_TASK_CATEGORY)[keyof typeof HANDOFF_TASK_CATEGORY];

/** 任务大类：名称 + 时限说明 + 责任人（与 PRD R5.2 大类表一致）。 */
export const HANDOFF_TASK_CATEGORY_META: Record<
  HandoffTaskCategory,
  { name: string; sla: string; owner: string }
> = {
  T1: { name: '现场急件', sla: '15 分钟', owner: '托管账号对应运营' },
  T2: { name: '预约协调', sla: '1 小时', owner: '托管账号对应运营' },
  T3: { name: '面试后跟进', sla: '当日（起算日 18:30）', owner: '托管账号对应运营' },
  T4: { name: '薪资考勤个案', sla: '当日（起算日 18:30）', owner: '运营或结算对接人' },
  T5: { name: '岗位数据/口径缺口', sla: '当日（起算日 18:30）', owner: '岗位数据维护人' },
  T6: { name: '系统卡点', sla: '2 小时', owner: '托管账号对应运营（同时进研发缺陷池）' },
  T7: { name: '风险与合规', sla: '30 分钟', owner: '运营主管' },
  T8: { name: '平台操作问题', sla: '当日（起算日 18:30）', owner: '平台客服对接人' },
};

export interface HandoffReasonDefinition {
  readonly code: string;
  readonly label: string;
  readonly urgent: boolean;
  readonly manualResumeOnly: boolean;
  /** `null` 仅 `other`：真正归不了类。 */
  readonly category: HandoffTaskCategory | null;
  readonly toolSelectable: boolean;
}

/**
 * 目录顺序即 request_handoff 触发场景编号顺序（工具 DESCRIPTION 场景 1–22）；
 * 系统专用码排在模型可选码之后。
 */
export const HANDOFF_REASON_CATALOG: readonly HandoffReasonDefinition[] = [
  // ---- 模型可选（request_handoff 枚举）----
  {
    code: 'cannot_find_store',
    label: '找不到门店',
    urgent: true,
    manualResumeOnly: false,
    category: 'T1',
    toolSelectable: true,
  },
  {
    code: 'no_reception',
    label: '到店无人接待',
    urgent: true,
    manualResumeOnly: false,
    category: 'T1',
    toolSelectable: true,
  },
  {
    code: 'booking_conflict',
    label: '门店查不到预约',
    urgent: true,
    manualResumeOnly: false,
    category: 'T1',
    toolSelectable: true,
  },
  {
    code: 'onboarding_paperwork',
    label: '入职流程对接',
    urgent: false,
    manualResumeOnly: true,
    category: 'T3',
    toolSelectable: true,
  },
  {
    code: 'interview_result_inquiry',
    // 同码也是入站风险类型，label 与交流异常卡片既有口径一致（见文末风险类型段注释）。
    label: '面试结果追问',
    urgent: false,
    manualResumeOnly: true,
    category: 'T3',
    toolSelectable: true,
  },
  {
    code: 'modify_appointment',
    label: '改约/取消自助失败',
    urgent: true,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'self_recruited_or_completed',
    label: '门店自招/已面试通过',
    urgent: false,
    manualResumeOnly: true,
    category: 'T3',
    toolSelectable: true,
  },
  {
    code: 'no_match_or_group_full',
    label: '无匹配岗位且群满',
    urgent: false,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'system_blocked',
    label: '系统卡住需人工补录',
    urgent: false,
    manualResumeOnly: false,
    category: 'T6',
    toolSelectable: true,
  },
  {
    code: 'booking_capacity_full',
    label: '岗位报名名额已满',
    urgent: false,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'group_invite_failed',
    label: '拉群失败需人工维护',
    urgent: false,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'salary_admin_inquiry',
    label: '岗位口径答不上（需补岗位数据）',
    urgent: false,
    manualResumeOnly: false,
    category: 'T5',
    toolSelectable: true,
  },
  {
    code: 'interview_slot_coordination',
    label: '面试时段需人工协调',
    urgent: false,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'identity_age_exception',
    label: '年龄/身份边界需人工裁量',
    urgent: false,
    manualResumeOnly: false,
    category: 'T7',
    toolSelectable: true,
  },
  {
    code: 'store_no_show',
    label: '门店/面试官未履约',
    urgent: true,
    manualResumeOnly: false,
    category: 'T1',
    toolSelectable: true,
  },
  {
    code: 'out_of_band_booking_inquiry',
    label: '带外预约核实',
    urgent: true,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'store_hiring_status_check',
    label: '门店招聘状态核实',
    urgent: false,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'duplicate_signup',
    label: '重复报名核实',
    urgent: false,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: true,
  },
  {
    code: 'employment_affairs',
    label: '在职事务',
    urgent: false,
    manualResumeOnly: true,
    category: 'T3',
    toolSelectable: true,
  },
  {
    code: 'personal_pay_attendance',
    label: '个人薪资考勤个案',
    urgent: false,
    manualResumeOnly: false,
    category: 'T4',
    toolSelectable: true,
  },
  {
    code: 'platform_operation',
    label: '平台操作问题',
    urgent: false,
    manualResumeOnly: false,
    category: 'T8',
    toolSelectable: true,
  },
  {
    code: 'other',
    label: '其他需人工处理',
    urgent: false,
    manualResumeOnly: false,
    category: null,
    toolSelectable: true,
  },
  // ---- 系统专用（代码写入，模型不可选）----
  {
    code: 'interview_group_invite_required',
    label: '预约成功待补发面试群',
    urgent: true,
    manualResumeOnly: false,
    category: 'T2',
    toolSelectable: false,
  },
  {
    code: 'onboarding_failed',
    label: '面试通过后上岗失败',
    urgent: false,
    manualResumeOnly: false,
    category: 'T3',
    toolSelectable: false,
  },
  {
    code: 'onboarding_follow_up_required',
    label: '入职进展待人工确认',
    urgent: false,
    manualResumeOnly: false,
    category: 'T3',
    toolSelectable: false,
  },
  // 入站守卫 / raise_risk_alert 的风险类型（InputRiskType 与 RiskInterventionPayload.riskType）。
  // 这几个码的 label 是交流异常飞书卡片标题「🚨 交流异常 · <label>」既有口径（与 input-rule-catalog
  // 上线以来的卡片文案一致，运营已习惯）；input-rule-catalog.riskLabel 与 raise_risk_alert 的
  // riskLabel 都从本表派生，改文案只改这里。
  {
    code: 'abuse',
    label: '辱骂/攻击',
    urgent: true,
    manualResumeOnly: false,
    category: 'T7',
    toolSelectable: false,
  },
  {
    code: 'complaint_risk',
    label: '投诉/举报风险',
    urgent: true,
    manualResumeOnly: false,
    category: 'T7',
    toolSelectable: false,
  },
  {
    code: 'escalation',
    label: '情绪升级',
    urgent: true,
    manualResumeOnly: false,
    category: 'T7',
    toolSelectable: false,
  },
  {
    code: 'human_handoff_request',
    label: '候选人主动要求人工',
    urgent: true,
    manualResumeOnly: false,
    category: 'T7',
    toolSelectable: false,
  },
  {
    code: 'disability_disclosure',
    label: '候选人披露残障身份',
    urgent: false,
    manualResumeOnly: false,
    category: 'T7',
    toolSelectable: false,
  },
];

const CATALOG_BY_CODE: ReadonlyMap<string, HandoffReasonDefinition> = new Map(
  HANDOFF_REASON_CATALOG.map((item) => [item.code, item]),
);

/** 模型可选原因码（request_handoff 的 z.enum 入参），顺序即工具触发场景编号。 */
export const HANDOFF_REASON_CODES = HANDOFF_REASON_CATALOG.filter(
  (item) => item.toolSelectable,
).map((item) => item.code) as [string, ...string[]];

export type ToolSelectableHandoffReasonCode = (typeof HANDOFF_REASON_CODES)[number];

/** 全量原因码 → 中文标签。 */
export const HANDOFF_REASON_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  HANDOFF_REASON_CATALOG.map((item) => [item.code, item.label]),
);

/** 卡片标急 / 任务优先级急。 */
export const URGENT_HANDOFF_REASON_CODES: ReadonlySet<string> = new Set(
  HANDOFF_REASON_CATALOG.filter((item) => item.urgent).map((item) => item.code),
);

/** 暂停到人工恢复为止（面试后一律真人，2026-09-16 运营裁定）。 */
export const MANUAL_RESUME_HANDOFF_REASON_CODES: ReadonlySet<string> = new Set(
  HANDOFF_REASON_CATALOG.filter((item) => item.manualResumeOnly).map((item) => item.code),
);

/** 门店侧履约问题（周榜按门店/品牌聚合）。 */
export const STORE_NO_SHOW_REASON_CODES: readonly string[] = [
  'store_no_show',
  'no_reception',
  'booking_conflict',
];

export function getHandoffReasonDefinition(code: string): HandoffReasonDefinition | undefined {
  return CATALOG_BY_CODE.get(code);
}

export function getHandoffReasonLabel(code: string, fallback?: string): string {
  return CATALOG_BY_CODE.get(code)?.label ?? fallback ?? code;
}

export function isUrgentHandoffReason(code: string | null | undefined): boolean {
  return code != null && URGENT_HANDOFF_REASON_CODES.has(code);
}

/** 在职事务里只有工伤标急（PRD §R5.2）；reason 文本升急的唯一判定词表。 */
const WORK_INJURY_PATTERN = /工伤/;

/**
 * 卡片标急 / 飞书任务优先级急的唯一判定：码本身标急，或 `employment_affairs` 的 reason
 * 提到工伤（工具 description 要求工伤必须写在 reason 首句）。卡片渲染与任务分类都走这里，
 * 不得各自再按 reason 文本判一遍。
 */
export function isUrgentHandoff(
  code: string | null | undefined,
  reasonText?: string | null,
): boolean {
  if (isUrgentHandoffReason(code)) return true;
  return code === 'employment_affairs' && WORK_INJURY_PATTERN.test(reasonText ?? '');
}

export function requiresManualResumeForReason(code: string | null | undefined): boolean {
  return code != null && MANUAL_RESUME_HANDOFF_REASON_CODES.has(code);
}

export function resolveHandoffTaskCategory(code: string): HandoffTaskCategory | null {
  return CATALOG_BY_CODE.get(code)?.category ?? null;
}
