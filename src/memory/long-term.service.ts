import { Injectable, Logger } from '@nestjs/common';
import { SupabaseStore } from './stores/supabase.store';
import type { UserProfile, SummaryData, SummaryEntry, MessageMetadata } from './memory.types';

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

  formatProfileForPrompt(profile: UserProfile | null): string {
    if (!profile) return '';

    const lines: string[] = [];
    if (profile.name) lines.push(`- 姓名: ${profile.name}`);
    if (profile.phone) lines.push(`- 联系方式: ${profile.phone}`);
    if (profile.gender) lines.push(`- 性别: ${profile.gender}`);
    if (profile.age) lines.push(`- 年龄: ${profile.age}`);
    if (profile.is_student != null) lines.push(`- 是否学生: ${profile.is_student ? '是' : '否'}`);
    if (profile.education) lines.push(`- 学历: ${profile.education}`);
    if (profile.has_health_certificate) lines.push(`- 健康证: ${profile.has_health_certificate}`);

    if (lines.length === 0) return '';
    return `\n\n[用户档案]\n\n${lines.join('\n')}`;
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
    compressArchive?: (overflow: SummaryEntry[], existingArchive: string | null) => Promise<string>,
  ): Promise<void> {
    try {
      await this.supabaseStore.appendSummary(corpId, userId, entry, compressArchive);
    } catch (error) {
      this.logger.warn('追加 Summary 失败', error);
    }
  }

  /**
   * 格式化 Summary 为 prompt 段落（recall_history 工具调用）
   */
  formatSummaryForPrompt(data: SummaryData | null): string {
    if (!data) return '';

    const parts: string[] = [];

    if (data.archive) {
      parts.push(`### 历史总结\n${data.archive}`);
    }

    if (data.recent.length > 0) {
      const recentLines = data.recent.map(
        (e) => `- [${e.startTime?.substring(0, 10) ?? '?'}] ${e.summary}`,
      );
      parts.push(`### 近期求职记录\n${recentLines.join('\n')}`);
    }

    if (parts.length === 0) return '';
    return `\n\n[历史摘要]\n\n${parts.join('\n\n')}`;
  }
}
