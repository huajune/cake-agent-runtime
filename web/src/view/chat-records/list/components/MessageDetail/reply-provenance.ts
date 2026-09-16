import type { ChatMessage } from '@/api/types/chat.types';

/**
 * 托管号侧消息的发出者归属。
 *
 * 判定依据是 chat_messages.source（与后端 message-provenance.util 同口径）：
 * - human：招募经理在企微手机端 / 聚合聊天手打
 * - ai：Agent 经托管平台 API 发出（含复聊）
 * - auto：托管平台 SOP / 定时 / 建群等自动化消息，既非真人也非本 Agent
 */
export type ReplyProvenance = 'human' | 'ai' | 'auto';

const HUMAN_SOURCES = new Set(['MOBILE_PUSH', 'AGGREGATED_CHAT_MANUAL']);
const AI_SOURCES = new Set(['API_SEND', 'AI_REPLY']);
const AUTO_SOURCES = new Set([
  'AUTO_REPLY',
  'ADVANCED_GROUP_SEND_SOP',
  'NEW_CUSTOMER_ANSWER_SOP',
  'TAG_SOP',
  'SCHEDULED_MESSAGE',
  'AUTO_END_CONVERSATION',
  'API_GROUP_SEND',
  'MULTI_GROUP_FORWARD',
  'MULTI_GROUP_REPLAY',
  'OTHER_BOT_REPLY',
  'CREATE_GROUP',
]);

export const REPLY_PROVENANCE_LABEL: Record<ReplyProvenance, string> = {
  human: '真人',
  ai: 'AI',
  auto: '自动',
};

export const REPLY_PROVENANCE_TITLE: Record<ReplyProvenance, string> = {
  human: '招募经理手动回复',
  ai: 'AI 自动回复',
  auto: '托管平台自动化消息（SOP / 定时 / 群操作）',
};

/**
 * 平台代发的操作类消息：入群邀请卡片由 Agent 工具经托管平台发出，回调 source 仍是
 * MOBILE_PUSH，与经理手动邀请无法区分，这类消息不打「真人」标。
 */
const PLATFORM_OPERATION_TYPES = new Set(['ROOM_INVITE', 'SYSTEM', 'WECOM_SYSTEM', 'REVOKE']);

/** 只对托管号侧（isSelf / assistant）消息有意义；来源缺失或未知时返回 undefined，不打标。 */
export function getReplyProvenance(
  message: Pick<ChatMessage, 'source' | 'messageType'>,
): ReplyProvenance | undefined {
  const source = message.source;
  if (!source) return undefined;
  if (HUMAN_SOURCES.has(source)) {
    return message.messageType && PLATFORM_OPERATION_TYPES.has(message.messageType)
      ? undefined
      : 'human';
  }
  if (AI_SOURCES.has(source)) return 'ai';
  if (AUTO_SOURCES.has(source)) return 'auto';
  return undefined;
}
