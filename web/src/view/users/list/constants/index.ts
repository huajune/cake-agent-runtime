/**
 * Users 模块常量配置
 */

/**
 * 用户头像渐变色方案
 * 用于根据用户名哈希生成不同的背景色
 */
export const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
] as const;

/**
 * Tab 配置
 */
export const TAB_CONFIG = {
  TODAY: {
    key: 'today' as const,
    label: '今日托管用户',
  },
  PAUSED: {
    key: 'paused' as const,
    label: '已禁止托管用户',
  },
} as const;
