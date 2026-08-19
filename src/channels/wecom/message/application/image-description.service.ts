import { toErrorMessage } from '@infra/utils/error.util';
import { sleep } from '@infra/utils/async.util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ModelRole } from '@/llm/llm.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { MessageType } from '@enums/message-callback.enum';
import {
  VISUAL_FACT_FIELD_KEY_PROMPT,
  VISUAL_FACT_KIND_PROMPT,
  VISUAL_FACT_KINDS,
  finalizeVisualFactSheet,
  isResumeImageDescription,
  sanitizeVisualDescription,
  type FinalizedVisualFactSheet,
} from '@resolution/signal/visual';
import { FIELD_OWNERSHIPS } from '@resolution/signal/types';
import {
  appendResumeAttachmentLine,
  EMOTION_MESSAGE_PREFIX,
  IMAGE_MESSAGE_PREFIX,
} from '@resolution/signal/markers';
import { z } from 'zod';

/** 视觉消息种类：图片 / 表情（都走同一条 vision 识别管线，仅前缀不同）。 */
export type VisualMessageKind = MessageType.IMAGE | MessageType.EMOTION;

/** 调用 loadArtWorkImage 所需的回调上下文。 */
export interface ArtworkContext {
  chatId: string;
  imBotId: string;
  imContactId?: string;
  imRoomId?: string;
}

/** P1 结构化输出 schema：描述 + kind + fields（归属可缺省，finalize 按 kind 补）。 */
const VISION_SHEET_SCHEMA = z.object({
  description: z.string().describe('图片内容的中文描述，遵循系统提示词里的各类图片提取要求'),
  kind: z.enum(VISUAL_FACT_KINDS).describe(VISUAL_FACT_KIND_PROMPT),
  fields: z
    .array(
      z.object({
        // string 而非 enum（白名单过滤在 finalize 做）；词表写进 describe 保持模型可见
        key: z.string().describe(VISUAL_FACT_FIELD_KEY_PROMPT),
        value: z.string(),
        ownership: z
          .enum(FIELD_OWNERSHIPS)
          .optional()
          .describe('该值归谁：候选人本人/发布方（招聘方）/其他第三方/不确定'),
      }),
    )
    .default([])
    .describe('图上的关键结构化值；身份证号/证件号不要写入'),
});

function formatDescription(kind: VisualMessageKind, description: string): string {
  const prefix = kind === MessageType.EMOTION ? EMOTION_MESSAGE_PREFIX : IMAGE_MESSAGE_PREFIX;
  return `${prefix} ${description}`;
}

/**
 * 图片描述服务
 *
 * 异步调用 vision 模型对图片进行描述，将结果回写到 chat_messages.content。
 * 这样短期记忆读取历史时，Agent 能理解图片内容而非仅看到 "[图片消息]"。
 *
 * 模型选择：Vision 角色路由（显式覆盖 > Dashboard 角色覆盖 > AGENT_VISION_MODEL），
 * disableFallbacks 不做跨角色降级；结构化输出失败时同角色回退纯文本描述。
 * 调用方式：fire-and-forget，不阻塞消息主流程；inFlight 追踪供运行时降级重跑路径
 * （reply-workflow 的 awaitVision）等待完成，并为各兜底触发做同 messageId 去重。
 */
@Injectable()
export class ImageDescriptionService {
  private readonly logger = new Logger(ImageDescriptionService.name);

  /** 连续失败计数，用于节流告警 */
  private consecutiveFailures = 0;
  private readonly ALERT_THRESHOLD = 3;

