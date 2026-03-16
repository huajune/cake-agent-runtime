import { Injectable } from '@nestjs/common';
import { MessageDeduplicationService } from './message-deduplication.service';
import { MessageHistoryService } from './message-history.service';
import { SimpleMergeService } from './simple-merge.service';

/**
 * 消息统计和监控服务
 * 负责收集和提供各种统计信息，用于监控和调试
 */
@Injectable()
export class MessageStatisticsService {
  constructor(
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly historyService: MessageHistoryService,
    private readonly simpleMergeService: SimpleMergeService,
  ) {}

  /**
   * 获取服务状态（简化版）
   * 用于快速健康检查
   */
  getServiceStatus(
    processingCount: number,
    maxConcurrentProcessing: number,
    enableAiReply: boolean,
    enableMessageMerge: boolean,
    enableMessageSplitSend: boolean,
  ) {
    return {
      processingCount,
      maxConcurrentProcessing,
      dedupeCache: this.deduplicationService.getStats(),
      historyCache: this.historyService.getStats(),
      aiReplyEnabled: enableAiReply,
      messageMergeEnabled: enableMessageMerge,
      messageSplitSendEnabled: enableMessageSplitSend,
    };
  }

  /**
   * 获取详细的缓存统计信息
   * 用于深度监控和分析
   */
  getCacheStats(processingCount: number, maxConcurrentProcessing: number) {
    // 避免除零错误：如果 maxConcurrentProcessing 为 0，则利用率显示为 0%
    const utilizationPercent =
      maxConcurrentProcessing > 0 ? (processingCount / maxConcurrentProcessing) * 100 : 0;

    return {
      timestamp: new Date().toISOString(),
      processing: {
        currentCount: processingCount,
        maxConcurrent: maxConcurrentProcessing,
        utilizationPercent,
      },
      messageDeduplication: this.deduplicationService.getStats(),
      conversationHistory: this.historyService.getStats(),
      messageMergeQueues: this.simpleMergeService.getStats(),
    };
  }

  /**
   * 手动清理内存缓存
   * 注意：SimpleMergeService 使用 Bull Queue 原生能力，不需要手动清理聚合队列
   */
  async clearCache(options?: {
    deduplication?: boolean;
    history?: boolean;
    mergeQueues?: boolean;
    chatId?: string;
  }) {
    const result = {
      timestamp: new Date().toISOString(),
      cleared: {
        deduplication: false,
        history: false,
        mergeQueues: false,
      },
    };

    // 默认清理所有
    const opts = options || {
      deduplication: true,
      history: true,
      mergeQueues: true,
    };

    // 清理消息去重缓存
    if (opts.deduplication) {
      this.deduplicationService.clearAll();
      result.cleared.deduplication = true;
    }

    // 清理聊天历史
    if (opts.history) {
      await this.historyService.clearHistory(opts.chatId);
      result.cleared.history = true;
    }

    // 消息聚合队列：SimpleMergeService 使用 Bull Queue + Redis List
    // 清理由 Redis TTL 自动处理，无需手动清理
    if (opts.mergeQueues) {
      result.cleared.mergeQueues = true; // 标记为已清理（实际由 Redis TTL 处理）
    }

    return result;
  }

  /**
   * 执行定期清理任务
   * 清理过期的数据
   * 注意：历史记录现在由 Redis TTL 自动清理
   */
  performScheduledCleanup() {
    const dedupeCleanedCount = this.deduplicationService.cleanupExpiredMessages();

    return {
      timestamp: new Date().toISOString(),
      dedupe: {
        cleanedMessages: dedupeCleanedCount,
      },
      history: {
        note: 'Redis TTL 自动清理',
      },
    };
  }
}
