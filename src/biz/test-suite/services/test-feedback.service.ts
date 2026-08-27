import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AgentTestFeedback, FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';
import { RedisService } from '@infra/redis/redis.service';
import { SubmitFeedbackRequestDto } from '../dto/test-chat.dto';

/** 单张截图解码后大小上限 */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** 截图经 base64 编码后仍需和聊天记录一起落在全局 20MB JSON 请求上限内 */
const MAX_TOTAL_SCREENSHOT_BYTES = 10 * 1024 * 1024;
/**
 * 反馈防重窗口：同类型 + 同聊天记录全文视为同一条反馈。
 * 生产重复簇（同内容连提 2~5 次）间隔从 5 秒到 12 分钟不等，24h 窗口同时挡住
 * 「超时误判后重试」和「隔天忘了已反馈过」两类重复。
 */
const FEEDBACK_DEDUP_TTL_SECONDS = 24 * 60 * 60;
const FEEDBACK_DEDUP_KEY_PREFIX = 'test-suite:feedback:dedup:';

interface FeedbackDedupValue {
  recordId?: string;
  submittedAt: string;
}

@Injectable()
export class TestFeedbackService {
  private readonly logger = new Logger(TestFeedbackService.name);

  constructor(
    private readonly feishuBitableService: FeishuBitableSyncService,
    private readonly redisService: RedisService,
  ) {}

  async submitFeedback(request: SubmitFeedbackRequestDto) {
    this.assertScreenshotSizes(request.screenshots);

    const typeLabel = request.type === 'goodcase' ? 'GoodCase' : 'BadCase';
    const dedupKey = this.buildDedupKey(request);
    const acquired = await this.tryAcquireDedupSlot(dedupKey);
    if (!acquired) {
      const prior = await this.readDedupValue(dedupKey);
      this.logger.warn(
        `[Feedback] 拦截重复提交 type=${request.type} priorRecordId=${prior?.recordId ?? 'unknown'}`,
      );
      return {
        success: true,
        data: {
          recordId: prior?.recordId,
          type: request.type,
          duplicate: true,
          message: `相同内容的 ${typeLabel} 在 24 小时内已提交过，本次未重复写入飞书；若要反馈同一会话的另一个问题，请更换分类后重新提交`,
        },
      };
    }

    const feedback: AgentTestFeedback = {
      type: request.type,
      chatHistory: request.chatHistory,
      userMessage: request.userMessage,
      errorType: request.errorType,
      priority: request.priority,
      expectedBehavior: request.expectedBehavior,
      remark: request.remark,
      chatId: request.chatId,
      messageId: request.messageId,
      traceId: request.traceId,
      batchId: request.batchId,
      sourceTrace: request.sourceTrace,
      candidateName: request.candidateName,
      managerName: request.managerName,
      source: request.source,
      screenshots: request.screenshots,
    };

    const result = await this.feishuBitableService.writeAgentTestFeedback(feedback);
    if (!result.success) {
      // 写入失败要释放去重位，否则用户修复问题后的正当重试会被误拦 24 小时
      await this.releaseDedupSlot(dedupKey);
      throw new Error(result.error || '写入飞书表格失败');
    }

    await this.recordDedupResult(dedupKey, result.recordId);

    return {
      success: true,
      data: {
        recordId: result.recordId,
        type: request.type,
        message: `${typeLabel} 已成功写入飞书表格`,
      },
    };
  }

  /**
   * 防重键 = 反馈类型 + 分类 + 聊天记录全文哈希。
   * 生产重复行里 traceId/chatId 多为空而聊天记录全文逐字节一致，故以内容为准；
   * 分类纳入键是为放行「同一会话按不同问题分类各立一案」的合法场景——
   * 生产实测存在同会话 5 个分类各提一次的用法，只有同分类的盲目重试才拦。
   * 追加了新消息的会话哈希不同，也不会被误拦。
   */
  private buildDedupKey(request: SubmitFeedbackRequestDto): string {
    const digest = createHash('sha256')
      .update(`${request.type}\n${request.errorType || ''}\n${(request.chatHistory || '').trim()}`)
      .digest('hex')
      .slice(0, 32);
    return `${FEEDBACK_DEDUP_KEY_PREFIX}${digest}`;
  }

  /** Redis 异常时放行写入（fail-open）：防重是兜底，不能反过来挡住正常反馈 */
  private async tryAcquireDedupSlot(key: string): Promise<boolean> {
    try {
      const value: FeedbackDedupValue = { submittedAt: new Date().toISOString() };
      return await this.redisService.setNx(key, value, FEEDBACK_DEDUP_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`[Feedback] 防重检查失败，放行写入: ${(error as Error).message}`);
      return true;
    }
  }

  private async readDedupValue(key: string): Promise<FeedbackDedupValue | null> {
    try {
      return await this.redisService.get<FeedbackDedupValue>(key);
    } catch {
      return null;
    }
  }

  private async recordDedupResult(key: string, recordId?: string): Promise<void> {
    try {
      const value: FeedbackDedupValue = { recordId, submittedAt: new Date().toISOString() };
      await this.redisService.setex(key, FEEDBACK_DEDUP_TTL_SECONDS, value);
    } catch (error) {
      this.logger.warn(`[Feedback] 回填防重记录失败: ${(error as Error).message}`);
    }
  }

  private async releaseDedupSlot(key: string): Promise<void> {
    try {
      await this.redisService.del(key);
    } catch (error) {
      this.logger.warn(`[Feedback] 释放防重键失败: ${(error as Error).message}`);
    }
  }

  private assertScreenshotSizes(screenshots?: string[]): void {
    if (!screenshots?.length) return;
    let totalBytes = 0;
    for (const [index, dataUrl] of screenshots.entries()) {
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      // base64 长度 * 3/4 即解码后字节数的上界，避免为校验做完整解码
      const approxBytes = Math.floor(base64.length * 0.75);
      if (approxBytes > MAX_SCREENSHOT_BYTES) {
        throw new BadRequestException(`第 ${index + 1} 张截图超过 5MB 限制`);
      }
      totalBytes += approxBytes;
      if (totalBytes > MAX_TOTAL_SCREENSHOT_BYTES) {
        throw new BadRequestException('截图总大小超过 10MB 限制');
      }
    }
  }
}
