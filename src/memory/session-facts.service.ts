import { Injectable, Logger } from '@nestjs/common';
import { RedisStore } from './stores/redis.store';
import { MemoryConfig } from './memory.config';
import { deepMerge } from './stores/deep-merge.util';
import type {
  EntityExtractionResult,
  RecommendedJobSummary,
  WeworkSessionState,
} from './memory.types';
import { EMPTY_SESSION_STATE, MEMORY_KEY_PREFIX, MemoryCategory } from './memory.types';

/**
 * 会话事实服务 — 本次求职意向的结构化存储
 *
 * 管理 Session Facts（Redis，SESSION_TTL）：
 * - 候选人事实（EntityExtractionResult）
 * - 已推荐岗位（RecommendedJobSummary[]）
 * - 最后交互时间（lastInteraction）
 *
 * 写入策略：deepMerge（增量累积）
 */
@Injectable()
export class SessionFactsService {
  private readonly logger = new Logger(SessionFactsService.name);

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
  ) {}

  /**
   * 获取完整会话状态
   */
  async getSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<WeworkSessionState> {
    const key = this.buildKey(corpId, userId, sessionId);
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
   * 获取最后交互时间
   */
  async getLastInteraction(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<string | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.lastInteraction ?? null;
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
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const mergedFacts = state.facts
      ? (deepMerge(state.facts, facts) as EntityExtractionResult)
      : facts;

    await this.redisStore.set(
      key,
      { ...state, facts: mergedFacts } as unknown as Record<string, unknown>,
      this.config.sessionTtl,
      false,
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
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);

    await this.redisStore.set(
      key,
      { ...state, lastRecommendedJobs: jobs } as unknown as Record<string, unknown>,
      this.config.sessionTtl,
      false,
    );
  }

  /**
   * 存储基本交互信息（lastInteraction, lastTopic）
   */
  async storeInteraction(
    corpId: string,
    userId: string,
    sessionId: string,
    data: { lastInteraction: string; lastTopic: string },
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    await this.redisStore.set(key, data as Record<string, unknown>, this.config.sessionTtl, true);
  }

  /**
   * 格式化会话记忆为系统提示词段落
   */
  formatForPrompt(state: WeworkSessionState): string {
    const sections: string[] = [];

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

  // ---- 内部方法 ----

  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `${MEMORY_KEY_PREFIX[MemoryCategory.FACTS]}${corpId}:${userId}:${sessionId}`;
  }
}
