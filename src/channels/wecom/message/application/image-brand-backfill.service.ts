/**
 * 图片描述缺失的品牌补写链路（§10.3）。
 *
 * 主路径的描述回写靠工具提示词驱动（"你必须调用"），模型可能忘调——该图品牌将
 * 永远进不了 brand_state。turn-finalizer（回合终局确定后）用**结构化 messageType**
 * 检测本轮图片消息缺描述（§10.4：以 ingress 的 MessageType 编码 + save_image_description
 * 工具调用记录为准，不嗅探内容前缀），触发一次异步 Vision 补写；补写完成后走同一条
 * resolve → reducer 链路落状态，带两道防护：
 *   1. 重新持锁：复用渠道层 90s 租约处理锁语义，被占则退避重试，拿不到即放弃；
 *   2. 过期即弃：补写结果轮次早于 brand_state 最后变更时间 → 只弃不写（防时间倒流）。
 *
 * 观测（§12 轻量计数，走日志聚合）："图片无描述"漏调率与"补写过期丢弃"数。
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MessageType } from '@enums/message-callback.enum';
import { BrandResolutionService } from '@resolution/brand/brand-resolution.service';
import { BrandStateService } from '@memory/services/brand-state.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { ImageDescriptionService } from './image-description.service';
import { SimpleMergeService } from '../runtime/simple-merge.service';

export interface MissingImageDescription {
  messageId: string;
  imageUrl: string;
}

const LOCK_RETRY_ATTEMPTS = 5;
const LOCK_RETRY_DELAY_MS = 3000;

@Injectable()
export class ImageBrandBackfillService {
  private readonly logger = new Logger(ImageBrandBackfillService.name);

  /** 漏调计数（模型未调 save_image_description 的图片张数，跨轮累计）。 */
  private missingDescriptionCount = 0;
  /** 补写放弃计数（锁竞争超时）。 */
  private lockGiveUpCount = 0;

  constructor(
    private readonly imageDescription: ImageDescriptionService,
    private readonly brandResolution: BrandResolutionService,
    private readonly brandState: BrandStateService,
    private readonly simpleMerge: SimpleMergeService,
    private readonly alertNotifier: AlertNotifierService,
  ) {}

  /**
   * 结构化检测本轮缺描述的图片（§10.4）：
   * - "本轮有图片消息"以 ingress 的结构化 messageType（MessageType.IMAGE）判定；
   * - "缺描述"以本轮 save_image_description 工具的成功调用记录判定；
   * 内容前缀（[图片消息]）仅是描述文本的渲染约定，不作判定依据。表情不是品牌来源，不补写。
   */
  detectMissingImages(params: {
    imageMessageIds: string[];
    imageUrls: string[];
    visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
    toolCalls: AgentToolCall[] | undefined;
  }): MissingImageDescription[] {
    if (params.imageMessageIds.length === 0) return [];

    const describedIds = new Set<string>();
    for (const call of params.toolCalls ?? []) {
      if (call.toolName !== 'save_image_description') continue;
      const result = call.result as { success?: unknown } | undefined;
      if (result?.success !== true) continue;
      const messageId = (call.args as { messageId?: unknown } | undefined)?.messageId;
      if (typeof messageId === 'string') describedIds.add(messageId);
    }

    const missing: MissingImageDescription[] = [];
    params.imageMessageIds.forEach((messageId, index) => {
      const kind = params.visualMessageTypes?.[messageId] ?? MessageType.IMAGE;
      if (kind !== MessageType.IMAGE) return;
      if (describedIds.has(messageId)) return;
      const imageUrl = params.imageUrls[index];
      if (!imageUrl) return;
      missing.push({ messageId, imageUrl });
    });
    return missing;
  }

  /**
   * 触发异步补写（fire-and-forget）：调用点在回合终局确定、处理锁释放之后。
   * turnMs 为本轮收尾时间戳，作为"过期即弃"的轮次锚点。
   */
  scheduleBackfill(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    chatId: string;
    missing: MissingImageDescription[];
    turnMs: number;
  }): void {
    if (params.missing.length === 0) return;

    this.missingDescriptionCount += params.missing.length;
    this.logger.warn(
      `[image-brand-backfill] 本轮 ${params.missing.length} 张图片缺描述（模型漏调 ` +
        `save_image_description，累计 ${this.missingDescriptionCount} 张），触发异步补写 ` +
        `chatId=${params.chatId}`,
    );

    void this.runBackfill(params).catch((error) => {
      this.logger.warn(
        `[image-brand-backfill] 补写链路异常: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async runBackfill(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    chatId: string;
    missing: MissingImageDescription[];
    turnMs: number;
  }): Promise<void> {
    // 1. Vision 补写描述 + 目录验证解析（锁外：纯读操作，不碰会话状态）。
    const resolutions = [];
    for (const item of params.missing) {
      const description = await this.imageDescription.describeForBackfill(
        item.messageId,
        item.imageUrl,
      );
      if (!description) continue;
      try {
        resolutions.push(...(await this.brandResolution.resolve(description, 'image_description')));
      } catch {
        // 解析失败按无品牌降级；描述本身已写回 DB，下一轮上下文可用
      }
    }
    if (resolutions.length === 0) {
      this.logger.log(
        `[image-brand-backfill] 补写完成但无品牌信号，跳过状态写入 chatId=${params.chatId}`,
      );
      return;
    }

    // 2. 重新持锁（§10.3 第一道防护）：维持"状态迁移在持锁期间完成"的单一门约束。
    const ownerToken = `brand-backfill:${randomUUID()}`;
    let acquired = false;
    for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
      acquired = await this.simpleMerge.acquireProcessingLock(params.chatId, ownerToken);
      if (acquired) break;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
    if (!acquired) {
      this.lockGiveUpCount += 1;
      this.logger.warn(
        `[image-brand-backfill] 处理锁竞争超时放弃补写（累计 ${this.lockGiveUpCount} 次）：` +
          `宁可丢一次图片品牌，不做锁外写 chatId=${params.chatId}`,
      );
      // 观测不能只打日志（项目既定原则）：设计上应罕见的异常必须可见。
      this.alertNotifier
        .sendSimpleAlert(
          '图片品牌补写因锁竞争放弃',
          `chatId=${params.chatId} 的图片品牌补写连续 ${LOCK_RETRY_ATTEMPTS} 次拿不到处理锁，已放弃` +
            `（累计 ${this.lockGiveUpCount} 次）。该图品牌不会进入会话品牌状态；` +
            `频发说明该会话消息处理长期占锁或锁泄漏，需人工排查。`,
          'warning',
        )
        .catch(() => {});
      return;
    }

    try {
      // 3. 过期判定 + reducer 落状态（§10.3 第二道防护在 BrandStateService 内执行）。
      const outcome = await this.brandState.applyLateImageResolutions({
        corpId: params.corpId,
        userId: params.userId,
        sessionId: params.sessionId,
        resolutions,
        resolutionTurnMs: params.turnMs,
      });
      this.logger.log(
        `[image-brand-backfill] 补写落状态结果=${outcome} chatId=${params.chatId} ` +
          `brands=${resolutions.map((r) => r.canonicalName ?? '-').join(',')}`,
      );
      if (outcome === 'dropped_expired') {
        // 过期即弃是防时间倒流的正确行为，但每次发生都值得被看见：
        // 意味着模型漏调描述 + 候选人后续又表达了新品牌意图（信号密集会话）。
        this.alertNotifier
          .sendSimpleAlert(
            '图片品牌补写因过期被丢弃',
            `chatId=${params.chatId} 的图片品牌补写晚于会话品牌状态的最新变更，按"过期即弃"丢弃` +
              `（品牌：${resolutions.map((r) => r.canonicalName ?? '-').join('、')}）。` +
              `属正常防护（不做时间倒流），仅当频发时需关注模型漏调 save_image_description 的比例。`,
            'info',
          )
          .catch(() => {});
      }
    } finally {
      await this.simpleMerge.releaseProcessingLock(params.chatId, ownerToken);
    }
  }
}
