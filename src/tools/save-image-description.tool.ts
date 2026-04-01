/**
 * 图片描述保存工具 — 主模型支持 vision 时，由 Agent 自行描述图片并回写 DB
 *
 * 替代独立 Vision 模型调用（ImageDescriptionService.describeAndUpdateAsync），
 * 复用主模型已经"看到"的图片理解，避免重复 LLM 调用。
 *
 * 仅在 imageMessageIds 非空时注册（即当前轮次包含图片消息）。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ToolBuilder } from '@shared-types/tool.types';

const logger = new Logger('save_image_description');

const DESCRIPTION = `保存图片内容描述。当用户发送了图片时，你必须调用此工具，将你对图片的理解保存下来。
如果有多张图片，请按每张图片分别调用一次，并使用图片前面紧邻的 [图片 messageId=...] 标签选择对应的 messageId。
提取图片中的关键信息（岗位、薪资、门店、地点、工作要求等），用简洁中文输出 2-3 句话。
只提取事实信息，不要添加评价或建议。`;

const inputSchema = z.object({
  messageId: z
    .string()
    .describe('图片消息的 messageId。多图场景请使用对应图片前面的 [图片 messageId=...] 标签'),
  description: z.string().describe('图片内容的简洁描述（2-3句话，只提取事实信息）'),
});

export function buildSaveImageDescriptionTool(
  chatSession: ChatSessionService,
  imageMessageIds: string[],
): ToolBuilder {
  return () => {
    return tool({
      description: DESCRIPTION + `\n可用的图片 messageId: ${imageMessageIds.join(', ')}`,
      inputSchema,
      execute: async ({ messageId, description }) => {
        if (!imageMessageIds.includes(messageId)) {
          logger.warn(`messageId ${messageId} 不在图片消息列表中，跳过`);
          return { success: false, error: 'Invalid messageId' };
        }

        const content = `[图片消息] ${description}`;
        await chatSession.updateMessageContent(messageId, content);

        logger.log(
          `图片描述已保存 [${messageId}]: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}"`,
        );
        return { success: true };
      },
    });
  };
}
