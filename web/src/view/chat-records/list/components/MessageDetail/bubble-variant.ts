const MEDIA_TYPES = new Set(['IMAGE', 'EMOTION', 'VIDEO']);
const CARD_TYPES = new Set([
  'LINK',
  'LOCATION',
  'MINI_PROGRAM',
  'FILE',
  'CONTACT_CARD',
  'VOICE',
]);

/**
 * 判断是否需要「裸」气泡（去掉 padding/背景），由调用方控制外层样式。
 */
export function getBubbleVariant(messageType?: string): 'media' | 'card' | 'default' {
  if (!messageType) return 'default';
  if (MEDIA_TYPES.has(messageType)) return 'media';
  if (CARD_TYPES.has(messageType)) return 'card';
  return 'default';
}
