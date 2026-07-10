import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

interface MessageProvenanceLike {
  role: string;
  source?: StorageMessageSource;
  messageType?: StorageMessageType;
  isSelf?: boolean;
  payloadSource?: string;
}

const HUMAN_AGENT_SOURCES = new Set<StorageMessageSource>([
  StorageMessageSource.MOBILE_PUSH,
  StorageMessageSource.AGGREGATED_CHAT_MANUAL,
]);

/**
 * 真人招募经理从企微客户端/聚合聊天手动发出的文本消息。
 *
 * `role=assistant` 只能说明消息方向，不能区分真人与 Agent；必须同时检查
 * source + isSelf + messageType，避免把 API_SEND/AI_REPLY、群邀请等自动消息
 * 当作人工确认事实。
 */
export function isHumanAgentTextMessage(message: MessageProvenanceLike): boolean {
  return (
    message.role === 'assistant' &&
    message.isSelf === true &&
    message.messageType === StorageMessageType.TEXT &&
    message.payloadSource !== 'reengagement' &&
    message.source !== undefined &&
    HUMAN_AGENT_SOURCES.has(message.source)
  );
}
