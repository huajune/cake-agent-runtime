/**
 * Users 模块常量配置
 */

/**
 * 用户头像渐变色方案（实现已上提到共享层，此处 re-export 保持既有 import 路径）
 */
export { AVATAR_GRADIENTS } from '@/utils/avatar';

export const USER_RANGE_OPTIONS = [
  { days: 30, label: '近30天', totalLabel: '30天累计' },
  { days: 60, label: '近60天', totalLabel: '60天累计' },
  { days: 90, label: '近90天', totalLabel: '90天累计' },
  // days=0 = 全部：user_activity 永久保留，后端从业务数据起点算起
  { days: 0, label: '全部', totalLabel: '累计' },
] as const;

/**
 * 暂停来源（user_hosting_status.pause_source）展示文案。
 * 临时禁止列表与永久禁止列表共用，避免同一来源两处叫法不一。
 * 写入点：user.controller(manual) / message-filter.rules(candidate_blacklist)
 * / accept-inbound-message(human_intervention) / intervention.service(intervention)
 */
export const PAUSE_SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  candidate_blacklist: '黑名单命中',
  interview_booking: '面试预约',
  intervention: '人工介入',
  human_intervention: '真人接管',
};

/** 临时禁止的自动解禁口径：后端按暂停时刻之后的第一个零点解禁（非固定 N 天） */
export const TEMPORARY_PAUSE_RESUME_HINT = '次日 0 点';
