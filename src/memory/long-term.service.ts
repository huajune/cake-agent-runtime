import { Injectable, Logger } from '@nestjs/common';
import { SupabaseStore } from './stores/supabase.store';
import type { UserProfile } from './memory.types';

/**
 * 长期记忆服务 — Profile + Summary
 *
 * 管理跨会话持久化的记忆：
 * - Profile（用户身份信息）：Supabase 永久 + Redis 缓存
 * - Summary（历次求职摘要）：Supabase 永久，按需检索
 *
 * 注意：当前 Phase 2 仅搭建接口框架。
 * DB 表结构变更（Phase 4）后，内部实现将重写为平铺列读写。
 * 目前 Profile 走 SupabaseStore 的旧 key-based 接口。
 */
@Injectable()
export class LongTermService {
  private readonly logger = new Logger(LongTermService.name);

  constructor(private readonly supabaseStore: SupabaseStore) {}

  /**
   * 获取用户 Profile
   *
   * 当前阶段：从 SupabaseStore 读取（旧 key-based），Phase 4 后重写。
   */
  async getProfile(corpId: string, userId: string): Promise<UserProfile | null> {
    try {
      const key = `profile:${corpId}:${userId}:identity`;
      const entry = await this.supabaseStore.get(key);
      if (!entry) return null;

      const c = entry.content;
      return {
        name: (c.name as string) ?? null,
        phone: (c.phone as string) ?? null,
        gender: (c.gender as string) ?? null,
        age: (c.age as string) ?? null,
        is_student: (c.is_student as boolean) ?? null,
        education: (c.education as string) ?? null,
        has_health_certificate: (c.has_health_certificate as string) ?? null,
      };
    } catch (error) {
      this.logger.warn('获取 Profile 失败', error);
      return null;
    }
  }

  /**
   * 保存/更新用户 Profile（非 null 字段覆盖）
   *
   * 当前阶段：走 SupabaseStore 的 set（内部 deepMerge），Phase 4 后重写。
   */
  async saveProfile(corpId: string, userId: string, profile: Partial<UserProfile>): Promise<void> {
    try {
      // 过滤掉 null 值，只写入有值的字段
      const nonNullFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(profile)) {
        if (v !== null && v !== undefined) {
          nonNullFields[k] = v;
        }
      }

      if (Object.keys(nonNullFields).length === 0) return;

      const key = `profile:${corpId}:${userId}:identity`;
      await this.supabaseStore.set(key, nonNullFields);
    } catch (error) {
      this.logger.warn('保存 Profile 失败', error);
    }
  }

  /**
   * 格式化 Profile 为 prompt 段落
   */
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
}
