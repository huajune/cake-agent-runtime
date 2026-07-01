import { Injectable, Logger } from '@nestjs/common';
import { SupabaseStore } from '../stores/supabase.store';
import type {
  UserProfile,
  UserProfileFieldKey,
  UserProfileFacts,
  ProfileFactConfidence,
  ProfileFactSource,
  SummaryData,
  SummaryEntry,
  MessageMetadata,
  ActiveBooking,
  LongTermPreferenceFacts,
} from '../types/long-term.types';
import {
  LONG_TERM_PREFERENCE_FIELD_KEYS,
  userProfileFactValue,
  USER_PROFILE_FIELD_KEYS,
} from '../types/long-term.types';
import {
  type EntityExtractionResult,
  type SessionFacts,
  type SessionFactValue,
  isSessionFactValue,
  truncateEvidence,
  unwrapSessionFactValue,
} from '../types/session-facts.types';

/**
 * 沉淀写入长期记忆时的数据血缘来源。
 *
 * sessionId（=chatId，bot 维度）与 botImId 都能映射回具体招募经理；
 * 双 bot 服务同一候选人时，用于追溯"这条长期事实由哪次会话沉淀"。
 */
export interface FactOrigin {
  sessionId?: string;
  botImId?: string;
}

/**
 * 长期记忆服务 — Profile + Summary
 *
 * 管理跨会话持久化的记忆（Supabase 永久，每用户一行）：
 * - Profile（用户身份信息）：profile_facts jsonb，字段自身携带置信度/来源/证据
 * - Summary（历次求职摘要）：jsonb，分层压缩（recent[] + archive）
 */
@Injectable()
export class LongTermService {
  private readonly logger = new Logger(LongTermService.name);

  constructor(private readonly supabaseStore: SupabaseStore) {}

  // ==================== Profile ====================

