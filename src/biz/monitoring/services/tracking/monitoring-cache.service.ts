import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@core/redis';
import { MonitoringGlobalCounters } from '../../types/tracking.types';
import { MONITORING_REDIS_KEYS } from '../../utils/monitoring-redis-keys';

/**
 * 监控缓存服务
 * 使用 Redis 存储高频更新的实时指标
 *
 * Redis Key 定义见 utils/monitoring-redis-keys.ts
 */
@Injectable()
export class MonitoringCacheService {
  private readonly logger = new Logger(MonitoringCacheService.name);

  // TTL 配置
  private readonly TTL_24_HOURS = 86400; // 24 小时

  constructor(private readonly redisService: RedisService) {}

  // ========================================
  // 全局计数器
  // ========================================

  /**
   * 增量更新计数器
   */
  async incrementCounter(field: keyof MonitoringGlobalCounters, value: number = 1): Promise<void> {
    try {
      const client = this.redisService.getClient();
      await client.hincrby(MONITORING_REDIS_KEYS.COUNTERS, field, value);
    } catch (error) {
      this.logger.error(`增量更新计数器失败 [${field}]:`, error);
    }
  }

  /**
   * 批量增量更新计数器
   */
  async incrementCounters(updates: Partial<MonitoringGlobalCounters>): Promise<void> {
    try {
      const client = this.redisService.getClient();
      const pipeline = client.pipeline();

      for (const [field, value] of Object.entries(updates)) {
        if (typeof value === 'number') {
          pipeline.hincrby(MONITORING_REDIS_KEYS.COUNTERS, field, value);
        }
      }

      await pipeline.exec();
    } catch (error) {
      this.logger.error('批量增量更新计数器失败:', error);
    }
  }

  /**
   * 获取全局计数器
   */
  async getCounters(): Promise<MonitoringGlobalCounters> {
    try {
      const client = this.redisService.getClient();
      const data = await client.hgetall(MONITORING_REDIS_KEYS.COUNTERS);

      if (!data) {
        return this.createDefaultCounters();
      }

      const counters = data as Record<string, string>;
      return {
        totalMessages: parseInt(counters.totalMessages || '0'),
        totalSuccess: parseInt(counters.totalSuccess || '0'),
        totalFailure: parseInt(counters.totalFailure || '0'),
        totalAiDuration: parseInt(counters.totalAiDuration || '0'),
        totalSendDuration: parseInt(counters.totalSendDuration || '0'),
        totalFallback: parseInt(counters.totalFallback || '0'),
        totalFallbackSuccess: parseInt(counters.totalFallbackSuccess || '0'),
      };
    } catch (error) {
      this.logger.error('获取全局计数器失败:', error);
      return this.createDefaultCounters();
    }
  }

  /**
   * 重置全局计数器（用于测试或清理）
   */
  async resetCounters(): Promise<void> {
    try {
      await this.redisService.del(MONITORING_REDIS_KEYS.COUNTERS);
      this.logger.log('全局计数器已重置');
    } catch (error) {
      this.logger.error('重置全局计数器失败:', error);
    }
  }

  /**
   * 批量设置计数器（用于迁移）
   */
  async setCounters(counters: MonitoringGlobalCounters): Promise<void> {
    try {
      const data: Record<string, string> = {
        totalMessages: String(counters.totalMessages),
        totalSuccess: String(counters.totalSuccess),
        totalFailure: String(counters.totalFailure),
        totalAiDuration: String(counters.totalAiDuration),
        totalSendDuration: String(counters.totalSendDuration),
        totalFallback: String(counters.totalFallback),
        totalFallbackSuccess: String(counters.totalFallbackSuccess),
      };

      const client = this.redisService.getClient();
      await client.hmset(MONITORING_REDIS_KEYS.COUNTERS, data);
      this.logger.log('全局计数器已设置');
    } catch (error) {
      this.logger.error('设置全局计数器失败:', error);
    }
  }

  // ========================================
  // 活跃用户
  // ========================================

