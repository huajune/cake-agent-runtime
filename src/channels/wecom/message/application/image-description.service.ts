import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ModelRole } from '@/llm/llm.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { MessageType } from '@enums/message-callback.enum';
import { isResumeImageDescription, stripResumeAttachmentLines } from '../utils/message-parser.util';

/** 视觉消息种类：图片 / 表情（都走同一条 vision 识别管线，仅前缀不同）。 */
export type VisualMessageKind = MessageType.IMAGE | MessageType.EMOTION;

/** 调用 loadArtWorkImage 所需的回调上下文。 */
export interface ArtworkContext {
  chatId: string;
  imBotId: string;
  imContactId?: string;
  imRoomId?: string;
}

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
 * 调用方式：fire-and-forget，不阻塞消息主流程；通过 inFlight 追踪让 worker 在
 * 真正读取历史前 awaitVision 等待完成。
 */
@Injectable()
export class ImageDescriptionService {
  private readonly logger = new Logger(ImageDescriptionService.name);

  /** 连续失败计数，用于节流告警 */
  private consecutiveFailures = 0;
  private readonly ALERT_THRESHOLD = 3;

  /** 进行中的描述任务：messageId → 描述完成后 settle 的 Promise */
  private readonly inFlight = new Map<string, Promise<void>>();

  private readonly artworkApiUrl: string;
  private readonly artworkToken: string;

  private readonly SYSTEM_PROMPT = [
    '你是招聘场景的图片分析助手。候选人发来的图片大多是招聘平台截图、证件、简历、招聘海报，也可能是微信表情。',
    '请提取关键信息，用简洁中文输出（一般 2-4 句，证件类必须按下方结构化输出）：',
    '\n- 简历（手写简历 / 简历文档拍照 / 简历截图，图片本身就是一份简历时）：描述必须以"简历图片："开头，再逐项提取姓名、手机号、年龄、籍贯、身高体重、学历、工作经历等图片上可见的信息；看不清的字段写"看不清"，不要猜测。注意：招聘平台的简历列表/岗位页截图不算简历，按截图类处理。',
    '\n- 健康证 / 食品健康证 / 餐饮健康证：必须按"证件类型 / 持有人 / 发证机构 / 有效期至 YYYY-MM-DD（若图片只写到月份则照写到月份）"四个字段逐项输出。日期请按图片上印刷字面照抄，不要凭印象重写月份；多次出现日期时以"有效期至"或"valid until"标注的为准；看不清时写"看不清"。不要判断证件是否过期。',
    '\n- 招聘海报 / 招聘传单 / 含二维码的招聘截图：必须明确指出"含面试二维码 / 含报名二维码 / 含进群二维码"；同时提取品牌、门店、岗位、薪资、地址等关键信息。即使二维码本身无法解码，也要在描述里写"图片含二维码"，不要回复"没有"。',
    '\n- 招聘平台截图（无二维码）：提取岗位名称、薪资、门店/公司、距离、工作要求等关键信息',
    '\n- 地图/位置截图：提取地点名称和位置信息',
    '\n- 聊天截图：提取关键对话内容',
    '\n- 表情包/表情贴图：只输出表情传达的情绪或动作，控制在 4-12 个字，如"思考"、"微笑"、"比心"、"点头OK"；不要描述角色外观、颜色、姿势细节，也不要猜测台词或意图（如"我懂了"、"我在想主意"）',
    '\n不要添加评价、建议或主观判断（如"建议候选人重新办理"），只如实提取图片上看得见的事实。',
  ].join('');

  constructor(
    private readonly llm: LlmExecutorService,
    private readonly chatSession: ChatSessionService,
    private readonly alertService: AlertNotifierService,
    configService: ConfigService,
  ) {
    const baseUrl = configService.get<string>('STRIDE_ENTERPRISE_API_BASE_URL')!;
    this.artworkApiUrl = `${baseUrl}/api/v2/message/loadArtWorkImage`;
    this.artworkToken = configService.get<string>('STRIDE_ENTERPRISE_TOKEN')!;
  }