  async getProfile(corpId: string, userId: string): Promise<UserProfileFacts | null> {
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

      const profileFacts = this.buildProfileFacts(nonNull, {
        source: 'enrichment',
        confidence: 'medium',
        evidence: '外部补充字段写入长期档案',
      });
      await this.supabaseStore.upsertProfileFacts(corpId, userId, profileFacts, metadata);
    } catch (error) {
      this.logger.warn('保存 Profile 失败', error);
    }
  }

  /**
   * 报名成功后写入 Profile — Path A（最高质量数据来源）
   *
   * 与 saveProfile 的区别：
   * - 每个字段写成 { value, confidence, source, evidence, updatedAt }
   * - 走 upsertProfileFacts 路径，元数据内聚在 profile_facts 字段值里
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
      const profile: Partial<UserProfile> = {
        name: data.name,
        phone: data.phone,
        age: String(data.age),
        gender: data.gender,
      };

      const profileFacts = this.buildProfileFacts(profile, {
        source: 'booking',
        confidence: 'high',
        evidence: '报名成功后写入',
      });

      await this.supabaseStore.upsertProfileFacts(corpId, userId, profileFacts);
      this.logger.log(
        `[writeFromBooking] Profile 写入成功: corpId=${corpId}, userId=${userId}, name=${data.name}`,
      );
    } catch (error) {
      this.logger.warn('[writeFromBooking] 写入 Profile 失败', error);
    }
  }

  /**
   * 沉淀时写入 Profile — Path B（中等置信度兜底）
   *
   * 当会话沉淀触发时，从 sessionFacts 中抽取身份字段写入 Profile。
   * 长期画像的 source='extraction' 表示“通过沉淀写入长期表”；
   * evidence 会保留原 sessionFact 的 source/confidence/evidence，避免丢失一跳来源。
   * confidence 固定为 medium，避免沉淀数据覆盖 booking/high。
   */
  async writeFromSettlement(
    corpId: string,
    userId: string,
    facts: EntityExtractionResult | SessionFacts,
    origin?: FactOrigin,
  ): Promise<void> {
    try {
      const profileFacts = this.buildProfileFactsFromSettlement(facts, origin);
      if (Object.keys(profileFacts).length > 0) {
        await this.supabaseStore.upsertProfileFacts(corpId, userId, profileFacts);
        this.logger.log(
          `[writeFromSettlement] Profile 写入: userId=${userId}, fields=${Object.keys(profileFacts).join(',')}`,
        );
      }

      // 求职意向同样跨会话有价值（城市/品牌/岗位/班次等），此前只活在 Redis
      // session facts（TTL 2 天）里，候选人隔几天回来意向全部丢失、只剩摘要叙述。
      const preferenceFacts = this.buildPreferenceFactsFromSettlement(facts, origin);
      if (Object.keys(preferenceFacts).length > 0) {
        await this.supabaseStore.upsertPreferenceFacts(corpId, userId, preferenceFacts);
        this.logger.log(
          `[writeFromSettlement] Preference 写入: userId=${userId}, fields=${Object.keys(preferenceFacts).join(',')}`,
        );
      }
    } catch (error) {
      this.logger.warn('[writeFromSettlement] 写入 Profile 失败', error);
    }
  }

  /** 读取长期求职意向（settlement 沉淀的跨会话偏好快照）。 */
  async getPreferences(corpId: string, userId: string): Promise<LongTermPreferenceFacts | null> {
    try {
      return await this.supabaseStore.getPreferenceFacts(corpId, userId);
    } catch (error) {
      this.logger.warn('获取长期求职意向失败', error);
      return null;
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
      /** 沉淀边界的会话维度 key（sessionId=chatId）；双 bot 场景按会话隔离边界。 */
      sessionId?: string | null;
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
    sessionId?: string | null,
  ): Promise<void> {
    try {
      await this.supabaseStore.markLastSettledMessageAt(
        corpId,
        userId,
        lastSettledMessageAt,
        sessionId,
      );
    } catch (error) {
      this.logger.warn('更新沉淀边界失败', error);
    }
  }

  async updateMessageMetadata(
    corpId: string,
    userId: string,
    metadata: MessageMetadata,
  ): Promise<void> {
    try {
      await this.supabaseStore.upsertMessageMetadata(corpId, userId, metadata);
    } catch (error) {
      this.logger.warn('更新长期记忆消息元数据失败', error);
    }
  }

  // ==================== active_booking ====================

  /**
   * 读取候选人当前有效/待处理预约工单指针。
   * Agent 上下文渲染 / request_handoff(modify_appointment) 守卫使用。
   */
  async getActiveBooking(corpId: string, userId: string): Promise<ActiveBooking | null> {
    try {
      return await this.supabaseStore.getActiveBooking(corpId, userId);
    } catch (error) {
      this.logger.warn('获取 active_booking 失败', error);
      return null;
    }
  }

  /**
   * 预约成功时写入当前有效/待处理预约工单指针（新预约覆盖）。
   */
  async setActiveBooking(corpId: string, userId: string, workOrderId: number): Promise<void> {
    try {
      await this.supabaseStore.setActiveBooking(corpId, userId, workOrderId);
    } catch (error) {
      this.logger.warn('写入 active_booking 失败', error);
    }
  }

  /**
   * 取消当前工单成功时清空 active_booking。
   */
  async clearActiveBooking(
    corpId: string,
    userId: string,
    expectedWorkOrderId?: number,
  ): Promise<void> {
    try {
      await this.supabaseStore.clearActiveBooking(corpId, userId, expectedWorkOrderId);
    } catch (error) {
      this.logger.warn('清空 active_booking 失败', error);
    }
  }

  /**
   * 清理指定用户的长期记忆（profile + summary）
   */
  async clearUserMemory(corpId: string, userId: string): Promise<boolean> {
    try {
      return await this.supabaseStore.del(`long-term:${corpId}:${userId}`);
    } catch (error) {
      this.logger.warn('清理长期记忆失败', error);
      return false;
    }
  }

  private buildProfileFacts(
    profile: Partial<UserProfile>,
    defaults: {
      source: ProfileFactSource;
      confidence: ProfileFactConfidence;
      evidence: string;
    },
  ): Partial<UserProfileFacts> {
    const updatedAt = new Date().toISOString();
    const facts: Partial<UserProfileFacts> = {};

    for (const key of USER_PROFILE_FIELD_KEYS) {
      const value = profile[key];
      if (value !== null && value !== undefined) {
        (facts as Record<string, unknown>)[key] = userProfileFactValue(value, {
          ...defaults,
          updatedAt,
        });
      }
    }

    return facts;
  }

  private buildProfileFactsFromSettlement(
    facts: EntityExtractionResult | SessionFacts,
    origin?: FactOrigin,
  ): Partial<UserProfileFacts> {
    const updatedAt = new Date().toISOString();
    const profileFacts: Partial<UserProfileFacts> = {};
    const info = facts.interview_info as Record<UserProfileFieldKey, unknown>;

    for (const key of USER_PROFILE_FIELD_KEYS) {
      const rawValue = info[key];
      const value = unwrapSessionFactValue(
        rawValue as SessionFactValue<string | boolean> | string | boolean | null | undefined,
      );
      if (!this.hasProfileValue(value)) continue;

      (profileFacts as Record<string, unknown>)[key] = userProfileFactValue(value, {
        source: 'extraction',
        confidence: 'medium',
        evidence: this.buildSettlementEvidence(rawValue),
        updatedAt,
        originSessionId: origin?.sessionId,
        originBotId: origin?.botImId,
      });
    }

    return profileFacts;
  }

  /**
   * 从 sessionFacts.preferences 构建长期求职意向快照。
   *
   * - 只取 LONG_TERM_PREFERENCE_FIELD_KEYS 中的稳定意向字段
   * - 快照式：不与既有长期意向 merge，由 store 整列覆盖（最新一段会话赢）
   * - confidence 固定 medium（与 Profile 沉淀路径一致），evidence 截断保留一跳来源
   */
  private buildPreferenceFactsFromSettlement(
    facts: EntityExtractionResult | SessionFacts,
    origin?: FactOrigin,
  ): LongTermPreferenceFacts {
    const updatedAt = new Date().toISOString();
    const preferenceFacts: LongTermPreferenceFacts = {};
    const prefs = facts.preferences as unknown as Record<string, unknown>;

    for (const key of LONG_TERM_PREFERENCE_FIELD_KEYS) {
      const rawValue = prefs[key];
      const value = unwrapSessionFactValue(rawValue as SessionFactValue<unknown> | null);
      if (!this.hasPreferenceValue(value)) continue;

      preferenceFacts[key] = userProfileFactValue(value, {
        source: 'extraction',
        confidence: 'medium',
        evidence: this.buildSettlementEvidence(rawValue),
        updatedAt,
        originSessionId: origin?.sessionId,
        originBotId: origin?.botImId,
      });
    }

    return preferenceFacts;
  }

  private hasPreferenceValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  private hasProfileValue(value: unknown): value is string | boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.trim().length > 0;
    return false;
  }

  private buildSettlementEvidence(rawValue: unknown): string {
    const prefix = '会话沉淀提取';
    if (!isSessionFactValue(rawValue)) return prefix;

    const parts = [
      `原字段来源=${rawValue.source}`,
      `原字段置信度=${rawValue.confidence}`,
      rawValue.evidence?.trim() ? `原证据=${rawValue.evidence.trim()}` : null,
    ].filter(Boolean);
    // 截断后再入库：长期画像 evidence 是永久数据，曾被 600+ 字提取 reasoning 污染
    // 并随每轮注入 prompt（张漪 case）。
    return truncateEvidence(`${prefix}；${parts.join('；')}`);
  }
}