  /**
   * 添加活跃用户
   * @param userId 用户 ID
   * @param timestamp 活跃时间戳（毫秒）
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  async addActiveUser(userId: string, timestamp: number, date?: string): Promise<void> {
    try {
      const dateKey = date || this.getTodayDateKey();
      const key = MONITORING_REDIS_KEYS.activeUsers(dateKey);

      const client = this.redisService.getClient();
      await client.zadd(key, { score: timestamp, member: userId });
      await this.redisService.expire(key, this.TTL_24_HOURS);
    } catch (error) {
      this.logger.error(`添加活跃用户失败 [${userId}]:`, error);
    }
  }

  /**
   * 获取活跃用户列表
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  async getActiveUsers(date?: string): Promise<string[]> {
    try {
      const dateKey = date || this.getTodayDateKey();
      const key = MONITORING_REDIS_KEYS.activeUsers(dateKey);

      const client = this.redisService.getClient();
      const users = await client.zrange<string[]>(key, 0, -1);
      return users || [];
    } catch (error) {
      this.logger.error('获取活跃用户列表失败:', error);
      return [];
    }
  }

  /**
   * 获取活跃用户数量
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  async getActiveUserCount(date?: string): Promise<number> {
    try {
      const dateKey = date || this.getTodayDateKey();
      const key = MONITORING_REDIS_KEYS.activeUsers(dateKey);

      const client = this.redisService.getClient();
      const count = await client.zcard(key);
      return count || 0;
    } catch (error) {
      this.logger.error('获取活跃用户数量失败:', error);
      return 0;
    }
  }

  // ========================================
  // 活跃会话
  // ========================================

  /**
   * 添加活跃会话
   * @param chatId 会话 ID
   * @param timestamp 活跃时间戳（毫秒）
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  async addActiveChat(chatId: string, timestamp: number, date?: string): Promise<void> {
    try {
      const dateKey = date || this.getTodayDateKey();
      const key = `${this.KEY_ACTIVE_CHATS_PREFIX}${dateKey}`;

      const client = this.redisService.getClient();
      await client.zadd(key, { score: timestamp, member: chatId });
      await this.redisService.expire(key, this.TTL_24_HOURS);
    } catch (error) {
      this.logger.error(`添加活跃会话失败 [${chatId}]:`, error);
    }
  }

  /**
   * 获取活跃会话列表
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  async getActiveChats(date?: string): Promise<string[]> {
    try {
      const dateKey = date || this.getTodayDateKey();
      const key = `${this.KEY_ACTIVE_CHATS_PREFIX}${dateKey}`;

      const client = this.redisService.getClient();
      const chats = await client.zrange<string[]>(key, 0, -1);
      return chats || [];
    } catch (error) {
      this.logger.error('获取活跃会话列表失败:', error);
      return [];
    }
  }

  /**
   * 获取活跃会话数量
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  async getActiveChatCount(date?: string): Promise<number> {
    try {
      const dateKey = date || this.getTodayDateKey();
      const key = `${this.KEY_ACTIVE_CHATS_PREFIX}${dateKey}`;

      const client = this.redisService.getClient();
      const count = await client.zcard(key);
      return count || 0;
    } catch (error) {
      this.logger.error('获取活跃会话数量失败:', error);
      return 0;
    }
  }

  // ========================================
  // 实时并发统计
  // ========================================

  /**
   * 更新当前处理中的消息数
   */
  async setCurrentProcessing(count: number): Promise<void> {
    try {
      await this.redisService.set(this.KEY_CURRENT_PROCESSING, String(count));
    } catch (error) {
      this.logger.error('更新当前处理数失败:', error);
    }
  }

  /**
   * 获取当前处理中的消息数
   */
  async getCurrentProcessing(): Promise<number> {
    try {
      const value = await this.redisService.get(this.KEY_CURRENT_PROCESSING);
      return parseInt(value || '0');
    } catch (error) {
      this.logger.error('获取当前处理数失败:', error);
      return 0;
    }
  }

  /**
   * 增量更新当前处理数
   */
  async incrementCurrentProcessing(delta: number = 1): Promise<number> {
    try {
      const client = this.redisService.getClient();
      const newValue = await client.incrby(this.KEY_CURRENT_PROCESSING, delta);
      return newValue;
    } catch (error) {
      this.logger.error('增量更新当前处理数失败:', error);
      return 0;
    }
  }

  /**
   * 更新峰值处理数（仅当新值更大时）
   */
  async updatePeakProcessing(count: number): Promise<void> {
    try {
      const current = await this.getPeakProcessing();
      if (count > current) {
        await this.redisService.set(this.KEY_PEAK_PROCESSING, String(count));
      }
    } catch (error) {
      this.logger.error('更新峰值处理数失败:', error);
    }
  }

  /**
   * 获取峰值处理数
   */
  async getPeakProcessing(): Promise<number> {
    try {
      const value = await this.redisService.get(this.KEY_PEAK_PROCESSING);
      return parseInt(value || '0');
    } catch (error) {
      this.logger.error('获取峰值处理数失败:', error);
      return 0;
    }
  }

  /**
   * 设置峰值处理数（用于迁移）
   */
  async setPeakProcessing(count: number): Promise<void> {
    try {
      await this.redisService.set(this.KEY_PEAK_PROCESSING, String(count));
    } catch (error) {
      this.logger.error('设置峰值处理数失败:', error);
    }
  }

  // ========================================
  // 辅助方法
  // ========================================

  /**
   * 获取今天的日期键（YYYY-MM-DD）
   */
  private getTodayDateKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * 创建默认计数器对象
   */
  private createDefaultCounters(): MonitoringGlobalCounters {
    return {
      totalMessages: 0,
      totalSuccess: 0,
      totalFailure: 0,
      totalAiDuration: 0,
      totalSendDuration: 0,
      totalFallback: 0,
      totalFallbackSuccess: 0,
    };
  }

  /**
   * 清空所有监控缓存数据（用于测试）
   */
  async clearAll(): Promise<void> {
    try {
      const keys = [
        this.KEY_COUNTERS,
        `${this.KEY_ACTIVE_USERS_PREFIX}*`,
        `${this.KEY_ACTIVE_CHATS_PREFIX}*`,
        this.KEY_CURRENT_PROCESSING,
        this.KEY_PEAK_PROCESSING,
      ];

      const client = this.redisService.getClient();
      for (const keyPattern of keys) {
        if (keyPattern.includes('*')) {
          // 使用 keys 获取模式匹配的 key
          const matchingKeys = await client.keys(keyPattern);
          if (matchingKeys && matchingKeys.length > 0) {
            await this.redisService.del(...matchingKeys);
          }
        } else {
          await this.redisService.del(keyPattern);
        }
      }

      this.logger.log('所有监控缓存数据已清空');
    } catch (error) {
      this.logger.error('清空监控缓存数据失败:', error);
    }
  }
}
