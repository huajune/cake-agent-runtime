import { Injectable, Logger } from '@nestjs/common';
import { SupabaseStore } from '../stores/supabase.store';
import type { CandidateFactProducer } from '@resolution/evidence/claim.types';
import type {
  UserProfile,
  UserProfileFacts,
  ProfileFactConfidence,
  SessionSummaries,
  SummaryEntry,
  MessageMetadata,
  ActiveBookingEntry,
  JobIntentFacts,
  UserProfileFieldKey,
} from './long-term.types';
import type { PersistedBrandState } from '@resolution/brand/brand-resolution.types';
import {
  LONG_TERM_JOB_INTENT_FIELD_KEYS,
  userProfileFactValue,
  USER_PROFILE_FIELD_KEYS,
} from './long-term.types';
import {
  type EntityExtractionResult,
  type SessionFacts,
  type SessionFactValue,
  isSessionFactValue,
  truncateEvidence,
  unwrapSessionFactValue,
} from '../short-term/short-term.types';

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

/** consolidation 专用：血缘之外附带品牌快照源（preferences.brands 已退役，§19.6）。 */
export interface ConsolidationFactOrigin extends FactOrigin {
  brandState?: PersistedBrandState | null;
}

/**
 * 长期记忆服务 — Profile + Summary
 *
 * 管理跨会话持久化的记忆（Supabase 永久，每用户一行）：
 * - Profile（用户身份信息）：semantic_profile jsonb，字段自身携带置信度/来源/证据
 * - Summary（历次求职摘要）：jsonb，分层压缩（recent[] + archive）
 */
@Injectable()
export class LongTermService {
  private readonly logger = new Logger(LongTermService.name);

  constructor(private readonly supabaseStore: SupabaseStore) {}

  // ==================== Profile ====================

