/**
 * 头像展示共享工具：按名字哈希取渐变背景 + 首字母。
 * 原属 users 模块，reengagement 候选人视角复用后上提到共享层（2026-07-06 review）。
 */

/** 用户头像渐变色方案（按名字哈希轮转） */
export const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #a9b4f0 0%, #b7a0d8 100%)',
  'linear-gradient(135deg, #f3bdf7 0%, #f6a5ae 100%)',
  'linear-gradient(135deg, #a5d0fb 0%, #a9ecf4 100%)',
  'linear-gradient(135deg, #a9ebc3 0%, #a6f0e2 100%)',
  'linear-gradient(135deg, #f8b5c7 0%, #fbe8a8 100%)',
  'linear-gradient(135deg, #c3f3f8 0%, #afc8fb 100%)',
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