  /**
   * 异步描述图片/表情并回写 content（fire-and-forget）
   *
   * 进行中的任务会注册到 `inFlight`，供 `awaitVision` 在真正调用 Agent 前等待完成。
   * 这样消息可以立即进入合批队列（更新 lastMessageAt 重置 debounce），
   * 而 vision 描述在后台并行进行，避免文本/图片被合批 debounce 拆开。
   */
  describeAndUpdateAsync(
    messageId: string,
    imageUrl: string,
    kind: VisualMessageKind = MessageType.IMAGE,
  ): void {
    if (this.inFlight.has(messageId)) {
      return;
    }

    const label = this.kindLabel(kind);
    this.logger.log(
      `[触发] 开始${label}描述(异步) [${messageId}], url=${imageUrl.substring(0, 80)}...`,
    );

    const task = this.describeAndUpdate(messageId, imageUrl, kind)
      .catch((error) => {
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
      })
      .finally(() => {
        this.inFlight.delete(messageId);
      });

    this.inFlight.set(messageId, task);
  }

  /**
   * 等待给定 messageIds 对应的 vision 描述全部 settle（成功或失败均算完成）。
   *
   * 已经 settle 或从未触发的 id 视作 no-op；超过 timeoutMs 仍未完成时直接放行，
   * Agent 仍可基于占位文本运行，避免单次 vision 卡死整个回合。
   */
  async awaitVision(messageIds: string[], timeoutMs: number): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const id of messageIds) {
      const task = this.inFlight.get(id);
      if (task) pending.push(task);
    }
    if (pending.length === 0) return;

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const winner = await Promise.race([
        Promise.allSettled(pending).then(() => 'done' as const),
        timeoutPromise,
      ]);
      if (winner === 'timeout') {
        this.logger.warn(
          `[等待 vision] ${timeoutMs}ms 超时未完成 (待完成 ${pending.length} 张)，放行 Agent 继续运行`,
        );
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /** 当前是否有指定 messageId 的描述在进行中。 */
  hasInFlight(messageId: string): boolean {
    return this.inFlight.has(messageId);
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
      kind === MessageType.EMOTION
        ? '请用 4-12 个字描述这个表情传达的情绪或动作。不要描述角色外观、颜色、姿势细节，也不要猜测台词或意图。'
        : '请描述这张图片的内容。';

    const result = await this.llm.generate({
      role: ModelRole.Vision,
      disableFallbacks: true,
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
      maxOutputTokens: kind === MessageType.EMOTION ? 64 : 256,
    });

    const description = result.text.trim();
    if (!description) {
      this.logger.warn(`${this.kindLabel(kind)}描述返回空结果 [${messageId}]`);
      return;
    }

    // 简历图片：追加 "简历附件：URL" 行，让候选人发的手写简历/简历照片走与
    // PDF 文件简历相同的链路 —— extractUploadResume 的标注行分支会捕获该 URL，
    // 流入会话事实 upload_resume → precheck checklist 补齐"简历附件" →
    // booking 经 uploadAttachmentFromUrl 上传图片拿 cloudStorageKey 提交。
    // 先剥离 OCR 描述里可能已带的"简历附件：…"行，再以本服务解析到的权威 URL 追加唯一
    // 一行，避免重复行（badcase chat 6a2fac72…：单条简历消息出现两条相同"简历附件"）。
    const isResumeImage = kind === MessageType.IMAGE && isResumeImageDescription(description);
    const content = isResumeImage
      ? `${formatDescription(kind, stripResumeAttachmentLines(description))}\n简历附件：${imageUrl}`
      : formatDescription(kind, description);

    await this.chatSession.updateMessageContent(messageId, content);

    this.consecutiveFailures = 0;

    this.logger.log(
      `${this.kindLabel(kind)}描述完成 [${messageId}]: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}", tokens=${result.usage.totalTokens}`,
    );
  }

  /**
   * 通过 loadArtWorkImage API 获取原图 URL，失败时回退到压缩图。
   * 调用方应在存储聊天记录前调用，将结果写入 payload.artworkUrl。
   */
  async resolveArtworkUrl(
    messageId: string,
    compressedUrl: string,
    context: ArtworkContext,
  ): Promise<string> {
    try {
      const apiUrl = `${this.artworkApiUrl}?token=${this.artworkToken}`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          chatId: context.chatId,
          imBotId: context.imBotId,
          imContactId: context.imContactId,
          imRoomId: context.imRoomId,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const data = (await res.json()) as { errcode: number; errmsg: string; url?: string };
      if (data.errcode === 0 && data.url) {
        this.logger.log(`[原图] 获取成功 [${messageId}]`);
        return data.url;
      }
      this.logger.warn(`[原图] API 返回 errcode=${data.errcode} [${messageId}]: ${data.errmsg}`);
    } catch (err) {
      this.logger.warn(
        `[原图] 获取失败 [${messageId}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return compressedUrl;
  }

  private kindLabel(kind: VisualMessageKind): string {
    return kind === MessageType.EMOTION ? '表情' : '图片';
  }
}
