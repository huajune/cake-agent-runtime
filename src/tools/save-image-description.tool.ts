/**
 * 图片/表情描述保存工具 — 主模型支持 vision 时，由 Agent 自行描述图片/表情并回写 DB
 *
 * 替代独立 Vision 模型调用（ImageDescriptionService.describeAndUpdateAsync），
 * 复用主模型已经"看到"的视觉内容，避免重复 LLM 调用。
 *
 * 仅在 imageMessageIds 非空时注册（即当前轮次包含图片或表情消息）。
 *
 * 视觉事实结构化（visual-fact-structuring，P2 生产者）：主模型看图时顺手给出
 * kind 与 fields，工具内 finalize 补归属默认值后随描述同次落库；kind/fields 缺失
 * 或不合法一律降级 kind=other——行为逐字等同结构化之前。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { MessageType } from '@enums/message-callback.enum';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { BrandResolutionService } from '@resolution/brand/brand-resolution.service';
import {
  VISUAL_FACT_KINDS,
  fieldValues,
  finalizeVisualFactSheet,
  isResumeImageDescription,
  stripResumeAttachmentLines,
} from '@resolution/visual';

const logger = new Logger('save_image_description');

const DESCRIPTION = `保存图片或表情内容描述。当用户发送了图片/表情时，你必须调用此工具，将你对图片或表情的理解保存下来，供后续轮次只读聊天记录时继续理解这张图。
如果有多张图片/表情，请按每张分别调用一次，并使用图片前面紧邻的 [图片 messageId=...] 或 [表情 messageId=...] 标签选择对应的 messageId。
- 图片：像结构化摘录一样保存图片上的关键事实，不要只写泛泛概括；招聘平台截图/岗位卡片必须尽量保留岗位/品牌/门店/地点、薪资及阶梯规则、班次时间、工作内容、工作要求、福利、联系人/来源等可见信息。信息多时用短句或分号组织，允许 3-6 句，优先完整准确而不是过度压缩。若是 Boss直聘岗位页/岗位卡片，岗位标题中形如 "[10239]" 的方括号纯数字是品牌ID；必须保留完整标题，并在描述中写出 "品牌ID：10239"，不要当成岗位ID或普通编号。
- 招聘海报 / 招聘传单 / 含二维码的招聘截图：必须明确指出是否含面试二维码 / 报名二维码 / 进群二维码；同时提取品牌、门店、岗位、薪资、地址等关键信息。
- 简历图片（手写简历 / 简历文档拍照或截图，图片本身就是一份简历时）：描述必须以"简历图片："开头，逐项提取姓名、手机号、年龄、籍贯、学历、工作经历等可见信息；系统会据此把该图片登记为简历附件用于报名。招聘平台的简历列表/岗位页截图不算简历。
- 表情：只写情绪或动作短语，控制在 4-12 个字（如"思考"、"微笑"、"比心"、"点头OK"）；不要描述角色外观、颜色、姿势细节，也不要猜测台词或意图（如"我懂了"、"我在想主意"）。
只提取事实信息，不要添加评价或建议。

同时给出结构化判定（kind 与 fields，帮助系统区分"图里的信息归谁"）：
- kind：job_posting=招聘平台岗位截图/卡片/海报；map_location=地图/定位/导航/门店位置；resume=简历本体；chat_screenshot=聊天记录截图；certificate=健康证等证件；other=其他。
- fields：图上的关键值逐个列出。岗位截图上的电话/年龄要求/薪资是发布方的（ownership=publisher）；候选人自己的简历/证件上的信息是 candidate；聊天截图里分不清归谁就 unknown。岗位页上的"我的地址：XX"/"距我X km"是候选人设备上的地址，key 用 candidate_address。身份证号/证件号不要写进 fields。`;

const inputSchema = z.object({
  messageId: z
    .string()
    .describe(
      '图片或表情消息的 messageId。多张场景请使用对应图片/表情前面的 [图片 messageId=...] 或 [表情 messageId=...] 标签',
    ),
  description: z
    .string()
    .describe(
      '图片完整提取可见关键事实，招聘截图保留岗位/薪资/门店/班次/要求；表情只写 4-12 个字的情绪或动作短语',
    ),
  kind: z
    .enum(VISUAL_FACT_KINDS)
    .optional()
    .describe('图片类型判定；表情消息或无法判定时可省略（按 other 处理）'),
  fields: z
    .array(
      z.object({
        // string 而非 enum：坏 key 由 finalize 白名单过滤，不让整次工具调用校验失败
        key: z.string(),
        value: z.string(),
        ownership: z
          .enum(['candidate', 'publisher', 'third_party', 'unknown'])
          .optional()
          .describe('该值归谁：候选人本人/发布方（招聘方）/其他第三方/不确定；省略按图片类型默认'),
      }),
    )
    .optional()
    .describe('图上的关键结构化值；证件号不要写入'),
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
  brandResolution?: BrandResolutionService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION + `\n可用的 messageId: ${imageMessageIds.join(', ')}`,
      inputSchema,
      execute: async ({ messageId, description, kind, fields }) => {
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
        const sheet = finalizeVisualFactSheet({ kind, fields }, description);
        // 简历判定双保险（并跑对照）：sheet 的 resume kind 与旧文本标记任一命中即走
        // 简历链路；两者不一致记 warn 供并跑对照统计，删旧判据前需一致率达标。
        const legacyResume = isResumeImageDescription(description);
        const sheetResume = !sheet.degraded && sheet.kind === 'resume';
        if (!sheet.degraded && legacyResume !== sheetResume) {
          logger.warn(
            `[visual-fact] resume 判定分歧 [${messageId}]: legacy=${legacyResume} sheet=${sheet.kind}`,
          );
        }
        const resumeUrl =
          prefix === '[图片消息]' && (legacyResume || sheetResume)
            ? imageUrlsByMessageId?.[messageId]
            : undefined;
        const content = resumeUrl
          ? `${prefix} ${stripResumeAttachmentLines(description)}\n简历附件：${resumeUrl}`
          : `${prefix} ${description}`;
        await chatSession.updateMessageContent(
          messageId,
          content,
          sheet.degraded ? undefined : (sheet as unknown as Record<string, unknown>),
        );

        // 视觉事实旁路（镜像品牌域 §10.2）：sheet 挂回合上下文，供同轮工具
        //（invite 城市门等）与 turn-finalizer 消费。
        if (!sheet.degraded && context.onVisualFactsResolved) {
          context.onVisualFactsResolved(sheet, { messageId });
        }

        // 图片品牌解析执行点（§10.2）：描述落库即同步经 resolve() 目录验证，结果挂
        // 回合上下文——状态写入仍只在 turn-finalizer（本轮查询不注入，兜底边界原则）。
        // 表情消息不是品牌来源；解析失败按无品牌降级，不影响描述保存。
        // R2 发布方剔除（badcase 发布方品牌劫持）：sheet 可用且带 brand 字段时只解析
        // 候选人看中的岗位品牌值；publisher 字段（跃橙云服等发布主体）不进品牌解析。
        if (prefix === '[图片消息]' && brandResolution && context.onImageBrandResolved) {
          try {
            const brandInputs =
              !sheet.degraded && sheet.kind === 'job_posting'
                ? fieldValues(sheet, 'brand')
                : [description];
            const brandCorpus = brandInputs.length > 0 ? brandInputs : [description];
            const resolutions = (
              await Promise.all(
                brandCorpus.map((text) => brandResolution.resolve(text, 'image_description')),
              )
            ).flat();
            if (resolutions.length > 0) {
              context.onImageBrandResolved(resolutions, { messageId });
            }
          } catch (error) {
            logger.warn(
              `图片品牌解析失败（按无品牌降级）[${messageId}]: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        logger.log(
          `${prefix} 描述已保存 [${messageId}]${resumeUrl ? '（识别为简历图片，已登记简历附件）' : ''}${sheet.degraded ? '' : ` kind=${sheet.kind} fields=${sheet.fields.length}`}: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}"`,
        );
        return resumeUrl ? { success: true, resumeAttachmentUrl: resumeUrl } : { success: true };
      },
    });
  };
}
