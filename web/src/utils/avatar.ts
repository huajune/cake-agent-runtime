/**
 * 头像展示共享工具：按名字哈希取渐变背景 + 首字母。
 * 原属 users 模块，reengagement 候选人视角复用后上提到共享层（2026-07-06 review）。
 */

/** 用户头像渐变色方案（按名字哈希轮转） */
export const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
  'linear-gradient(135deg, #7c6ef2 0%, #a78bfa 100%)',
  'linear-gradient(135deg, #818cf8 0%, #c4b5fd 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d8b4fe 100%)',
  'linear-gradient(135deg, #a78bfa 0%, #f0abfc 100%)',
  'linear-gradient(135deg, #6d8df7 0%, #9d8bf8 100%)',
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
