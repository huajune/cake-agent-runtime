// 二次触发追溯 — 状态/场景枚举的中文标签与色调

export type ReengagementStatusTone =
  | 'info' // 蓝
  | 'success' // 绿
  | 'neutral' // 灰
  | 'muted' // 浅灰
  | 'warning' // 黄
  | 'danger'; // 红

export interface StatusMeta {
  label: string;
  tone: ReengagementStatusTone;
}

export const STATUS_META: Record<string, StatusMeta> = {
  scheduled: { label: '已排程', tone: 'info' },
  rescheduled: { label: '已改期', tone: 'info' },
  superseded: { label: '已被新任务替代', tone: 'muted' },
  sent: { label: '已投递', tone: 'success' },
  shadow: { label: 'Shadow', tone: 'neutral' },
  skipped: { label: '未发送', tone: 'muted' },
  stopped: { label: '停止条件命中', tone: 'muted' },
  disabled: { label: '开关关闭丢弃', tone: 'muted' },
  frequency_blocked: { label: '频控拦截', tone: 'warning' },
  duplicate: { label: '撞重跳过', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  unknown: { label: '状态不明', tone: 'danger' },
};

export const STATUS_OPTIONS = Object.entries(STATUS_META)
  .filter(([value]) => value !== 'superseded')
  .map(([value, meta]) => ({
    value,
    label: meta.label,
  }));

export function getStatusMeta(status: string): StatusMeta {
  return STATUS_META[status] || { label: status || '-', tone: 'muted' };
}

/**
 * 场景中文名的**离线兜底**：运行时以 /analytics/reengagement-scenarios 返回的
 * displayName（后端 scenario-registry 单一来源）为准，仅在接口未返回时兜底。
 * 文案与 scenario-registry.ts 保持一致，避免与 /config 页显示不同名。
 */
export const SCENARIO_LABELS: Record<string, string> = {
  opening_no_reply: '开场未回',
  address_missing: '缺定位',
  store_presented_no_reply: '推店未回',
  booking_incomplete: '收资未完成',
  interview_reminder: '面试提醒',
  post_interview_followup: '面试后回访',
  new_job_for_waiting: '新岗上线',
};

/** 由注册表接口数据构建 code→displayName 映射；接口未返回时退回本地兜底。 */
export function buildScenarioLabels(
  scenarios?: Array<{ code: string; displayName: string }>,
): Record<string, string> {
  if (!scenarios?.length) return SCENARIO_LABELS;
  return Object.fromEntries(scenarios.map((s) => [s.code, s.displayName]));
}

export function buildScenarioOptions(
  labels: Record<string, string>,
): Array<{ value: string; label: string }> {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}
