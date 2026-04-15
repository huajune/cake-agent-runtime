import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { ConversationStatus } from '@enums/message-merge.enum';

export interface PendingMessage {
  messageData: EnterpriseMessageCallbackDto;
  receivedAt: number;
}

export interface MessageMergeQueue {
  messages: PendingMessage[];
  timer: NodeJS.Timeout;
  firstMessageTime: number;
}

export type MessageProcessorFn = (messages: EnterpriseMessageCallbackDto[]) => Promise<void>;

export interface AgentRequestMetadata {
  startTime: number;
  retryCount: number;
  messageCount: number;
}

export interface ConversationState {
  chatId: string;
  status: ConversationStatus;
  firstMessageTime: number;
  initialTimer?: NodeJS.Timeout;
  pendingMessages: PendingMessage[];
  currentRequest?: AgentRequestMetadata;
  lastUpdateTime: number;
}

export interface PersistableConversationState {
  chatId: string;
  status: ConversationStatus;
  firstMessageTime: number;
  pendingMessages: PendingMessage[];
  currentRequest?: AgentRequestMetadata;
  lastUpdateTime: number;
}
