import { Injectable, Logger } from '@nestjs/common';
import { CompletionService } from '@agent/completion.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { ModelRole } from '@providers/types';

/**
 * 图片描述服务
 *
 * 异步调用 vision 模型对图片进行描述，将结果回写到 chat_messages.content。
 * 这样短期记忆读取历史时，Agent 能理解图片内容而非仅看到 "[图片消息]"。
 *
 * 模型选择：AGENT_VISION_MODEL → AGENT_CHAT_MODEL（由 RouterService 角色路由处理）
 * 调用方式：fire-and-forget，不阻塞消息主流程。
 */
@Injectable()
export class ImageDescriptionService {
  private readonly logger = new Logger(ImageDescriptionService.name);

  /** 连续失败计数，用于节流告警 */
  private consecutiveFailures = 0;
  private readonly ALERT_THRESHOLD = 3;

  private readonly SYSTEM_PROMPT = [
    '你是招聘场景的图片分析助手。候选人发来的图片大多是招聘平台截图。',
    '请提取关键信息，用简洁中文输出（2-3句话）：',
    '\n- 招聘截图：提取岗位名称、薪资、门店/公司、距离、工作要求等关键信息',
    '\n- 地图/位置截图：提取地点名称和位置信息',
    '\n- 聊天截图：提取关键对话内容',
    '\n- 表情包/无实际信息的图片：简短说明即可',
    '\n不要添加评价或建议，只提取事实信息。',
  ].join('');

  constructor(
    private readonly completionService: CompletionService,
    private readonly chatSession: ChatSessionService,
    private readonly feishuAlert: FeishuAlertService,
  ) {}

  /**
   * 异步描述图片并回写 content（fire-and-forget）
   */
  describeAndUpdateAsync(messageId: string, imageUrl: string): void {
    this.logger.log(`[触发] 开始图片描述 [${messageId}], url=${imageUrl.substring(0, 80)}...`);
    this.describeAndUpdate(messageId, imageUrl).catch((error) => {
      this.consecutiveFailures++;
      this.logger.error(
        `图片描述失败 [${messageId}] (连续第${this.consecutiveFailures}次): ${error.message}`,
        error.stack,
      );

      // 连续失败达到阈值时发送告警
      if (this.consecutiveFailures === this.ALERT_THRESHOLD) {
        this.feishuAlert
          .sendSimpleAlert(
            '图片描述服务连续失败',
            `Vision 模型连续 ${this.ALERT_THRESHOLD} 次调用失败，图片消息无法被识别。\n最近错误: ${error.message}`,
            'warning',
          )
          .catch(() => {});
      }
    });
  }

  /**
   * 调用 vision 模型描述图片，回写到 DB
   */
  private async describeAndUpdate(messageId: string, imageUrl: string): Promise<void> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      this.logger.warn(`无效的图片 URL [${messageId}]: ${imageUrl}`);
      return;
    }

    const result = await this.completionService.generate({
      systemPrompt: this.SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image' as const, image: parsedUrl },
            { type: 'text' as const, text: '请描述这张图片的内容。' },
          ],
        },
      ],
      role: ModelRole.Vision,
      maxOutputTokens: 256,
    });

    const description = result.text.trim();
    if (!description) {
      this.logger.warn(`图片描述返回空结果 [${messageId}]`);
      return;
    }

    const content = `[图片消息] ${description}`;
    await this.chatSession.updateMessageContent(messageId, content);

    // 成功则重置失败计数
    this.consecutiveFailures = 0;

    this.logger.log(
      `图片描述完成 [${messageId}]: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}", tokens=${result.usage.totalTokens}`,
    );
  }
}
