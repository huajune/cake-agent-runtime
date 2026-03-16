/**
 * Users 模块辅助工具函数
 */

/**
 * 根据用户名生成头像样式
 * @param name - 用户名
 * @param gradients - 渐变色数组
 * @returns 头像样式对象
 */
export function getAvatarStyle(name: string, gradients: readonly string[]) {
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

/**
 * 获取用户名首字母（大写）
 * @param name - 用户名或 chatId
 * @returns 首字母大写
 */
export function getUserInitial(name?: string): string {
  return (name || '?').charAt(0).toUpperCase();
}
