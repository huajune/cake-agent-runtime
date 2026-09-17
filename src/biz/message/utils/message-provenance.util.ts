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

const AGENT_REPLY_SOURCES = new Set<StorageMessageSource>([
  StorageMessageSource.API_SEND,
  StorageMessageSource.AI_REPLY,
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

/**
 * Agent 经托管平台 API 发出的对话回复文本。
 *
 * 只认 API_SEND / AI_REPLY 的 TEXT，并排除复聊主动触达（payload.source=reengagement）：
 * 主动触达不是对候选人的应答，不能证明 Agent 仍在接管会话。
 */
export function isAgentReplyTextMessage(message: MessageProvenanceLike): boolean {
  return (
    message.role === 'assistant' &&
    message.messageType === StorageMessageType.TEXT &&
    message.payloadSource !== 'reengagement' &&
    message.source !== undefined &&
    AGENT_REPLY_SOURCES.has(message.source)
  );
}
