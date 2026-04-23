/**
 * 图片/表情描述保存工具 — 主模型支持 vision 时，由 Agent 自行描述图片/表情并回写 DB
 *
 * 替代独立 Vision 模型调用（ImageDescriptionService.describeAndUpdateAsync），
 * 复用主模型已经"看到"的视觉内容，避免重复 LLM 调用。
 *
 * 仅在 imageMessageIds 非空时注册（即当前轮次包含图片或表情消息）。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { MessageType } from '@enums/message-callback.enum';

const logger = new Logger('save_image_description');

const DESCRIPTION = `保存图片或表情内容描述。当用户发送了图片/表情时，你必须调用此工具，将你对图片或表情的理解保存下来。
如果有多张图片/表情，请按每张分别调用一次，并使用图片前面紧邻的 [图片 messageId=...] 或 [表情 messageId=...] 标签选择对应的 messageId。
- 图片：提取关键事实信息（岗位、薪资、门店、地点、工作要求等），2-3 句简洁中文。
- 表情：直接描述表情传达的情绪或动作（如"微笑"、"比心"、"点头OK"），不要强行脑补语义。
只提取事实信息，不要添加评价或建议。`;

const inputSchema = z.object({
  messageId: z
    .string()
    .describe(
      '图片或表情消息的 messageId。多张场景请使用对应图片/表情前面的 [图片 messageId=...] 或 [表情 messageId=...] 标签',
    ),
  description: z.string().describe('图片/表情内容的简洁描述（2-3句话，只提取事实信息）'),
});

type VisualKind = MessageType.IMAGE | MessageType.EMOTION;

function resolvePrefix(messageId: string, visualMessageTypes?: Record<string, VisualKind>): string {
  return visualMessageTypes?.[messageId] === MessageType.EMOTION ? '[表情消息]' : '[图片消息]';
}

export function buildSaveImageDescriptionTool(
  chatSession: ChatSessionService,
  imageMessageIds: string[],
  visualMessageTypes?: Record<string, VisualKind>,
): ToolBuilder {
  return () => {
    return tool({
      description: DESCRIPTION + `\n可用的 messageId: ${imageMessageIds.join(', ')}`,
      inputSchema,
      execute: async ({ messageId, description }) => {
        if (!imageMessageIds.includes(messageId)) {
          logger.warn(`messageId ${messageId} 不在图片/表情消息列表中，跳过`);
          return { success: false, error: 'Invalid messageId' };
        }

        const prefix = resolvePrefix(messageId, visualMessageTypes);
        const content = `${prefix} ${description}`;
        await chatSession.updateMessageContent(messageId, content);

        logger.log(
          `${prefix} 描述已保存 [${messageId}]: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}"`,
        );
        return { success: true };
      },
    });
  };
}
