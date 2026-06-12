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
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { isResumeImageDescription } from '@channels/wecom/message/utils/message-parser.util';

const logger = new Logger('save_image_description');

const DESCRIPTION = `保存图片或表情内容描述。当用户发送了图片/表情时，你必须调用此工具，将你对图片或表情的理解保存下来。
如果有多张图片/表情，请按每张分别调用一次，并使用图片前面紧邻的 [图片 messageId=...] 或 [表情 messageId=...] 标签选择对应的 messageId。
- 图片：提取关键事实信息（岗位、薪资、门店、地点、工作要求等），2-3 句简洁中文。
- 简历图片（手写简历 / 简历文档拍照或截图，图片本身就是一份简历时）：描述必须以"简历图片："开头，逐项提取姓名、手机号、年龄、籍贯、学历、工作经历等可见信息；系统会据此把该图片登记为简历附件用于报名。招聘平台的简历列表/岗位页截图不算简历。
- 表情：只写情绪或动作短语，控制在 4-12 个字（如"思考"、"微笑"、"比心"、"点头OK"）；不要描述角色外观、颜色、姿势细节，也不要猜测台词或意图（如"我懂了"、"我在想主意"）。
只提取事实信息，不要添加评价或建议。`;

const inputSchema = z.object({
  messageId: z
    .string()
    .describe(
      '图片或表情消息的 messageId。多张场景请使用对应图片/表情前面的 [图片 messageId=...] 或 [表情 messageId=...] 标签',
    ),
  description: z.string().describe('图片用 2-3 句提取事实；表情只写 4-12 个字的情绪或动作短语'),
});

type VisualKind = MessageType.IMAGE | MessageType.EMOTION;

function resolvePrefix(messageId: string, visualMessageTypes?: Record<string, VisualKind>): string {
  return visualMessageTypes?.[messageId] === MessageType.EMOTION ? '[表情消息]' : '[图片消息]';
}

export function buildSaveImageDescriptionTool(
  chatSession: ChatSessionService,
  imageMessageIds: string[],
  visualMessageTypes?: Record<string, VisualKind>,
  imageUrlsByMessageId?: Record<string, string>,
): ToolBuilder {
  return () => {
    return tool({
      description: DESCRIPTION + `\n可用的 messageId: ${imageMessageIds.join(', ')}`,
      inputSchema,
      execute: async ({ messageId, description }) => {
        if (!imageMessageIds.includes(messageId)) {
          logger.warn(`messageId ${messageId} 不在图片/表情消息列表中，跳过`);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.SAVE_IMAGE_INVALID_MESSAGE_ID,
            outcome: 'messageId 不在当前图片/表情列表中',
            replyInstruction:
              '传入的 messageId 不在本轮可用列表内。检查描述前的 [图片 messageId=...] 或 [表情 messageId=...] 标签后用合法 messageId 重新调用本工具。',
            details: { providedMessageId: messageId, availableMessageIds: imageMessageIds },
          });
        }

        const prefix = resolvePrefix(messageId, visualMessageTypes);
        // 简历图片：与 ImageDescriptionService 预描述路径一致，追加 "简历附件：URL" 行，
        // 让手写简历/简历照片复用 PDF 文件简历的事实提取与报名上传链路。
        const resumeUrl =
          prefix === '[图片消息]' && isResumeImageDescription(description)
            ? imageUrlsByMessageId?.[messageId]
            : undefined;
        const content = resumeUrl
          ? `${prefix} ${description}\n简历附件：${resumeUrl}`
          : `${prefix} ${description}`;
        await chatSession.updateMessageContent(messageId, content);

        logger.log(
          `${prefix} 描述已保存 [${messageId}]${resumeUrl ? '（识别为简历图片，已登记简历附件）' : ''}: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}"`,
        );
        return resumeUrl ? { success: true, resumeAttachmentUrl: resumeUrl } : { success: true };
      },
    });
  };
}
