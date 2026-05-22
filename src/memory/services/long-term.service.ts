import { Injectable, Logger } from '@nestjs/common';
import { SupabaseStore } from '../stores/supabase.store';
import type {
  UserProfile,
  UserProfileMeta,
  ProfileFieldMeta,
  SummaryData,
  SummaryEntry,
  MessageMetadata,
} from '../types/long-term.types';

/**
 * 长期记忆服务 — Profile + Summary
 *
 * 管理跨会话持久化的记忆（Supabase 永久，每用户一行）：
 * - Profile（用户身份信息）：平铺列，非 null 覆盖更新
 * - Summary（历次求职摘要）：jsonb，分层压缩（recent[] + archive）
 */
@Injectable()
export class LongTermService {
  private readonly logger = new Logger(LongTermService.name);

  constructor(private readonly supabaseStore: SupabaseStore) {}

  // ==================== Profile ====================

  async getProfile(corpId: string, userId: string): Promise<UserProfile | null> {
    try {
      return await this.supabaseStore.getProfile(corpId, userId);
    } catch (error) {
      this.logger.warn('获取 Profile 失败', error);
      return null;
    }
  }

  async saveProfile(
    corpId: string,
    userId: string,
    profile: Partial<UserProfile>,
    metadata?: MessageMetadata,
  ): Promise<void> {
    try {
      // 过滤 null 值
      const nonNull: Partial<UserProfile> = {};
      for (const [k, v] of Object.entries(profile)) {
        if (v !== null && v !== undefined) {
          (nonNull as Record<string, unknown>)[k] = v;
        }
      }
      if (Object.keys(nonNull).length === 0) return;

      await this.supabaseStore.upsertProfile(corpId, userId, nonNull, metadata);
    } catch (error) {
      this.logger.warn('保存 Profile 失败', error);
    }
  }

  /**
   * 报名成功后写入 Profile — Path A（最高质量数据来源）
   *
   * 与 saveProfile 的区别：
   * - 每个字段同时写入 ProfileFieldMeta（source='booking', confidence='high'）
   * - 走 upsertProfileWithMeta 路径，元数据持久化到 profile_fields_meta 列
   *
   * 这是 Hassabis 原则在实践中最重要的体现：报名数据是候选人自主提供并经
   * precheck 校验的，置信度最高，同时必须留下可审计的来源记录。
   */
  async writeFromBooking(
    corpId: string,
    userId: string,
    data: {
      name: string;
      phone: string;
      /** 年龄整数，报名工具入参 */
      age: number;
      /** 性别展示标签，如 "男" / "女" */
      gender: string;
    },
  ): Promise<void> {
    try {
      const writtenAt = new Date().toISOString();
      const bookingMeta: ProfileFieldMeta = {
        source: 'booking',
        confidence: 'high',
        writtenAt,
      };

      const profile: Partial<UserProfile> = {
        name: data.name,
        phone: data.phone,
        age: String(data.age),
        gender: data.gender,
      };

      const meta: UserProfileMeta = {
        name: bookingMeta,
        phone: bookingMeta,
        age: bookingMeta,
        gender: bookingMeta,
      };

      await this.supabaseStore.upsertProfileWithMeta(corpId, userId, profile, meta);
      this.logger.log(
        `[writeFromBooking] Profile 写入成功: corpId=${corpId}, userId=${userId}, name=${data.name}`,
      );
    } catch (error) {
      this.logger.warn('[writeFromBooking] 写入 Profile 失败', error);
    }
  }

  // ==================== Summary ====================

  async getSummaryData(corpId: string, userId: string): Promise<SummaryData | null> {
    try {
      return await this.supabaseStore.getSummaryData(corpId, userId);
    } catch (error) {
      this.logger.warn('获取 Summary 失败', error);
      return null;
    }
  }

  /**
   * 追加一条摘要（自动分层压缩）
   *
   * @param compressArchive 压缩函数：将溢出的 recent 条目 + 旧 archive 合并为新 archive
   */
  async appendSummary(
    corpId: string,
    userId: string,
    entry: SummaryEntry,
    options?: {
      lastSettledMessageAt?: string | null;
      compressArchive?: (
        overflow: SummaryEntry[],
        existingArchive: string | null,
      ) => Promise<string>;
    },
  ): Promise<void> {
    try {
      await this.supabaseStore.appendSummary(corpId, userId, entry, options);
    } catch (error) {
      this.logger.warn('追加 Summary 失败', error);
    }
  }

  async markLastSettledMessageAt(
    corpId: string,
    userId: string,
    lastSettledMessageAt: string,
  ): Promise<void> {
    try {
      await this.supabaseStore.markLastSettledMessageAt(corpId, userId, lastSettledMessageAt);
    } catch (error) {
      this.logger.warn('更新沉淀边界失败', error);
    }
  }

  /**
   * 清理指定用户的长期记忆（profile + summary）
   */
  async clearUserMemory(corpId: string, userId: string): Promise<boolean> {
    try {
      return await this.supabaseStore.del(`profile:${corpId}:${userId}`);
    } catch (error) {
      this.logger.warn('清理长期记忆失败', error);
      return false;
    }
  }
}
