import { Injectable, Logger } from '@nestjs/common';
import { RedisStore } from './redis.store';
import { SupabaseStore } from './supabase.store';
import {
  type MemoryEntry,
  type EntityExtractionResult,
  type RecommendedJobSummary,
  type WeworkSessionState,
  MemoryCategory,
  MEMORY_TTL,
  MEMORY_KEY_PREFIX,
  EMPTY_SESSION_STATE,
} from './memory.types';
import { deepMerge } from './deep-merge.util';

/**
 * 分层记忆服务 — 对外统一 API，内部按类别路由到对应存储后端
 *
 * 路由规则（按 key 前缀自动识别）：
 * - stage:*         → Redis 3d
 * - wework_session:* → Redis 3d（写入时 deepMerge）
 * - profile:*       → Supabase 永久 + Redis 2h 缓存
 *
 * 对标 ZeroClaw Memory trait 的 store / recall / forget 接口。
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly redisStore: RedisStore,
    private readonly supabaseStore: SupabaseStore,
  ) {}

  // ==================== 通用接口（调用方无需关心后端） ====================

  /** 存储记忆（自动路由 + 按类别决定 TTL / merge 策略） */
  async store(key: string, content: Record<string, unknown>, ttl?: number): Promise<void> {
    const category = this.resolveCategory(key);

    switch (category) {
      case MemoryCategory.PROFILE:
        await this.supabaseStore.set(key, content);
        break;

      case MemoryCategory.FACTS:
        await this.redisStore.set(key, content, ttl ?? MEMORY_TTL.FACTS, true);
        break;

      case MemoryCategory.STAGE:
      default:
        await this.redisStore.set(key, content, ttl ?? MEMORY_TTL.STAGE, false);
        break;
    }
  }

  /** 回忆记忆 */
  async recall(key: string): Promise<MemoryEntry | null> {
    const category = this.resolveCategory(key);

    if (category === MemoryCategory.PROFILE) {
      return this.supabaseStore.get(key);
    }
    return this.redisStore.get(key);
  }

  /** 遗忘记忆 */
  async forget(key: string): Promise<boolean> {
    const category = this.resolveCategory(key);

    if (category === MemoryCategory.PROFILE) {
      return this.supabaseStore.del(key);
    }
    return this.redisStore.del(key);
  }

  // ==================== Facts 结构化访问（从花卷 WeworkSessionMemory 迁移） ====================

  /**
   * 获取会话状态
   */
  async getSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<WeworkSessionState> {
    const key = this.factsKey(corpId, userId, sessionId);
    const entry = await this.redisStore.get(key);
    if (!entry) return { ...EMPTY_SESSION_STATE };
    return (entry.content as unknown as WeworkSessionState) ?? { ...EMPTY_SESSION_STATE };
  }

  /**
   * 获取候选人事实
   */
  async getFacts(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<EntityExtractionResult | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.facts;
  }

  /**
   * 保存候选人事实（deepMerge 已有值）
   */
  async saveFacts(
    corpId: string,
    userId: string,
    sessionId: string,
    facts: EntityExtractionResult,
  ): Promise<void> {
    const key = this.factsKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const mergedFacts = state.facts
      ? (deepMerge(state.facts, facts) as EntityExtractionResult)
      : facts;

    await this.redisStore.set(
      key,
      { ...state, facts: mergedFacts } as unknown as Record<string, unknown>,
      MEMORY_TTL.FACTS,
      false, // 已手动 merge，不需要 store 层再 merge
    );
  }

  /**
   * 保存已推荐岗位（覆盖语义，非累积）
   */
  async saveLastRecommendedJobs(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    const key = this.factsKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);

    await this.redisStore.set(
      key,
      { ...state, lastRecommendedJobs: jobs } as unknown as Record<string, unknown>,
      MEMORY_TTL.FACTS,
      false,
    );
  }

  /**
   * 格式化会话记忆为系统提示词段落
   *
   * 从花卷 formatSessionMemoryForPrompt 迁移。
   * 返回空字符串表示无记忆需要注入。
   */
  formatSessionMemoryForPrompt(state: WeworkSessionState): string {
    const sections: string[] = [];

    // 事实信息
    if (state.facts) {
      const { interview_info: info, preferences: pref } = state.facts;
      const factLines: string[] = [];

      if (info.name) factLines.push(`- 姓名: ${info.name}`);
      if (info.phone) factLines.push(`- 联系方式: ${info.phone}`);
      if (info.gender) factLines.push(`- 性别: ${info.gender}`);
      if (info.age) factLines.push(`- 年龄: ${info.age}`);
      if (info.applied_store) factLines.push(`- 应聘门店: ${info.applied_store}`);
      if (info.applied_position) factLines.push(`- 应聘岗位: ${info.applied_position}`);
      if (info.interview_time) factLines.push(`- 面试时间: ${info.interview_time}`);
      if (info.is_student != null) factLines.push(`- 是否学生: ${info.is_student ? '是' : '否'}`);
      if (info.education) factLines.push(`- 学历: ${info.education}`);
      if (info.has_health_certificate) factLines.push(`- 健康证: ${info.has_health_certificate}`);

      if (pref.labor_form) factLines.push(`- 用工形式: ${pref.labor_form}`);
      if (pref.brands?.length) factLines.push(`- 意向品牌: ${pref.brands.join('、')}`);
      if (pref.salary) factLines.push(`- 意向薪资: ${pref.salary}`);
      if (pref.position?.length) factLines.push(`- 意向岗位: ${pref.position.join('、')}`);
      if (pref.schedule) factLines.push(`- 意向班次: ${pref.schedule}`);
      if (pref.city) factLines.push(`- 意向城市: ${pref.city}`);
      if (pref.district?.length) factLines.push(`- 意向区域: ${pref.district.join('、')}`);
      if (pref.location?.length) factLines.push(`- 意向地点: ${pref.location.join('、')}`);

      if (factLines.length > 0) {
        sections.push(`## 候选人已知信息\n${factLines.join('\n')}`);
      }
    }

    // 上轮推荐岗位
    if (state.lastRecommendedJobs?.length) {
      const jobLines = state.lastRecommendedJobs.map((j, i) => {
        const parts = [
          `${i + 1}. [jobId:${j.jobId}]`,
          `品牌:${j.brandName ?? ''} - 岗位:${j.jobName ?? ''}`,
        ];
        if (j.storeName) parts.push(`门店:${j.storeName}`);
        if (j.cityName || j.regionName) {
          parts.push(`地区:${[j.cityName, j.regionName].filter(Boolean).join('')}`);
        }
        if (j.laborForm) parts.push(`用工:${j.laborForm}`);
        if (j.salaryDesc) parts.push(`薪资:${j.salaryDesc}`);
        return parts.join(' | ');
      });
      sections.push(`## 上轮已推荐岗位\n${jobLines.join('\n')}`);
    }

    if (sections.length === 0) return '';
    return `\n\n[会话记忆]\n\n${sections.join('\n\n')}`;
  }

  // ==================== 内部方法 ====================

  /** 根据 key 前缀识别记忆类别 */
  private resolveCategory(key: string): MemoryCategory {
    if (key.startsWith(MEMORY_KEY_PREFIX[MemoryCategory.PROFILE])) {
      return MemoryCategory.PROFILE;
    }
    if (key.startsWith(MEMORY_KEY_PREFIX[MemoryCategory.FACTS])) {
      return MemoryCategory.FACTS;
    }
    // stage: 前缀或未知前缀都走 stage 路径（Redis，不 merge）
    return MemoryCategory.STAGE;
  }

  /** 构建 facts key */
  private factsKey(corpId: string, userId: string, sessionId: string): string {
    return `${MEMORY_KEY_PREFIX[MemoryCategory.FACTS]}${corpId}:${userId}:${sessionId}`;
  }
}
