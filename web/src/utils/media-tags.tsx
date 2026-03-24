/**
 * 媒体消息标记映射和渲染工具
 * 供 ChatSection / HistorySection 共用
 */

// 媒体消息标记 → 样式映射
export const MEDIA_TAG_MAP: Record<string, { icon: string; label: string }> = {
  '图片消息': { icon: '🖼️', label: '图片消息' },
  '语音消息': { icon: '🎤', label: '语音消息' },
  '表情': { icon: '😊', label: '表情' },
  '视频消息': { icon: '🎬', label: '视频消息' },
  '文件': { icon: '📎', label: '文件' },
  '链接': { icon: '🔗', label: '链接' },
  '小程序': { icon: '📱', label: '小程序' },
  '位置': { icon: '📍', label: '位置' },
  '名片': { icon: '👤', label: '名片' },
  '通话记录': { icon: '📞', label: '通话记录' },
  '红包/转账': { icon: '🧧', label: '红包/转账' },
  '已撤回': { icon: '↩️', label: '已撤回' },
};

/**
 * 将文本中的 [图片消息] 等标记渲染为带图标的标签
 */
export function renderContentWithMediaTags(content: string, tagClassName: string) {
  const regex = /\[([^\]]+)\]/g;
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const tag = MEDIA_TAG_MAP[match[1]];
    if (tag) {
      if (match.index > lastIndex) {
        parts.push(content.slice(lastIndex, match.index));
      }
      parts.push(
        <span key={match.index} className={tagClassName}>
          {tag.icon} {tag.label}
        </span>,
      );
      lastIndex = match.index + match[0].length;
    }
  }

  if (lastIndex === 0) return content;
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  return <>{parts}</>;
}
