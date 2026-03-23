/**
 * Agent 模块类型定义
 *
 * 注意：枚举类型在 @enums/agent.enum，保持单一职责原则
 */

import { MessageRole } from '@enums/message.enum';

/**
 * 简单消息格式
 */
export interface SimpleMessage {
  role: MessageRole;
  content: string;
}
