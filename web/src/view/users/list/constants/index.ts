/**
 * Users 模块常量配置
 */

/**
 * 用户头像渐变色方案（实现已上提到共享层，此处 re-export 保持既有 import 路径）
 */
export { AVATAR_GRADIENTS } from '@/utils/avatar';

/**
 * Tab 配置
 */
export const TAB_CONFIG = {
  TODAY: {
    key: 'today' as const,
    label: '托管用户',
  },
  PAUSED: {
    key: 'paused' as const,
    label: '已禁止托管用户',
  },
} as const;

export const USER_RANGE_OPTIONS = [
  { days: 30, label: '近30天', totalLabel: '30天累计' },
  { days: 60, label: '近60天', totalLabel: '60天累计' },
  { days: 90, label: '近90天', totalLabel: '90天累计' },
] as const;
