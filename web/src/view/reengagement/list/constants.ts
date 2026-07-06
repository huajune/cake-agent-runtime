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
  sent: { label: '已投递', tone: 'success' },
  shadow: { label: 'Shadow', tone: 'neutral' },
  skipped: { label: '预检跳过', tone: 'muted' },
  stopped: { label: '停止条件命中', tone: 'muted' },
  disabled: { label: '开关关闭丢弃', tone: 'muted' },
  frequency_blocked: { label: '频控拦截', tone: 'warning' },
  duplicate: { label: '撞重跳过', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  unknown: { label: '状态不明', tone: 'danger' },
};

export const STATUS_OPTIONS = Object.entries(STATUS_META).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

export function getStatusMeta(status: string): StatusMeta {
  return STATUS_META[status] || { label: status || '-', tone: 'muted' };
}

export const SCENARIO_LABELS: Record<string, string> = {
  opening_no_reply: '开场未回复',
  address_missing: '缺位置信息',
  store_presented_no_reply: '推店后未回复',
  booking_incomplete: '报名信息未收齐',
  interview_reminder: '面试提醒',
  post_interview_followup: '面试后跟进',
  new_job_for_waiting: '等通知新岗推送',
};

export const SCENARIO_OPTIONS = Object.entries(SCENARIO_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export function getScenarioLabel(scenarioCode: string): string {
  return SCENARIO_LABELS[scenarioCode] || scenarioCode || '-';
}
