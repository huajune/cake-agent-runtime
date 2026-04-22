import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ModelRole } from '@/llm/llm.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { MessageType } from '@enums/message-callback.enum';

/** 视觉消息种类：图片 / 表情（都走同一条 vision 识别管线，仅前缀不同）。 */
export type VisualMessageKind = MessageType.IMAGE | MessageType.EMOTION;

function formatDescription(kind: VisualMessageKind, description: string): string {
  const prefix = kind === MessageType.EMOTION ? '[表情消息]' : '[图片消息]';
  return `${prefix} ${description}`;
}

/**
 * 图片描述服务
 *
 * 异步调用 vision 模型对图片进行描述，将结果回写到 chat_messages.content。
 * 这样短期记忆读取历史时，Agent 能理解图片内容而非仅看到 "[图片消息]"。
 *
 * 模型选择：AGENT_VISION_MODEL → AGENT_CHAT_MODEL（由共享 LLM Executor 做角色路由）
 * 调用方式：fire-and-forget，不阻塞消息主流程。
 */
@Injectable()
export class ImageDescriptionService {
  private readonly logger = new Logger(ImageDescriptionService.name);

  /** 连续失败计数，用于节流告警 */
  private consecutiveFailures = 0;
  private readonly ALERT_THRESHOLD = 3;

  private readonly SYSTEM_PROMPT = [
    '你是招聘场景的图片分析助手。候选人发来的图片大多是招聘平台截图，也可能是微信表情。',
    '请提取关键信息，用简洁中文输出（2-3句话）：',
    '\n- 招聘截图：提取岗位名称、薪资、门店/公司、距离、工作要求等关键信息',
    '\n- 地图/位置截图：提取地点名称和位置信息',
    '\n- 聊天截图：提取关键对话内容',
    '\n- 表情包/表情贴图：描述表情传达的情绪或动作（如"微笑"、"比心"、"点头OK"），不要强行脑补语义',
    '\n不要添加评价或建议，只提取事实信息。',
  ].join('');

  constructor(
    private readonly llm: LlmExecutorService,
    private readonly chatSession: ChatSessionService,
    private readonly alertService: AlertNotifierService,
  ) {}

  /**
   * 异步描述图片/表情并回写 content（fire-and-forget）
   * 适用于主模型支持 vision 的场景（当轮由 Agent 直接看图，此描述仅补充后续轮次）
   */
  describeAndUpdateAsync(
    messageId: string,
    imageUrl: string,
    kind: VisualMessageKind = MessageType.IMAGE,
  ): void {
    const label = this.kindLabel(kind);
    this.logger.log(
      `[触发] 开始${label}描述(异步) [${messageId}], url=${imageUrl.substring(0, 80)}...`,
    );
    this.describeAndUpdate(messageId, imageUrl, kind).catch((error) => {
      this.consecutiveFailures++;
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `${label}描述失败 [${messageId}] (连续第${this.consecutiveFailures}次): ${err.message}`,
        err.stack,
      );

      // 连续失败达到阈值时发送告警
      if (this.consecutiveFailures === this.ALERT_THRESHOLD) {
        this.alertService
          .sendSimpleAlert(
            '图片/表情描述服务连续失败',
            `Vision 模型连续 ${this.ALERT_THRESHOLD} 次调用失败，图片/表情消息无法被识别。\n最近错误: ${err.message}`,
            'warning',
          )
          .catch(() => {});
      }
    });
  }

  /**
   * 同步描述图片/表情并回写 content（阻塞等待结果）
   * 适用于主模型不支持 vision 的场景 — 必须在 Agent 读历史前完成描述
   */
  async describeAndUpdateSync(
    messageId: string,
    imageUrl: string,
    kind: VisualMessageKind = MessageType.IMAGE,
  ): Promise<void> {
    const label = this.kindLabel(kind);
    this.logger.log(
      `[触发] 开始${label}描述(同步) [${messageId}], url=${imageUrl.substring(0, 80)}...`,
    );
    try {
      await this.describeAndUpdate(messageId, imageUrl, kind);
    } catch (error) {
      this.consecutiveFailures++;
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `${label}描述失败 [${messageId}] (连续第${this.consecutiveFailures}次): ${err.message}`,
        err.stack,
      );

      if (this.consecutiveFailures === this.ALERT_THRESHOLD) {
        this.alertService
          .sendSimpleAlert(
            '图片/表情描述服务连续失败',
            `Vision 模型连续 ${this.ALERT_THRESHOLD} 次调用失败，图片/表情消息无法被识别。\n最近错误: ${err.message}`,
            'warning',
          )
          .catch(() => {});
      }
      // 同步路径不抛出异常，避免阻塞主流程
    }
  }

  /**
   * 调用 vision 模型描述图片/表情，回写到 DB
   */
  private async describeAndUpdate(
    messageId: string,
    imageUrl: string,
    kind: VisualMessageKind,
  ): Promise<void> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      this.logger.warn(`无效的${this.kindLabel(kind)} URL [${messageId}]: ${imageUrl}`);
      return;
    }

    const promptText =
      kind === MessageType.EMOTION ? '请描述这个表情传达的情绪或动作。' : '请描述这张图片的内容。';

    const result = await this.llm.generate({
      role: ModelRole.Vision,
      system: this.SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image' as const, image: parsedUrl },
            { type: 'text' as const, text: promptText },
          ],
        },
      ],
      maxOutputTokens: 256,
    });

    const description = result.text.trim();
    if (!description) {
      this.logger.warn(`${this.kindLabel(kind)}描述返回空结果 [${messageId}]`);
      return;
    }

    await this.chatSession.updateMessageContent(messageId, formatDescription(kind, description));

    // 成功则重置失败计数
    this.consecutiveFailures = 0;

    this.logger.log(
      `${this.kindLabel(kind)}描述完成 [${messageId}]: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}", tokens=${result.usage.totalTokens}`,
    );
  }

  private kindLabel(kind: VisualMessageKind): string {
    return kind === MessageType.EMOTION ? '表情' : '图片';
  }
}