  // 回写重试：入站历史 insert 是 fire-and-forget（约 500ms-2s），vision 描述完成时目标行可能尚未
  // 落库，updateContentByMessageId 找不到行会静默丢失描述。命中「无匹配行」时退避重试，给 insert
  // 兜底时间。
  private readonly WRITEBACK_MAX_ATTEMPTS = 4;
  private readonly WRITEBACK_RETRY_BASE_DELAY_MS = 500;

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
    '\n- 招聘平台截图（无二维码）：提取岗位名称、薪资、门店/公司、距离、工作要求等关键信息。Boss直聘岗位页/岗位卡片的标题里若出现形如"[10239]"的方括号纯数字，这是品牌ID；必须逐字保留完整岗位标题，并额外写一项"品牌ID：10239"，不要改写、丢弃或当成岗位ID。',
    '\n- 地图/位置截图：提取地点名称和位置信息',
    '\n- 聊天截图：提取关键对话内容',
    '\n- 表情包/表情贴图：只输出表情传达的情绪或动作，控制在 4-12 个字，如"思考"、"微笑"、"比心"、"点头OK"；不要描述角色外观、颜色、姿势细节，也不要猜测台词或意图（如"我懂了"、"我在想主意"）',
    '\n不要添加评价、建议或主观判断（如"建议候选人重新办理"），只如实提取图片上看得见的事实。',
  ].join('');

  /** 结构化输出补充口径（仅结构化路径附加）。 */
  private readonly STRUCTURED_SUFFIX = [
    '\n\n同时给出结构化判定：kind 按图片类型；流程状态类界面（视频会议等待页/AI面试结束页/订单日程页/审核结果页等）归 other，不要硬塞进最近的类；fields 逐个列出图上的关键值并标注归属（ownership）。',
    '岗位截图上的电话/年龄要求/薪资是发布方的（publisher）；候选人自己的简历/证件上的信息是 candidate；',
    '聊天截图里分不清归谁就 unknown。岗位页上的"我的地址：XX"/"距我X km"是候选人设备上的地址，key 用 candidate_address。',
    '身份证号/证件号不要写进 fields。',
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
      .then(() => undefined)
      .catch((error) => {
        this.consecutiveFailures++;
        let err: Error;
        if (error instanceof Error) {
          err = error;
        } else {
          err = new Error(String(error));
        }
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
   * 描述缺失的异步补写（§10.3）：主路径模型漏调 save_image_description 时，
   * turn 收尾后由补写链路调用。返回描述文本供品牌解析；失败/并行任务已在跑时返回 null。
   */
  async describeForBackfill(messageId: string, imageUrl: string): Promise<string | null> {
    const existing = this.inFlight.get(messageId);
    if (existing) {
      // 兼容路径的预转写已在跑：描述会由该任务写回，本次不重复调 vision。
      await existing.catch(() => {});
      return null;
    }

    const run = this.describeAndUpdate(messageId, imageUrl, MessageType.IMAGE);
    this.inFlight.set(
      messageId,
      run.then(() => undefined).catch(() => undefined),
    );
    try {
      const description = await run;
      this.consecutiveFailures = 0;
      return description;
    } catch (error) {
      this.logger.warn(`图片描述补写失败 [${messageId}]: ${toErrorMessage(error)}`);
      return null;
    } finally {
      this.inFlight.delete(messageId);
    }
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
   * 调用 vision 模型描述图片/表情，回写到 DB。返回描述文本（无效 URL/空结果返回 null）。
   */
  private async describeAndUpdate(
    messageId: string,
    imageUrl: string,
    kind: VisualMessageKind,
  ): Promise<string | null> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      this.logger.warn(`无效的${this.kindLabel(kind)} URL [${messageId}]: ${imageUrl}`);
      return null;
    }

    const promptText =
      kind === MessageType.EMOTION
        ? '请用 4-12 个字描述这个表情传达的情绪或动作。不要描述角色外观、颜色、姿势细节，也不要猜测台词或意图。'
        : '请描述这张图片的内容。';

    // 视觉事实结构化（P1 生产者）：图片优先走结构化输出（描述 + kind + fields）；
    // 任何失败回退纯文本路径——降级不是失败，纯文本描述本身就是可用产物。表情不结构化。
    let description = '';
    let sheet: FinalizedVisualFactSheet | null = null;
    let usageTokens: number | undefined;
    if (kind !== MessageType.EMOTION) {
      try {
        const structured = await this.llm.generateStructured({
          role: ModelRole.Vision,
          disableFallbacks: true,
          schema: VISION_SHEET_SCHEMA,
          outputName: 'VisualFactSheet',
          system: this.SYSTEM_PROMPT + this.STRUCTURED_SUFFIX,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image' as const, image: parsedUrl },
                { type: 'text' as const, text: promptText },
              ],
            },
          ],
          maxOutputTokens: 512,
        });
        const out = structured.output as z.infer<typeof VISION_SHEET_SCHEMA>;
        description = (out.description ?? '').trim();
        if (description) {
          const finalized = finalizeVisualFactSheet(
            { kind: out.kind, fields: out.fields ?? [] },
            description,
          );
          sheet = finalized.degraded ? null : finalized;
        }
        usageTokens = structured.usage?.totalTokens;
      } catch (error) {
        this.logger.warn(`图片结构化描述失败，回退纯文本 [${messageId}]: ${toErrorMessage(error)}`);
      }
    }
    if (!description) {
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
      description = result.text.trim();
      usageTokens = result.usage.totalTokens;
    }
    if (!description) {
      this.logger.warn(`${this.kindLabel(kind)}描述返回空结果 [${messageId}]`);
      return null;
    }
    // 证件号脱敏：sheet 侧 finalizeVisualFactSheet 内部已做，这里补 content 一侧，
    // 保证 chat_messages 的 content 与 visual_facts 同源同脱敏（红标 2，chat 6a1e42e6）。
    description = sanitizeVisualDescription(description);

    // 简历图片：追加 "简历附件：URL" 行，让候选人发的手写简历/简历照片走与
    // PDF 文件简历相同的链路 —— extractUploadResume 的标注行分支会捕获该 URL，
    // 流入会话事实 upload_resume → precheck checklist 补齐"简历附件" →
    // booking 经 uploadAttachmentFromUrl 上传图片拿 cloudStorageKey 提交。
    // 先剥离视觉描述里可能已带的"简历附件：…"行，再以本服务解析到的权威 URL 追加唯一
    // 一行，避免重复行（badcase chat 6a2fac72…：单条简历消息出现两条相同"简历附件"）。
    // 简历判定双保险（并跑对照）：sheet resume kind 与旧文本标记任一命中即走简历链路。
    // A1（2026-08-11）仅覆盖当前容器连续 92h23m，分歧为 0；尚未达到完整 7 天
    // 删除门槛，故继续保留 legacy 判据。连续 7 天复扫仍为 0 后删除本并跑与 OR 路径。
    const legacyResume = kind === MessageType.IMAGE && isResumeImageDescription(description);
    const sheetResume = sheet?.kind === 'resume';
    if (sheet && legacyResume !== sheetResume) {
      this.logger.warn(
        `[visual-fact] resume 判定分歧 [${messageId}]: legacy=${legacyResume} sheet=${sheet.kind}`,
      );
    }
    const isResumeImage = legacyResume || (kind === MessageType.IMAGE && sheetResume);
    const content = isResumeImage
      ? appendResumeAttachmentLine(formatDescription(kind, description), imageUrl)
      : formatDescription(kind, description);

    await this.writeBackDescription(messageId, content, kind, sheet ?? undefined);

    this.consecutiveFailures = 0;

    this.logger.log(
      `${this.kindLabel(kind)}描述完成 [${messageId}]: "${description.substring(0, 50)}${description.length > 50 ? '...' : ''}", tokens=${usageTokens ?? 0}`,
    );
    return description;
  }

  /** 每会话懒补写节流（5 分钟）：同一会话高频回合不重复扫裸图。 */
  private readonly backfillLastRunByChat = new Map<string, number>();
  private static readonly BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;

  /**
   * 读时懒补写（2026-08-05 描述缺失归因修复）：回合开始时补写本会话仍是
   * 裸 `[图片消息]` 占位的历史图片描述。
   *
   * 归因实证（30 条裸占位抽样）：90% 是人工接管/非托管时段经 MOBILE_PUSH 同步
   * 进历史的候选人图片——从不进 Agent 链路（无回合 → P2 与漏调兜底都覆盖不到），
   * 其余为 timeout 丢回合。这些图 URL 均可达、vision 均可识别（14/14 批测实证），
   * 纯粹没人去描述。托管恢复后 Agent 读窗口时对它们全盲。
   *
   * fire-and-forget：本轮不阻塞（描述落库 + 缓存失效后下一轮窗口即可见）；
   * 每会话 5 分钟节流 + 单次最多 3 张 + describeAndUpdateAsync 自带同 messageId
   * 去重。只补图片，不补表情（旧表情描述价值低）。
   */
  backfillBareDescriptionsForChat(chatId: string): void {
    const last = this.backfillLastRunByChat.get(chatId) ?? 0;
    if (Date.now() - last < ImageDescriptionService.BACKFILL_COOLDOWN_MS) return;
    this.backfillLastRunByChat.set(chatId, Date.now());

    void (async () => {
      try {
        const bare = await this.chatSession.getBareVisualMessages(chatId, {
          sinceTimestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
          limit: 6,
        });
        const images = bare
          .filter((row) => row.content.trim() === IMAGE_MESSAGE_PREFIX)
          .slice(0, 3);
        for (const row of images) {
          const payload = row.payload ?? {};
          const url = [payload.artworkUrl, payload.fileUrl, payload.url, payload.imageUrl].find(
            (v): v is string => typeof v === 'string' && v.startsWith('http'),
          );
          if (!url) continue;
          this.logger.log(`[懒补写] 裸图片描述补写触发 [${row.messageId}] (chat=${chatId})`);
          this.describeAndUpdateAsync(row.messageId, url, MessageType.IMAGE);
        }
      } catch (error) {
        this.logger.warn(`[懒补写] 裸图片扫描失败 [${chatId}]: ${toErrorMessage(error)}`);
      }
    })();
  }

  /**
   * 把 vision 描述回写到 chat_messages.content。命中「无匹配行」（updateMessageContent 返回 false）
   * 时退避重试——历史 insert 是 fire-and-forget，回写时目标行可能尚未落库；不重试会静默丢描述，
   * 导致 Agent 只看到 "[图片消息]" 占位文本。
   */
  private async writeBackDescription(
    messageId: string,
    content: string,
    kind: VisualMessageKind,
    sheet?: FinalizedVisualFactSheet,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.WRITEBACK_MAX_ATTEMPTS; attempt++) {
      let updated = false;
      try {
        updated = await this.chatSession.updateMessageContent(
          messageId,
          content,
          sheet as unknown as Record<string, unknown> | undefined,
        );
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        this.logger.warn(
          `${this.kindLabel(kind)}描述回写异常（第 ${attempt}/${this.WRITEBACK_MAX_ATTEMPTS} 次）[${messageId}]: ${errorMessage}`,
        );
      }
      if (updated) return;

      if (attempt < this.WRITEBACK_MAX_ATTEMPTS) {
        await sleep(this.WRITEBACK_RETRY_BASE_DELAY_MS * attempt);
      }
    }

    this.logger.error(
      `${this.kindLabel(kind)}描述回写失败：chat_messages 无匹配行或更新异常（已重试 ${this.WRITEBACK_MAX_ATTEMPTS} 次，历史可能始终未落库）[${messageId}]`,
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
      this.logger.warn(`[原图] 获取失败 [${messageId}]: ${toErrorMessage(err)}`);
    }
    return compressedUrl;
  }

  private kindLabel(kind: VisualMessageKind): string {
    return kind === MessageType.EMOTION ? '表情' : '图片';
  }
}
