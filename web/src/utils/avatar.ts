/**
 * 头像展示共享工具：按名字哈希取渐变背景 + 首字母。
 * 原属 users 模块，reengagement 候选人视角复用后上提到共享层（2026-07-06 review）。
 */

/** 用户头像渐变色方案（按名字哈希轮转） */
export const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
] as const;

/** 根据用户名哈希生成头像背景样式 */
export function getAvatarStyle(name: string, gradients: readonly string[] = AVATAR_GRADIENTS) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % gradients.length;
  return {
    background: gradients[index],
    color: '#fff',
    textShadow: '0 1px 2px rgba(0,0,0,0.1)',
  };
}

/** 获取用户名首字母（大写） */
export function getUserInitial(name?: string): string {
  return (name || '?').charAt(0).toUpperCase();
}