  async getProfile(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<UserProfileFacts | null> {
    try {
      return await this.supabaseStore.getProfile(corpId, userId, botUserId);
    } catch (error) {
      this.logger.warn('获取 Profile 失败', error);
      return null;
    }
  }

  async seedProfileFixture(
    corpId: string,
    userId: string,
    botUserId: string,
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
        source: 'archive',
        confidence: 'medium',
        evidence: '测试夹具写入长期档案',
      });
      await this.supabaseStore.upsertProfileFacts(
        corpId,
        userId,
        botUserId,
        profileFacts,
        metadata,
      );
    } catch (error) {
      this.logger.warn('保存 Profile 失败', error);
    }
  }

  /**
   * 报名成功后写入 Profile — Path A（最高质量数据来源）
   *
   * 与 saveProfile 的区别：
   * - 每个字段写成 { value, confidence, source, evidence, updatedAt }
   * - 走 upsertProfileFacts 路径，元数据内聚在 semantic_profile 字段值里
   *
   * 这是 Hassabis 原则在实践中最重要的体现：报名数据是候选人自主提供并经
   * precheck 校验的，置信度最高，同时必须留下可审计的来源记录。
   */
  async writeFromBooking(
    corpId: string,
    userId: string,
    botUserId: string,
    data: {
      name: string;
      phone: string;
      /** 年龄整数，报名工具入参 */
      age: number;
      /** 性别展示标签，如 "男" / "女" */
      gender: string;
      /** 报名岗位血缘。 */
      jobId: number;
      /** 报名成功返回的工单号。 */
      workOrderId: number;
    },
    origin: Required<FactOrigin>,
  ): Promise<void> {
    try {
      const profile: Partial<UserProfile> = {
        name: data.name,
        phone: data.phone,
        age: String(data.age),
        gender: data.gender,
      };

      const profileFacts = this.buildProfileFacts(profile, {
        source: 'system',
        confidence: 'high',
        evidence: `收资表单办结并报名成功（jobId=${data.jobId}, workOrderId=${data.workOrderId}）`,
        originSessionId: origin.sessionId,
        originBotId: origin.botImId,
      });

      await this.supabaseStore.upsertProfileFacts(corpId, userId, botUserId, profileFacts);
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
   * 长期画像保留原 sessionFact 的 producer 章；沉淀只是运输，不改写事实出身。
   * evidence 保留原 sessionFact 的置信度与机制细节，避免丢失一跳证据。
   * confidence 固定为 medium，避免沉淀数据覆盖 booking/high。
   */
  async writeFromConsolidation(
    corpId: string,
    userId: string,
    botUserId: string,
    facts: EntityExtractionResult | SessionFacts,
    origin?: ConsolidationFactOrigin,
  ): Promise<void> {
    try {
      const profileFacts = this.buildProfileFactsFromConsolidation(facts, origin);
      const jobIntentFacts = this.buildPreferenceFactsFromConsolidation(facts, origin);
      if (Object.keys(profileFacts).length === 0 && Object.keys(jobIntentFacts).length === 0) {
        return;
      }

      // profile + preference 单 RPC 事务写入（同一行锁），杜绝两步写之间失败
      // 造成的"profile 落库而意向丢失"半写状态。
      await this.supabaseStore.upsertProfileFacts(
        corpId,
        userId,
        botUserId,
        profileFacts,
        undefined,
        jobIntentFacts,
      );
      this.logger.log(
        `[writeFromConsolidation] Profile+Preference 原子写入: userId=${userId}, ` +
          `profileFields=${Object.keys(profileFacts).join(',') || '-'}, ` +
          `preferenceFields=${Object.keys(jobIntentFacts).join(',') || '-'}`,
      );
    } catch (error) {
      this.logger.warn('[writeFromConsolidation] 写入 Profile+Preference 失败', error);
      throw error;
    }
  }

  /** 读取长期求职意向（consolidation 沉淀的跨会话偏好快照）。 */
  async getPreferences(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<JobIntentFacts | null> {
    try {
      return await this.supabaseStore.getPreferenceFacts(corpId, userId, botUserId);
    } catch (error) {
      this.logger.warn('获取长期求职意向失败', error);
      return null;
    }
  }

  // ==================== Summary ====================

  async getSessionSummaries(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<SessionSummaries | null> {
    try {
      return await this.supabaseStore.getSessionSummaries(corpId, userId, botUserId);
    } catch (error) {
      this.logger.warn('获取 Summary 失败', error);
      return null;
    }
  }

  /**
   * 追加一条摘要（自动分层压缩）
   *
   * @param compressArchive 压缩函数：只把本次溢出的 recent 条目压成一个新 archive 段
   */
  async appendSummary(
    corpId: string,
    userId: string,
    botUserId: string,
    entry: SummaryEntry,
    options?: {
      lastSettledMessageAt?: string | null;
      /** 沉淀边界的会话维度 key（sessionId=chatId）；双 bot 场景按会话隔离边界。 */
      sessionId?: string | null;
      compressArchive?: (overflow: SummaryEntry[]) => Promise<string>;
    },
  ): Promise<void> {
    try {
      await this.supabaseStore.appendSummary(corpId, userId, botUserId, entry, options);
    } catch (error) {
      this.logger.warn('追加 Summary 失败', error);
      throw error;
    }
  }

  async markLastSettledMessageAt(
    corpId: string,
    userId: string,
    botUserId: string,
    lastSettledMessageAt: string,
    sessionId?: string | null,
  ): Promise<void> {
    try {
      await this.supabaseStore.markLastSettledMessageAt(
        corpId,
        userId,
        botUserId,
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
    botUserId: string,
    metadata: MessageMetadata,
  ): Promise<void> {
    try {
      await this.supabaseStore.upsertMessageMetadata(corpId, userId, botUserId, metadata);
    } catch (error) {
      this.logger.warn('更新长期记忆消息元数据失败', error);
    }
  }

  // ==================== active_booking ====================

  /**
   * 读取候选人当前有效/待处理预约工单列表（按 linked_at 倒序，[0] 即最近一笔）。
   * Agent 上下文渲染 / request_handoff(modify_appointment) 守卫使用。
   */
  async getActiveBookings(corpId: string, userId: string): Promise<ActiveBookingEntry[]> {
    try {
      return await this.supabaseStore.getActiveBookings(corpId, userId);
    } catch (error) {
      this.logger.warn('获取 active_bookings 失败', error);
      return [];
    }
  }

  /**
   * 预约成功时写入当前有效/待处理预约工单指针。
   */
  async setActiveBooking(
    corpId: string,
    userId: string,
    workOrderId: number,
    metadata?: Pick<ActiveBookingEntry, 'job_id'>,
  ): Promise<void> {
    try {
      await this.supabaseStore.setActiveBooking(corpId, userId, workOrderId, metadata);
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
  async clearUserMemory(corpId: string, userId: string, botUserId: string): Promise<boolean> {
    try {
      return await this.supabaseStore.del(`long-term:${corpId}:${userId}:${botUserId}`);
    } catch (error) {
      this.logger.warn('清理长期记忆失败', error);
      return false;
    }
  }

  private buildProfileFacts(
    profile: Partial<UserProfile>,
    defaults: {
      source: CandidateFactProducer;
      confidence: ProfileFactConfidence;
      evidence: string;
      originSessionId?: string;
      originBotId?: string;
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

  private buildProfileFactsFromConsolidation(
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
        source: isSessionFactValue(rawValue) ? rawValue.source : 'archive',
        confidence: 'medium',
        evidence: this.buildConsolidationEvidence(rawValue),
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
   * - 只取 LONG_TERM_JOB_INTENT_FIELD_KEYS 中的稳定意向字段
   * - 快照式：不与既有长期意向 merge，由 store 整列覆盖（最新一段会话赢）
   * - confidence 固定 medium（与 Profile 沉淀路径一致），evidence 截断保留一跳来源
   */
  private buildPreferenceFactsFromConsolidation(
    facts: EntityExtractionResult | SessionFacts,
    origin?: ConsolidationFactOrigin,
  ): JobIntentFacts {
    const updatedAt = new Date().toISOString();
    const jobIntentFacts: JobIntentFacts = {};
    const prefs = facts.preferences as unknown as Record<string, unknown>;

    for (const key of LONG_TERM_JOB_INTENT_FIELD_KEYS) {
      // 品牌快照不再走 preferences.brands（字段已退役，读边界恒 null，§19.6），
      // 由下方 facts.brand.currentBrand 显式提供。
      if (key === 'brands') continue;
      const rawValue = prefs[key];
      // 外层 null / 缺键 = 本轮缺席，不改变长期值；只有信封内 null/空值才是墓碑。
      if (rawValue === null || rawValue === undefined) continue;
      const value = unwrapSessionFactValue(rawValue as SessionFactValue<unknown> | null);
      const explicitClear =
        isSessionFactValue(rawValue) &&
        (value === null ||
          (typeof value === 'string' && value.trim().length === 0) ||
          (Array.isArray(value) && value.length === 0));
      if (!explicitClear && !this.hasPreferenceValue(value)) continue;

      jobIntentFacts[key] = userProfileFactValue(explicitClear ? null : value, {
        source: isSessionFactValue(rawValue) ? rawValue.source : 'archive',
        confidence: 'medium',
        evidence: this.buildConsolidationEvidence(rawValue),
        updatedAt,
        originSessionId: origin?.sessionId,
        originBotId: origin?.botImId,
      });
    }

    const currentBrand = origin?.brandState?.currentBrand;
    if (currentBrand) {
      jobIntentFacts.brands = userProfileFactValue([currentBrand.canonicalName], {
        source: 'rule',
        confidence: 'medium',
        evidence: '会话品牌状态快照（facts.brand.currentBrand）',
        updatedAt,
        originSessionId: origin?.sessionId,
        originBotId: origin?.botImId,
      });
    }

    return jobIntentFacts;
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

  private buildConsolidationEvidence(rawValue: unknown): string {
    const prefix = '会话沉淀提取';
    if (!isSessionFactValue(rawValue)) return prefix;

    const parts = [
      `原字段置信度=${rawValue.confidence}`,
      rawValue.evidence?.trim() ? `原证据=${rawValue.evidence.trim()}` : null,
    ].filter(Boolean);
    // 截断后再入库：长期画像 evidence 是永久数据，曾被 600+ 字提取 reasoning 污染
    // 并随每轮注入 prompt（张漪 case）。
    return truncateEvidence(`${prefix}；${parts.join('；')}`);
  }
}
