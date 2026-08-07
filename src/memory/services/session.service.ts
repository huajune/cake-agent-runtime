import { Injectable, Logger, Optional } from '@nestjs/common';
import type { CityAttestation } from '@shared-types/tool.types';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { SpongeService } from '@/sponge/sponge.service';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import { deepMerge } from '../stores/deep-merge.util';
import { z } from 'zod';
import {
  BrandIntentEntrySchema,
  type BrandIntentEntry,
  EntityExtractionResultSchema,
  ExplicitProvenanceEntrySchema,
  type ExplicitProvenanceEntry,
  LLMEntityExtractionResultSchema,
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type HighConfidenceValue,
  type RecommendedJobSummary,
  RecommendedJobSummarySchema,
  type ScheduleConstraintFact,
  type InvitedGroupRecord,
  InvitedGroupRecordSchema,
  type JobListQueryRecord,
  JobListQueryRecordSchema,
  SessionFactsSchema,
  SessionFactsRedisContentSchema,
  type SessionFacts,
  type SessionFactSource,
  type SessionFactValue,
  type WeworkSessionState,
  EMPTY_SESSION_STATE,
  FALLBACK_EXTRACTION,
  isSessionFactValue,
  sessionFactConfidenceRank,
  sessionFactValue,
  toSessionFacts,
  truncateEvidence,
  unwrapSessionFactValue,
  INTERVIEW_INFO_FIELD_KEYS,
  PREFERENCE_FIELD_KEYS,
} from '../types/session-facts.types';
import {
  detectScalarFanoutValues,
  isPlausibleAgeValue,
  isPlausibleCityValue,
  SCALAR_FANOUT_FIELD_THRESHOLD,
} from '../facts/fact-shape-gates';
import type {
  AuthoritativeSessionState,
  CollectedField,
  FieldProvenance,
} from '../types/authoritative-session-state.types';
import { parseCandidateFieldsFromText } from '@tools/shared/candidate-field-parser';
import { isNameAnsweredToRealNameAsk, isNameOnlyQuotedSpeaker } from '@tools/shared/precheck-core';
import { MessageParser } from '@channels/wecom/message/utils/message-parser.util';
import {
  buildSessionExtractionPrompt,
  SESSION_EXTRACTION_SYSTEM_PROMPT,
} from './session-extraction.prompt';
import {
  detectBrandAliasHints,
  extractHighConfidenceFacts,
  stripQuotedBlocks,
  filterHighConfidenceFacts,
  unwrapHighConfidenceFacts,
} from '../facts/high-confidence-facts';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import { normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
import { isAssistantEchoUtterance, isSystemTextReflow } from '@resolution/brand/llm-intent-guards';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import type { BrandItem } from '@/sponge/sponge.types';
import {
  detectGeoSignalConflict,
  isRecognizedCityName,
  resolveCityFromGeoSignals,
} from '@resolution/geo';
import { decideLaborFormIntent } from '../facts/labor-form';
import { resolveConfirmedCityFact } from '../facts/confirmation-facts';
import { parseLocationShareCoords } from '../facts/location-share';
import { sanitizeInterviewName } from '../facts/name-guard';
import {
  assertExtractionIdentityProvenance,
  assertNoExtractionExampleEcho,
  hasFieldProvenanceInWindow,
  hasHealthCertificateTopicEvidence,
  hasIsStudentTopicEvidence,
  isStorableCandidatePhone,
} from '../facts/placeholder-identity';
import { hasSelfReportedPhoneProvenance, isDigitsOnlyName } from '../facts/visual-description';
import {
  fieldValues,
  isSelfReportedVisualMessage,
  isVisualDescriptionText,
  parseStoredVisualFactSheet,
  type FinalizedVisualFactSheet,
} from '@resolution/visual';
import { stripTimeContextSuffix } from '../facts/name-guard';
import { scanGeoSignalsFromText } from '@resolution/geo';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  hasMeaningfulValue,
  isSameFactValue,
  mergeNullableStringArrays,
  shouldAdoptRuleMeta,
} from '../facts/fact-merge.util';
import {
  extractPresentedJobs,
  resolveAssistantAnchoredFocusJob,
  resolveCurrentFocusJob,
} from './session-job-matching';

/**
 * 会话记忆服务
 *
 * 统一封装当前 session 的结构化记忆：
 * - store: Redis 中的会话状态读写
 * - projection: 从对话中投影岗位相关事实
 * - extraction: 用 LLM 提取候选人结构化事实
 *
 * 它是会话记忆的唯一聚合入口。
 * 外部不应该直接拼 Redis key 来读写 `facts:*`，
 * 也不应该把“已展示岗位 / 当前焦点岗位”的判断逻辑散落到别处。
 */

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  /** 纯应答词判定的最大文本长度：超过即认为携带额外信息，不可跳过提取。 */
  private static readonly MAX_ACK_TEXT_LENGTH = 12;

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
    private readonly llm: LlmExecutorService,
    private readonly sponge: SpongeService,
    private readonly systemConfig: SystemConfigService,
    @Optional()
    private readonly tracer?: AgentTracerService,
    @Optional()
    private readonly geocoding?: GeocodingService,
    @Optional()
    private readonly chatSession?: ChatSessionService,
  ) {}

  // ==================== store ====================
  //
  // 存储形态：Redis hash（factsv2:*），每个 top-level 字段一个 hash field。
  //
  // 为什么不是单 JSON blob：save* 的"读整份-改-写整份"在并发写入方之间互相覆盖
  // （入站 fire-and-forget 的 recordCandidateActivity、复聊 processor 的
  // saveTerminalState 与 worker 回合收尾不持同一把锁，P0 丢更新）。hash 形态下
  // 每个 save* 只 HSET 自己的字段，跨字段并发写天然隔离。
  //
  // 同字段仍是 last-writer-wins：facts / presentedJobs / invitedGroups 的
  // "读-合并-写"依赖 chat 处理锁串行（同一 chat 的回合收尾在锁释放前 await 落盘），
  // 不持锁的写入方（activity/terminal）只碰各自独占的字段。
  //
  // 迁移：读时旧 blob（facts:*）与 hash 叠加（hash 字段优先），并用 HSETNX 把旧
  // blob 惰性回填进 hash 后删除旧 key；回填不会覆盖迁移窗口内的新写入。

  async getSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<WeworkSessionState> {
    // 这里统一返回完整的空态，避免调用方反复处理 null/undefined 的分支。
    const hashKey = this.buildHashKey(corpId, userId, sessionId);
    const legacyKey = this.buildKey(corpId, userId, sessionId);
    const hashFields = await this.redisStore.getHash(hashKey);

    // factsv2 命中后不再读取已经迁移并删除的 facts:* 旧 Key。
    // 生产数据已完成迁移；旧格式只在新 Hash 缺失时走一次兼容读取与惰性回填。
    const legacyEntry = hashFields ? null : await this.redisStore.get(legacyKey);

    const legacyContent =
      legacyEntry?.content && typeof legacyEntry.content === 'object'
        ? (legacyEntry.content as Record<string, unknown>)
        : null;
    if (legacyContent) {
      void this.migrateLegacyState(hashKey, legacyKey, legacyContent);
    }

    if (!hashFields && !legacyContent) return { ...EMPTY_SESSION_STATE };

    const combined = hashFields ?? legacyContent ?? {};
    const parsed = SessionFactsRedisContentSchema.safeParse(combined);
    if (!parsed.success) {
      this.logger.warn(
        `[getSessionState] Invalid session facts entry ignored: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { ...EMPTY_SESSION_STATE };
    }
    const content = parsed.data as Partial<WeworkSessionState>;

    return this.retireBrandsField({
      ...EMPTY_SESSION_STATE,
      ...content,
      lastCandidatePool: content.lastCandidatePool ?? null,
      presentedJobs: content.presentedJobs ?? null,
      currentFocusJob: content.currentFocusJob ?? null,
    });
  }

  /**
   * preferences.brands 字段退役墓碑（§19.6，2026-07-22 取代原只读投影）。
   *
   * 品牌唯一真相是 brand_state；需要展示品牌的消费方一律直读 brand_state
   * （提示词硬约束段、fact-lines 的 currentBrandName 选项、settlement 快照均已迁）。
   * 存储里的旧 brands 值在读边界统一抹平——deepMerge 的"null 不覆盖"语义会让
   * 收口前写入的旧值在长活跃会话里无限存续（如 6a1e42a5），逐个读方防御不如
   * 一处截断。schema 保留该字段仅为解析兼容，禁止任何读写复活。
   */
  private retireBrandsField(state: WeworkSessionState): WeworkSessionState {
    if (!state.facts || state.facts.preferences.brands == null) return state;
    return {
      ...state,
      facts: {
        ...state.facts,
        preferences: { ...state.facts.preferences, brands: null },
      },
    };
  }

  /**
   * 只写 patch 中的字段（HSET），其余字段不受影响。
   * 所有 save* 必须经此出口写入，禁止回到"读整份-写整份"。
   */
  private async patchSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
    patch: Partial<WeworkSessionState>,
  ): Promise<void> {
    const validated = this.serializeStateContent(patch) as Record<string, unknown>;
    await this.redisStore.patchHash(
      this.buildHashKey(corpId, userId, sessionId),
      validated,
      this.config.sessionTtl,
    );
  }

  /** 旧版单 blob → hash 的惰性迁移（HSETNX 只补缺失字段，迁移后删旧 key）。 */
  private async migrateLegacyState(
    hashKey: string,
    legacyKey: string,
    legacyContent: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.redisStore.backfillHash(hashKey, legacyContent, this.config.sessionTtl);
      await this.redisStore.del(legacyKey);
      this.logger.log(`[getSessionState] 旧版 session blob 已迁移为 hash: ${legacyKey}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[getSessionState] 旧版 session blob 迁移失败（下次读取重试）: ${message}`);
    }
  }

  async clearSessionState(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    const [hashDeleted, legacyDeleted] = await Promise.all([
      this.redisStore.del(this.buildHashKey(corpId, userId, sessionId)),
      this.redisStore.del(this.buildKey(corpId, userId, sessionId)),
    ]);
    return hashDeleted || legacyDeleted;
  }

  async getFacts(corpId: string, userId: string, sessionId: string): Promise<SessionFacts | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.facts;
  }

  async getAuthoritativeState(
    corpId: string,
    userId: string,
    sessionId: string,
    options?: { currentUserMessages?: readonly string[]; now?: number },
  ): Promise<AuthoritativeSessionState> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return this.deriveAuthoritativeState(state, options);
  }

  /**
   * 保存本轮提取的会话事实。
   *
   * 默认走 deepMerge（null/空串不覆盖旧值，保留历史积累）；但显式列入
   * `forceNullFields` / `forceNullPreferenceFields` 的字段会在 merge 之后覆盖为 null，
   * 用于让调用方把确定不该保留的旧值从 Redis 中清掉。
   *
   * 背景：badcase `batch_69e9bba2536c9654026522da_*` —— deepMerge 的 "null 不
   * 覆盖" 语义让 sanitizer 的 null 输出无法清除已污染的 name。新增该参数作为
   * 显式覆盖出口，sanitizer 命中时传 `['name']`。
   */
  async saveFacts(
    corpId: string,
    userId: string,
    sessionId: string,
    facts: EntityExtractionResult | SessionFacts,
    options?: {
      forceNullFields?: readonly (keyof EntityExtractionResult['interview_info'])[];
      forceNullPreferenceFields?: readonly (keyof EntityExtractionResult['preferences'])[];
    },
  ): Promise<void> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    const sessionFacts = this.ensureSessionFacts(facts);
    const baseMerge = state.facts
      ? this.mergeFactsWithConfidenceGuard(state.facts, sessionFacts)
      : sessionFacts;
    const forcedMerge = this.applyForceNullFields(
      baseMerge as SessionFacts,
      options?.forceNullFields,
      options?.forceNullPreferenceFields,
    );
    const mergedFacts = SessionFactsSchema.parse(forcedMerge) as SessionFacts;

    await this.patchSessionState(corpId, userId, sessionId, { facts: mergedFacts });
  }

  /**
   * 工具确权城市入档（候选人资料证据化 A1，badcase 6a671722 沈阳 / 6a618a6e 上海浦东）。
   *
   * geocode unique 解析出的城市写入 pref.city（source='tool'，confidence=high），
   * 让 invite 城市门的 session_fact 档与 [兼职群资源] 段不再依赖候选人字面报城市名。
   * 证据是外生工具结果（amap 解析），不是模型自报，不违背 HC-2「模型参数不自证」。
   *
   * 采信边界：
   * - 与既有 high 置信城市冲突时不覆盖——geocode 已通过 _cityConflictNotice 要求模型
   *   向候选人确认，城市切换只能走候选人亲证（T1），工具确权（T2）无权仲裁冲突；
   * - 同城重复确权跳过，避免每轮空写；
   * - 旧值为低置信/兼容迁移值时允许覆盖。
   */
  async saveToolAttestedCity(
    corpId: string,
    userId: string,
    sessionId: string,
    attestation: CityAttestation,
  ): Promise<'written' | 'skipped_same_city' | 'skipped_city_conflict' | 'skipped_invalid'> {
    const normalized = attestation.city.trim().replace(/市$/, '');
    if (!normalized) return 'skipped_invalid';

    const state = await this.getSessionState(corpId, userId, sessionId);
    const prev = state.facts?.preferences?.city ?? null;
    if (prev && typeof prev.value === 'string' && prev.value.trim()) {
      const prevNormalized = prev.value.trim().replace(/市$/, '');
      if (prevNormalized === normalized) return 'skipped_same_city';
      // 既有值不是可认领的城市名时，"冲突"是抽取污染伪造的，让位于工具确权。
      // 不这样兜，高置信垃圾城市会把 geocode 真实确权的城市永久挡在门外（存量自愈）。
      if (!isRecognizedCityName(prevNormalized)) {
        this.logger.warn(
          `[saveToolAttestedCity] 既有城市「${prev.value}」非合法城市名（抽取污染残留），` +
            `由本轮工具确权 ${normalized} 覆盖`,
        );
      } else if (sessionFactConfidenceRank(prev.confidence) >= sessionFactConfidenceRank('high')) {
        this.logger.log(
          `[saveToolAttestedCity] 城市冲突不覆盖：既有 ${prev.value}（${prev.confidence}/${prev.source}），` +
            `本轮工具确权 ${normalized}；等待候选人亲证后再切换`,
        );
        return 'skipped_city_conflict';
      }
    }

    const cityFact: SessionFactValue<string> = {
      value: normalized,
      confidence: 'high',
      source: 'tool',
      evidence: truncateEvidence(attestation.evidence),
      extractedAt: new Date().toISOString(),
    };
    // 除 city 外全字段 null（deepMerge "null 不覆盖"语义保证不动其他事实）；
    // city 的 SessionFactValue 形态由 NullableSessionCityFactSchema 联合类型直接接受。
    const facts = SessionFactsSchema.parse({
      ...FALLBACK_EXTRACTION,
      preferences: { ...FALLBACK_EXTRACTION.preferences, city: cityFact },
      reasoning: '工具确权城市入档（geocode 唯一解析）',
    }) as SessionFacts;
    await this.saveFacts(corpId, userId, sessionId, facts);
    this.logger.log(
      `[saveToolAttestedCity] pref.city=${normalized} 已入档（source=tool, ${attestation.source}）`,
    );
    return 'written';
  }

  private applyForceNullFields(
    facts: SessionFacts,
    forceNullFields?: readonly (keyof EntityExtractionResult['interview_info'])[],
    forceNullPreferenceFields?: readonly (keyof EntityExtractionResult['preferences'])[],
  ): SessionFacts {
    if (
      (!forceNullFields || forceNullFields.length === 0) &&
      (!forceNullPreferenceFields || forceNullPreferenceFields.length === 0)
    ) {
      return facts;
    }
    // 两组字段类型异构（string|null、boolean|null、数组等），
    // 用 Record 视图收敛成 null 赋值，避免逐字段命中具体联合类型的推导限制。
    const interview = { ...facts.interview_info } as Record<
      keyof SessionFacts['interview_info'],
      unknown
    >;
    for (const field of forceNullFields ?? []) {
      interview[field] = null;
    }
    const preferences = { ...facts.preferences } as Record<
      keyof SessionFacts['preferences'],
      unknown
    >;
    for (const field of forceNullPreferenceFields ?? []) {
      preferences[field] = null;
    }
    return {
      ...facts,
      interview_info: interview as SessionFacts['interview_info'],
      preferences: preferences as SessionFacts['preferences'],
    };
  }

  /**
   * 跨轮合并 + 置信度守卫。
   *
   * deepMerge 对 SessionFactValue 是逐 key 递归：新值非空就连 value 带 confidence 一起
   * 覆盖，完全不比较新旧置信度。生产 badcase（chat 69a13e919d6d3a463b0a37c6）：候选人
   * 明确确认的 applied_position="后厨" 被后续轮 LLM 推断 "内场"(medium) 覆盖。
   * Profile 层（Supabase RPC）有 "high 不被非 high 覆盖" 守卫，session 层必须有
   * 同等语义：新值置信度严格低于旧值时，保留旧值整体（含元数据）。
   * 数组字段维持累积语义，不受守卫影响。
   */
  private mergeFactsWithConfidenceGuard(prev: SessionFacts, incoming: SessionFacts): SessionFacts {
    const merged = deepMerge(prev, incoming) as SessionFacts;

    for (const group of ['interview_info', 'preferences'] as const) {
      const prevGroup = prev[group] as unknown as Record<string, unknown>;
      const incomingGroup = incoming[group] as unknown as Record<string, unknown>;
      const mergedGroup = merged[group] as unknown as Record<string, unknown>;

      for (const field of Object.keys(prevGroup)) {
        const prevVal = prevGroup[field];
        const incomingVal = incomingGroup[field];
        if (!isSessionFactValue(prevVal) || !isSessionFactValue(incomingVal)) continue;
        if (Array.isArray(prevVal.value) || Array.isArray(incomingVal.value)) continue;
        if (isSameFactValue(prevVal.value, incomingVal.value)) continue;

        if (
          sessionFactConfidenceRank(incomingVal.confidence) <
          sessionFactConfidenceRank(prevVal.confidence)
        ) {
          mergedGroup[field] = prevVal;
          this.logger.log(
            `[saveFacts] 置信度守卫：${group}.${field} 保留旧值（${prevVal.confidence}/${prevVal.source}），` +
              `拒绝低置信新值（${incomingVal.confidence}/${incomingVal.source}）覆盖`,
          );
        }
      }
    }

    return merged;
  }

  private deriveAuthoritativeState(
    state: WeworkSessionState,
    options?: { currentUserMessages?: readonly string[]; now?: number },
  ): AuthoritativeSessionState {
    const recalledJobIds = new Set<number>();
    for (const job of [
      ...(state.presentedJobs ?? []),
      ...(state.lastCandidatePool ?? []),
      ...(state.currentFocusJob ? [state.currentFocusJob] : []),
    ]) {
      if (Number.isFinite(job.jobId)) recalledJobIds.add(job.jobId);
    }

    // HC-2：当前轮候选人原文经 parser 解析为 user_text provenance；持久化 session facts
    // 仅用于跨轮状态判断（如 booking_incomplete 复聊停止条件），不作为模型工具参数自证。
    const persistedCollectedFields = this.projectCollectedFieldsFromSessionFacts(
      state.facts,
      options?.now ?? Date.now(),
    );
    const currentCollectedFields = options?.currentUserMessages?.length
      ? parseCandidateFieldsFromText(options.currentUserMessages, options.now ?? Date.now())
      : {};
    const collectedFields = { ...persistedCollectedFields, ...currentCollectedFields };

    const lastCandidateMessageAt = state.lastCandidateMessageAt
      ? Date.parse(state.lastCandidateMessageAt)
      : NaN;
    const lastProcessedCandidateMessageAt = state.lastProcessedCandidateMessageAt
      ? Date.parse(state.lastProcessedCandidateMessageAt)
      : NaN;

    return {
      collectedFields,
      recalledJobIds,
      hardConstraints: [],
      presentedStores: (state.presentedJobs ?? []).map((job) => ({ jobId: job.jobId })),
      invitedGroups: state.invitedGroups ?? [],
      stage: null,
      terminal: state.terminal ?? undefined,
      lastCandidateMessageAt: Number.isFinite(lastCandidateMessageAt)
        ? lastCandidateMessageAt
        : undefined,
      lastProcessedCandidateMessageAt: Number.isFinite(lastProcessedCandidateMessageAt)
        ? lastProcessedCandidateMessageAt
        : undefined,
    };
  }

  private projectCollectedFieldsFromSessionFacts(
    facts: SessionFacts | null | undefined,
    now: number,
  ): AuthoritativeSessionState['collectedFields'] {
    if (!facts) return {};
    const collectedFields: AuthoritativeSessionState['collectedFields'] = {};
    for (const key of ['name', 'phone', 'age', 'gender'] as const) {
      const fact = facts.interview_info[key];
      const value = unwrapSessionFactValue(fact);
      if (!hasMeaningfulValue(value)) continue;
      const extractedAt =
        isSessionFactValue(fact) && fact.extractedAt ? Date.parse(fact.extractedAt) : NaN;
      collectedFields[key] = {
        value: String(value),
        provenance: this.toCollectedFieldProvenance(
          isSessionFactValue(fact) ? fact.source : undefined,
        ),
        evidence: isSessionFactValue(fact) ? fact.evidence : undefined,
        at: Number.isFinite(extractedAt) ? extractedAt : now,
      } satisfies CollectedField;
    }
    return collectedFields;
  }

  private toCollectedFieldProvenance(source?: SessionFactSource): FieldProvenance {
    if (source === 'candidate' || source === 'rule') return 'user_text';
    if (source === 'system') return 'booking_writeback';
    return 'llm_extract';
  }

  async saveLastCandidatePool(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    const validatedJobs = jobs.map(
      (job) => RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary,
    );
    await this.patchSessionState(corpId, userId, sessionId, { lastCandidatePool: validatedJobs });
  }

  /** 记录本轮 duliday_job_list 查询签名，供下一轮做跨轮重复查询检测。 */
  async saveLastJobListQuery(
    corpId: string,
    userId: string,
    sessionId: string,
    record: JobListQueryRecord,
  ): Promise<void> {
    const validated = JobListQueryRecordSchema.parse(record) as JobListQueryRecord;
    await this.patchSessionState(corpId, userId, sessionId, { lastJobListQuery: validated });
  }

  async savePresentedJobs(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    if (jobs.length === 0) return;

    const state = await this.getSessionState(corpId, userId, sessionId);
    const validatedJobs = jobs.map(
      (job) => RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary,
    );
    const merged = [...validatedJobs, ...(state.presentedJobs ?? [])].filter(
      (job, index, arr) => arr.findIndex((item) => item.jobId === job.jobId) === index,
    );

    await this.patchSessionState(corpId, userId, sessionId, {
      presentedJobs: merged.slice(0, 10),
    });
  }

  /**
   * 把工具已判定失效（海绵查不到：下架/满员）的岗位从会话岗位记忆里剔除。
   *
   * 覆盖 lastCandidatePool / presentedJobs / currentFocusJob 三处——它们同时是
   * 下一轮 prompt 的岗位来源与 precheck/booking 的 jobId provenance 集，漏掉任一处
   * 死岗位就会被重新喂给模型。
   *
   * 背景（badcase chat 6a685393，jobId 528572）：岗位失效后仍留在记忆中，模型连续
   * 3 轮拿同一 jobId 重试 precheck，每轮都 job_not_found，最终转人工。
   *
   * @returns 实际被移除的 jobId（用于观测；空数组表示记忆里本就没有它们）
   */
  async dropInvalidatedJobs(
    corpId: string,
    userId: string,
    sessionId: string,
    jobIds: number[],
  ): Promise<number[]> {
    if (jobIds.length === 0) return [];

    const dead = new Set(jobIds);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const removed = new Set<number>();

    const prune = (jobs: RecommendedJobSummary[] | null | undefined) => {
      const kept = (jobs ?? []).filter((job) => {
        if (!dead.has(job.jobId)) return true;
        removed.add(job.jobId);
        return false;
      });
      return { kept, changed: kept.length !== (jobs ?? []).length };
    };

    const candidatePool = prune(state.lastCandidatePool);
    const presented = prune(state.presentedJobs);
    const focusIsDead = state.currentFocusJob ? dead.has(state.currentFocusJob.jobId) : false;
    if (focusIsDead && state.currentFocusJob) removed.add(state.currentFocusJob.jobId);

    if (!candidatePool.changed && !presented.changed && !focusIsDead) return [];

    await this.patchSessionState(corpId, userId, sessionId, {
      ...(candidatePool.changed ? { lastCandidatePool: candidatePool.kept } : {}),
      ...(presented.changed ? { presentedJobs: presented.kept } : {}),
      ...(focusIsDead ? { currentFocusJob: null } : {}),
    });

    return [...removed];
  }

  async saveCurrentFocusJob(
    corpId: string,
    userId: string,
    sessionId: string,
    job: RecommendedJobSummary | null,
  ): Promise<void> {
    const validatedJob = job
      ? (RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary)
      : null;
    await this.patchSessionState(corpId, userId, sessionId, { currentFocusJob: validatedJob });
  }

  async saveInvitedGroup(
    corpId: string,
    userId: string,
    sessionId: string,
    record: InvitedGroupRecord,
  ): Promise<void> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    const validated = InvitedGroupRecordSchema.parse(record) as InvitedGroupRecord;
    const existing = state.invitedGroups ?? [];
    // 按群名去重
    const merged = [validated, ...existing].filter(
      (g, i, arr) => arr.findIndex((item) => item.groupName === g.groupName) === i,
    );

    await this.patchSessionState(corpId, userId, sessionId, { invitedGroups: merged });
  }

  /**
   * 持久化会话终态（复聊 shouldStop 的权威停发信号）。
   * 幂等覆盖写：新终态直接覆盖旧值（如 booked → handed_off）。
   */
  async saveTerminalState(
    corpId: string,
    userId: string,
    sessionId: string,
    terminal: AuthoritativeSessionState['terminal'],
  ): Promise<void> {
    await this.patchSessionState(corpId, userId, sessionId, { terminal: terminal ?? null });
    this.logger.log(
      `[saveTerminalState] terminal=${terminal ?? '-'} corpId=${corpId} userId=${userId} sessionId=${sessionId}`,
    );
  }

  /**
   * 记录候选人入站活动时间（复聊 shouldStop 的「锚点后已回话」停发信号）。
   * 每个入站轮调用一次；主动复聊轮不得调用（占位 user 文本不是候选人活动）。
   */
  async recordCandidateActivity(
    corpId: string,
    userId: string,
    sessionId: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.patchSessionState(corpId, userId, sessionId, {
      lastCandidateMessageAt: at.toISOString(),
    });
  }

  /**
   * 推进「候选人消息已被成功处理」时间水位（复聊停止判定的第二信号）。
   * 由 reply-workflow 在回合成功收尾（正常投递或有意沉默）时按本轮消费的候选人消息
   * 最大时间戳调用；timeout 静默丢弃的消息不会推进水位，复聊据此识别无人搭理的回话。
   */
  async recordCandidateMessagesProcessed(
    corpId: string,
    userId: string,
    sessionId: string,
    at: Date,
  ): Promise<void> {
    await this.patchSessionState(corpId, userId, sessionId, {
      lastProcessedCandidateMessageAt: at.toISOString(),
    });
  }

  // ==================== projection ====================

  async projectAssistantTurn(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    const { corpId, userId, sessionId, userText, assistantText } = params;
    if (!assistantText.trim()) return;

    const state = await this.getSessionState(corpId, userId, sessionId);

    // 第一步：根据 assistantText 识别“这轮真正展示过哪些岗位”。
    const presentedJobs = extractPresentedJobs(assistantText, state.lastCandidatePool ?? []);
    if (presentedJobs.length > 0) {
      await this.savePresentedJobs(corpId, userId, sessionId, presentedJobs);
    }

    // 第二步：结合 userText + 已展示岗位 + 候选池，判断用户当前锁定的是哪个岗位。
    // 这里允许“不确定”，宁可不锁，也不要在多候选场景下猜错。
    const focusJob = resolveCurrentFocusJob(
      userText,
      state.presentedJobs ?? [],
      presentedJobs,
      state.lastCandidatePool ?? [],
    );

    if (focusJob !== undefined) {
      await this.saveCurrentFocusJob(corpId, userId, sessionId, focusJob);
      return;
    }

    const assistantAnchoredFocusJob = resolveAssistantAnchoredFocusJob(
      assistantText,
      state.presentedJobs ?? [],
      presentedJobs,
      state.lastCandidatePool ?? [],
    );

    if (assistantAnchoredFocusJob) {
      await this.saveCurrentFocusJob(corpId, userId, sessionId, assistantAnchoredFocusJob);
    }
  }

  // ==================== extraction ====================

  async extractAndSave(
    corpId: string,
    userId: string,
    sessionId: string,
    messages: { role: string; content: string }[],
  ): Promise<{ llmDegraded: boolean; brandIntents: BrandResolution[] }> {
    const dialogueMessages = messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0,
    );
    if (dialogueMessages.length === 0) return { llmDegraded: false, brandIntents: [] };

    // 会话段切割：短期窗口跨 7 天，可能包含已了结的旧会话。旧会话的报名/约面
    // 事务字段一旦被重新提取，会"复活"成当前会话事实（生产 badcase：chat
    // 69a13e919d6d3a463b0a37c6，session facts 过期后首次提取吃了 5 天前的历史，
    // 把已作废的 applied_store/interview_time 拉回当前记忆）。
    // 这里按消息时间间隙（≥ settlementGap，与沉淀边界同语义）截断到最近一段
    // 连续会话；旧会话知识走 settlement → 长期画像/摘要通道，不进 session facts。
    const scopedMessages = this.trimToCurrentSessionSegment(dialogueMessages);

    // conversationHistory 是“本轮最后一条消息之前的历史”，
    // currentMessage 是“本轮最后一条消息”。
    // 这样做是为了让提取 prompt 明确区分“新信息”与“历史上下文”。
    const allHistory = scopedMessages.map(
      (m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`,
    );

    const currentMessage = allHistory.at(-1) ?? '';
    const conversationHistory = allHistory.slice(0, -1);
    const userMessages = scopedMessages.filter((m) => m.role === 'user').map((m) => m.content);

    // 视觉事实读路径（visual-fact-structuring §3.3）：窗口含视觉消息时拉本会话 sheet，
    // 以「剥时间后缀的内容」等值匹配——描述由 updateMessageContent 整条写入，
    // 窗口内容与库中逐字一致（时间后缀是窗口侧注入的，匹配前剥掉）。
    // 拉取失败/无 sheet 一律回落 PR #870 的文本前缀判定，行为等同现状。
    const visualKey = (text: string): string => stripTimeContextSuffix(text).trim();
    let visualSheetsByContent: Map<string, FinalizedVisualFactSheet> | undefined;
    if (this.chatSession && userMessages.some((m) => isVisualDescriptionText(visualKey(m)))) {
      try {
        const rows = await this.chatSession.getVisualFacts(sessionId, {
          sinceTimestamp: Date.now() - this.config.historyWindowSeconds * 1000,
        });
        const map = new Map<string, FinalizedVisualFactSheet>();
        for (const row of rows) {
          const sheet = parseStoredVisualFactSheet(row.visualFacts);
          if (sheet && !sheet.degraded) map.set(row.content.trim(), sheet);
        }
        if (map.size > 0) visualSheetsByContent = map;
      } catch (error) {
        this.logger.warn(
          `[extractFacts] 视觉事实拉取失败（回落文本前缀判定）: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const sheetOf = (text: string): FinalizedVisualFactSheet | undefined =>
      visualSheetsByContent?.get(visualKey(text));
    // 自陈语料（裁决 A.2 通道③入口）：手打文本 + 候选人自陈材料（简历/证件）。
    // 引用块剥离（评审阻断项，2026-08-05）：候选人引用回复经理消息时，
    // `[引用 店长：…电话138…]` 引用块携带经理原文——不剥则经理号码被当自陈出处，
    // foreignPhone 门失效，P0 经引用向量复现。被引用内容的合法证据来源是
    // assistantTexts（原始助手消息本就在其中），从自陈语料剥除不损失证据。
    const typedOrSelfMaterialMessages = userMessages
      .filter((m) => {
        const key = visualKey(m);
        if (!isVisualDescriptionText(key)) return true;
        return isSelfReportedVisualMessage(key, sheetOf(m));
      })
      .map((m) => stripQuotedBlocks(m));

    const previousFacts = await this.getFacts(corpId, userId, sessionId);
    // 事实提取每轮都会触发，但不是每轮都全量重算：
    // - 首次提取：使用当前会话段里的全部历史
    // - 增量提取：只回看最近 N 条历史，降低 token 成本
    const messagesToProcess = previousFacts
      ? conversationHistory.slice(-this.config.sessionExtractionIncrementalMessages)
      : conversationHistory;
    const processedCount = messagesToProcess.length;
    const skippedCount = Math.max(conversationHistory.length - processedCount, 0);
    const savingPercent =
      conversationHistory.length > 0
        ? Math.round((skippedCount / conversationHistory.length) * 100)
        : 0;

    this.logger.log(
      `[extractFacts] Cache ${previousFacts ? 'hit' : 'miss'}, ` +
        `sessionSegment ${scopedMessages.length}/${dialogueMessages.length} messages, ` +
        `processing ${processedCount}/${conversationHistory.length} history messages ` +
        `(token saving: ${savingPercent}%)`,
    );

    const brandData = await this.sponge.fetchBrandList();

    // 纯应答闸门：已有 facts、本轮最后一条用户消息是纯应答词（"好的/嗯嗯/谢谢"）、
    // 且对该消息的规则提取零命中时，跳过本轮 LLM 提取——这类轮次没有新事实，
    // 却要支付完整的提取调用（品牌列表 + 规则线索 + 历史，数千 tokens）。
    // 信息不会永久丢失：下一轮非应答消息的增量窗口仍覆盖本轮上下文（含助手
    // 推荐 + 本次应答），"嗯嗯确认岗位"语义会在下一轮被补提取。
    const lastUserText = MessageParser.stripTimeContext(userMessages.at(-1) ?? '').trim();
    const currentLaborFormIntent = decideLaborFormIntent(lastUserText);

    // 确认问答裁决（候选人资料证据化 P1，badcase 6a671722："是在沈阳市对吧？"→"好的"）：
    // 必须在纯应答闸门之前算——确认应答（"好的/对/嗯"）恰恰是纯应答词，走闸门
    // 早退会把系统自己发起的确认协议的答案丢掉。纯正则零 LLM，成本可忽略。
    const confirmedCity = resolveConfirmedCityFact(scopedMessages);
    const confirmedCityFact: SessionFactValue<string> | null = confirmedCity
      ? {
          value: confirmedCity.city,
          confidence: 'high',
          source: 'candidate',
          evidence: truncateEvidence(
            `确认应答：「${confirmedCity.question}」→「${confirmedCity.reply}」`,
          ),
          extractedAt: new Date().toISOString(),
        }
      : null;

    if (previousFacts && this.isPureAcknowledgment(lastUserText)) {
      const currentTurnRuleHits = extractHighConfidenceFacts([lastUserText], brandData, {
        visualSheetsByContent,
      });
      if (!currentTurnRuleHits) {
        // 纯应答轮唯一可能携带的新事实就是确认裁决：有则单写 city 后再早退
        if (confirmedCityFact) {
          const cityOnlyFacts = SessionFactsSchema.parse({
            ...FALLBACK_EXTRACTION,
            preferences: { ...FALLBACK_EXTRACTION.preferences, city: confirmedCityFact },
            reasoning: '确认问答裁决入档（纯应答轮）',
          }) as SessionFacts;
          await this.saveFacts(corpId, userId, sessionId, cityOnlyFacts);
          this.logger.log(
            `[extractFacts] 确认问答裁决入档: pref.city=${confirmedCityFact.value}（纯应答轮，跳过 LLM 提取）`,
          );
        } else {
          this.logger.log(`[extractFacts] 纯应答轮无新信号，跳过 LLM 提取：「${lastUserText}」`);
        }
        return { llmDegraded: false, brandIntents: [] };
      }
    }

    // 品牌线索：引用块剥离在 detectBrandAliasHints 入口内完成（§19.2），此处传原始消息。
    const aliasHints = detectBrandAliasHints(userMessages, brandData);
    const ruleFacts = extractHighConfidenceFacts(userMessages, brandData, {
      visualSheetsByContent,
    });
    const highConfidenceRuleFacts = filterHighConfidenceFacts(ruleFacts);
    const prompt = buildSessionExtractionPrompt(
      brandData,
      currentMessage,
      messagesToProcess,
      aliasHints,
      ruleFacts,
      MessageParser.formatCurrentTime(),
      previousFacts,
    );
    const {
      facts: llmRaw,
      explicitProvenance,
      brandIntents: rawBrandIntents,
      degraded: llmDegraded,
    } = await this.callLLM(prompt);
    // 先 sanitize LLM 输出，再 merge 规则 — 确保 LLM 昵称被 drop 后规则的结构化姓名能补位。
    // 真名索取问答豁免（badcase 2026-08-06 chat 6a7446eb）：候选人开场"我是张丽鑫"命中
    // 打招呼语判据，但 Agent 随后明确问真名、她单独回了"张丽鑫"——被问之后给出的名字是
    // 真名亲证，不能再当昵称丢弃，否则 name 永远进不了档、Agent 反复追问同一个问题。
    const llmExtractedName = llmRaw.interview_info?.name?.trim();
    const nameAnsweredToAsk =
      !!llmExtractedName && isNameAnsweredToRealNameAsk(llmExtractedName, scopedMessages);
    const {
      sanitized: sanitizedLlm,
      droppedName,
      droppedReason,
    } = nameAnsweredToAsk
      ? { sanitized: llmRaw, droppedName: null, droppedReason: null }
      : sanitizeInterviewName(llmRaw, userMessages);
    if (droppedName) {
      const reasonText =
        droppedReason === 'honorific_suffix'
          ? `丢弃称谓/商号形态的姓名"${droppedName}"（称谓后缀结尾，非本人姓名）`
          : `丢弃来自"我是xx"打招呼语的昵称"${droppedName}"`;
      this.logger.log(`[extractFacts] ${reasonText}，不写入 interview_info.name`);
      // 该丢弃此前只有日志、无观测档，同案排障只能靠"快照里 name 恒为 null"反推。
      this.tracer?.emit({
        type: 'extraction_field_dropped',
        corpId,
        userId,
        chatId: sessionId,
        field: 'name',
        droppedValue: droppedName,
        reason: droppedReason ?? 'auto_greeting_nickname',
      });
    }
    const newFacts = this.applyExplicitProvenanceUpgrade(
      this.mergeRuleAndLlmFacts(sanitizedLlm, highConfidenceRuleFacts),
      explicitProvenance,
      userMessages,
    );

    // 定位分享城市证据化（候选人资料证据化 A2，badcase 6a618a6e 上海浦东）：
    // GPS 坐标是候选人给出的最强位置证据，但渲染文本常无城市名（"黎明村98号楼"），
    // 规则/LLM 轨都抽不出 → 坐标逆解后按 source='tool' 入档。
    // 本轮文本已抽出高置信城市时让位（T1 亲证 > T2 工具确权）。
    const currentTurnUserTexts: string[] = [];
    for (let i = scopedMessages.length - 1; i >= 0 && scopedMessages[i].role === 'user'; i--) {
      currentTurnUserTexts.unshift(scopedMessages[i].content);
    }
    const locationCityFact = await this.buildLocationShareCityFact(
      currentTurnUserTexts,
      newFacts.preferences.city,
    );
    if (locationCityFact) {
      newFacts.preferences.city = locationCityFact;
    }

    // 地图截图城市确权（visual-fact-structuring R3，badcase oaz6inzf / x3pdj7qh）：
    // 本轮末尾连续 user 块里的 map_location sheet，其 city/address 字段经 geo 白名单
    // 确权后按 source='tool' 入档——与定位分享（A2）同级证据、同让位规则：
    // 本轮文本已产出高置信城市时让位（T1 亲证 > T2 工具确权）。
    if (
      visualSheetsByContent &&
      !(newFacts.preferences.city && newFacts.preferences.city.confidence === 'high')
    ) {
      outer: for (const text of currentTurnUserTexts) {
        const sheet = sheetOf(text);
        if (!sheet || sheet.kind !== 'map_location') continue;
        const candidates = [
          ...fieldValues(sheet, 'city'),
          ...fieldValues(sheet, 'address'),
          ...fieldValues(sheet, 'candidate_address'),
        ];
        for (const candidate of candidates) {
          const scan = scanGeoSignalsFromText(candidate);
          const city = scan.city?.value?.trim().replace(/市$/, '');
          if (!city) continue;
          newFacts.preferences.city = {
            value: city,
            confidence: 'high',
            source: 'tool',
            evidence: truncateEvidence(`地图截图城市确权：${candidate}`),
            extractedAt: new Date().toISOString(),
          };
          this.logger.log(`[extractFacts] 地图截图城市确权入档: pref.city=${city}（source=tool）`);
          break outer;
        }
      }
    }

    // is_student 首写证据门（badcase 2026-07-28 chat 6a673402…）：抽取模型可在零身份
    // 语境下凭空发明布尔身份（该案候选人只说过"川沙"，evidence 自证"未提及，不填"
    // 仍输出 false），随后经 [已确认事实] 逐轮延续，毒化身份守卫第 4 档与展示层。
    // 字段级丢弃而非整轮判失败——同轮其它字段可能是合法提取（该案同轮 city=上海
    // 即合法），name/phone 的 throw 全轮策略在此会连坐。
    const assistantTexts = scopedMessages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    const previousIsStudent = unwrapSessionFactValue(previousFacts?.interview_info.is_student);
    const extractedIsStudent = unwrapSessionFactValue(newFacts.interview_info.is_student);
    if (
      typeof previousIsStudent !== 'boolean' &&
      typeof extractedIsStudent === 'boolean' &&
      !hasIsStudentTopicEvidence(typedOrSelfMaterialMessages, assistantTexts)
    ) {
      newFacts.interview_info.is_student = null;
      this.logger.warn(
        `[extractFacts] is_student 首写无会话身份语境，丢弃臆造值 ${extractedIsStudent}`,
      );
      this.tracer?.emit({
        type: 'extraction_field_dropped',
        corpId,
        userId,
        chatId: sessionId,
        field: 'is_student',
        droppedValue: String(extractedIsStudent),
        reason: 'first_write_no_identity_context',
      });
    }

    // 明示型字段臆造门（badcase 2026-07-29 chat 6a69674e… / 6a69790b…）：抽取模型在
    // reasoning 自证"用户没有提供其它信息，所有字段均省略"的同一次输出里，写下了整套
    // 臆造档案（phone="18"/"100％"、has_health_certificate="有"、applied_store="人民广场店"、
    // 户籍"江苏"…），随后经 [已确认事实] 全程沿用。三道门按字段自身的可推断性分工，
    // 都做字段级丢弃（与 is_student 门同策略，避免 throw 连坐同轮合法字段）。
    const provenanceContext = [...userMessages, ...assistantTexts];
    const dropInterviewField = (
      field: keyof SessionFacts['interview_info'],
      droppedValue: unknown,
      reason: string,
      logMessage: string,
    ): void => {
      (newFacts.interview_info as unknown as Record<string, unknown>)[field] = null;
      this.logger.warn(logMessage);
      this.tracer?.emit({
        type: 'extraction_field_dropped',
        corpId,
        userId,
        chatId: sessionId,
        field,
        droppedValue: String(droppedValue),
        reason,
      });
    };

    // 引用发言人姓名门（badcase or9d6viv，chat 6a6c4e4e：interview.name 被写成经理显示名
    // "辛瑜琦"——它只以"[引用 辛瑜琦：…]"前缀出现在候选人消息里，7-21 的 booking 预填闸
    // 拦得住预填、拦不住抽取首写）。名字只以引用前缀发言人身份出现=极可能是经理名，字段级丢弃。
    const extractedName = unwrapSessionFactValue(newFacts.interview_info.name);
    const droppedQuotedSpeakerName =
      typeof extractedName === 'string' && isNameOnlyQuotedSpeaker(extractedName, scopedMessages);
    if (droppedQuotedSpeakerName) {
      dropInterviewField(
        'name',
        extractedName,
        'quoted_speaker_name',
        `[extractFacts] name 只以引用前缀发言人身份出现（极可能是经理名），丢弃「${extractedName}」`,
      );
    }

    // 姓名形态门（badcase 2026-08-04 vkikct39，同案）：同一次抽取把手机号写进了 name
    // （evidence 原文："**name / phone**：沿用已确认事实 13788930869"）。
    // sanitizeInterviewName 只拦"我是XX"打招呼语昵称，纯数字值直接穿透，随后被当真名
    // 预填进收资表。与上面的经理名门同属 name 字段，共用 extractedName。
    const droppedDigitsName =
      !droppedQuotedSpeakerName &&
      typeof extractedName === 'string' &&
      isDigitsOnlyName(extractedName);
    if (droppedDigitsName) {
      dropInterviewField(
        'name',
        extractedName,
        'digits_only_name',
        `[extractFacts] name 为纯数字形态（疑似手机号错填姓名），丢弃「${extractedName}」`,
      );
    }

    // 手机号形态门：非 11 位手机号形态一律丢（出处门只管 ≥7 位数字流，短垃圾值绕过）。
    const extractedPhone = unwrapSessionFactValue(newFacts.interview_info.phone);
    const invalidPhoneShape =
      typeof extractedPhone === 'string' && !isStorableCandidatePhone(extractedPhone);
    if (invalidPhoneShape) {
      dropInterviewField(
        'phone',
        extractedPhone,
        'invalid_phone_shape',
        `[extractFacts] phone 非 11 位手机号形态，丢弃臆造值「${extractedPhone}」`,
      );
    }

    // 第三方截图夺号门（badcase 2026-08-04 vkikct39，chat 6a714c00…，P0）：
    // assertExtractionIdentityProvenance 的出处门认整个提取 prompt，**包含图片描述**，
    // 于是候选人转发的 BOSS 直聘岗位截图里**发布方**的手机号，形态合法（11 位）、
    // 出处也"找得到"，一路落进 interview_info.phone，最后被提交进真实报名 ——
    // AI 面试短信发到了招募经理手机上。号码必须是候选人自己敲出来的（或来自他本人的
    // 简历图片），只在与旧值不同时校验，已确立的号码沿用不受影响。
    const previousPhone = unwrapSessionFactValue(previousFacts?.interview_info.phone);
    const foreignPhone =
      !invalidPhoneShape &&
      typeof extractedPhone === 'string' &&
      extractedPhone !== previousPhone &&
      !hasSelfReportedPhoneProvenance(extractedPhone, typedOrSelfMaterialMessages, {
        prefiltered: true,
      });
    if (foreignPhone) {
      dropInterviewField(
        'phone',
        extractedPhone,
        'phone_not_self_reported',
        `[extractFacts] phone 只出现在图片描述等第三方内容中，丢弃非自陈号码「${extractedPhone}」`,
      );
    }
    const droppedPhone = invalidPhoneShape || foreignPhone;

    // 门店/户籍窗口出处门：两字段规则均已声明只能来自明示，值必是对话里出现过的串；
    // 只在"与旧值不同"时校验，已确立的旧值沿用不受影响。
    for (const field of ['applied_store', 'household_register_province'] as const) {
      const extracted = unwrapSessionFactValue(newFacts.interview_info[field]);
      const previous = unwrapSessionFactValue(previousFacts?.interview_info[field]);
      if (
        typeof extracted === 'string' &&
        extracted !== previous &&
        !hasFieldProvenanceInWindow(extracted, provenanceContext)
      ) {
        dropInterviewField(
          field,
          extracted,
          'no_provenance_in_window',
          `[extractFacts] ${field} 在会话窗口无出处，丢弃臆造值「${extracted}」`,
        );
      }
    }

    // 健康证首写证据门：值域是短词无法做子串出处校验，改用话题词证据门（同 is_student）。
    // 该字段直接放行 booking 有证 gate，是本组臆造字段里后果最重的一个。
    const previousHealthCert = unwrapSessionFactValue(
      previousFacts?.interview_info.has_health_certificate,
    );
    const extractedHealthCert = unwrapSessionFactValue(
      newFacts.interview_info.has_health_certificate,
    );
    if (
      previousHealthCert == null &&
      extractedHealthCert != null &&
      !hasHealthCertificateTopicEvidence(typedOrSelfMaterialMessages, assistantTexts)
    ) {
      dropInterviewField(
        'has_health_certificate',
        extractedHealthCert,
        'first_write_no_health_cert_context',
        `[extractFacts] has_health_certificate 首写无健康证语境，丢弃臆造值「${String(extractedHealthCert)}」`,
      );
    }

    // 标量扇出熔断（badcase 6a6c4c13：整句"晚上才可以，有吗？"同轮写进 city/salary/age，
    // 2026-08-03 抽样 12% 会话中招）：同一非空字符串被同轮抽取写进 ≥3 个字段，必是提取
    // 输出错位/裸标量广播。该值的所有字段整组丢弃（字段级，不连坐同轮其它合法字段）。
    const fanoutScan: Record<string, unknown> = {};
    for (const field of INTERVIEW_INFO_FIELD_KEYS) {
      fanoutScan[`interview_info.${field}`] = unwrapSessionFactValue(
        newFacts.interview_info[field] as never,
      );
    }
    for (const field of PREFERENCE_FIELD_KEYS) {
      fanoutScan[`preferences.${field}`] = unwrapSessionFactValue(
        (newFacts.preferences as unknown as Record<string, unknown>)[field] as never,
      );
    }
    const fanoutValues = detectScalarFanoutValues(fanoutScan);
    if (fanoutValues.size > 0) {
      for (const [fieldPath, value] of Object.entries(fanoutScan)) {
        if (typeof value !== 'string' || !fanoutValues.has(value.trim())) continue;
        const [group, field] = fieldPath.split('.') as ['interview_info' | 'preferences', string];
        (newFacts[group] as unknown as Record<string, unknown>)[field] = null;
        this.logger.warn(
          `[extractFacts] 标量扇出熔断：${fieldPath} 与 ≥${SCALAR_FANOUT_FIELD_THRESHOLD - 1} 个其他字段同值，丢弃「${value}」`,
        );
        this.tracer?.emit({
          type: 'extraction_field_dropped',
          corpId,
          userId,
          chatId: sessionId,
          field,
          droppedValue: String(value),
          reason: 'scalar_fanout',
        });
      }
    }

    // 城市/年龄形状门（同案）：垃圾城市曾被归一化抬成 high/explicit_city，还会压制
    // 下方确认问答裁决的真实城市，必须在裁决前清掉。
    const shapeGateCity = unwrapSessionFactValue(newFacts.preferences.city);
    let droppedCity = false;
    if (typeof shapeGateCity === 'string' && !isPlausibleCityValue(shapeGateCity)) {
      newFacts.preferences.city = null;
      droppedCity = true;
      this.logger.warn(`[extractFacts] pref.city 形状非法，丢弃臆造值「${shapeGateCity}」`);
      this.tracer?.emit({
        type: 'extraction_field_dropped',
        corpId,
        userId,
        chatId: sessionId,
        field: 'city',
        droppedValue: shapeGateCity,
        reason: 'invalid_city_shape',
      });
    }
    const shapeGateAge = unwrapSessionFactValue(newFacts.interview_info.age);
    if (shapeGateAge != null && !isPlausibleAgeValue(shapeGateAge)) {
      dropInterviewField(
        'age',
        shapeGateAge,
        'invalid_age_shape',
        `[extractFacts] age 形状非法（须为 14-70 单一数字），丢弃臆造值「${String(shapeGateAge)}」`,
      );
    }

    // 确认问答裁决（非纯应答轮路径，如"好的，我25岁"带出其他事实时）：
    // 本轮文本/定位已产出高置信城市则让位（显式线索优先于确认推断）。
    if (
      confirmedCityFact &&
      !(newFacts.preferences.city && newFacts.preferences.city.confidence === 'high')
    ) {
      newFacts.preferences.city = confirmedCityFact;
      this.logger.log(`[extractFacts] 确认问答裁决入档: pref.city=${confirmedCityFact.value}`);
    }

    // sanitizer 命中且规则也没补上真名时，用 forceNullFields 显式覆盖
    // Redis 中可能已被早期漏网昵称污染的字段，避免 deepMerge "null 不覆盖" 留存旧值。
    // 形态门丢弃的 phone 还要显式清 Redis：下一轮 [已确认事实] 会把旧脏值再喂回抽取，
    // deepMerge "null 不覆盖" 会让丢弃只在本轮生效，脏号继续沿用。
    const nameStillNull =
      (droppedName || droppedDigitsName) && !unwrapSessionFactValue(newFacts.interview_info.name);
    const forceNullInterviewFields: (keyof EntityExtractionResult['interview_info'])[] = [];
    if (nameStillNull) forceNullInterviewFields.push('name');
    // 引用发言人名同理显式清 Redis：上一轮可能已把经理名写进档案（or9d6viv 实锤），
    // 仅本轮丢弃会被 deepMerge "null 不覆盖" 保留旧脏值。
    if (droppedQuotedSpeakerName && !forceNullInterviewFields.includes('name')) {
      forceNullInterviewFields.push('name');
    }
    if (droppedPhone) forceNullInterviewFields.push('phone');
    const persistedLaborForm = unwrapSessionFactValue(previousFacts?.preferences.labor_form);
    const laborFormExplicitlyCleared =
      currentLaborFormIntent.kind === 'clear' &&
      typeof persistedLaborForm === 'string' &&
      currentLaborFormIntent.clearedValues.some((value) => value === persistedLaborForm);
    // 脏城市与 phone 同理显式清 Redis：仅本轮丢弃会被 deepMerge "null 不覆盖" 抵消，
    // 存量脏值继续留在档案里，下一轮又被 [已确认事实] 喂回抽取，污染永不出清。
    const forceNullPreferenceFields: (keyof EntityExtractionResult['preferences'])[] = [];
    if (laborFormExplicitlyCleared) forceNullPreferenceFields.push('labor_form');
    // 必须看本轮末态而非丢弃那一刻：上方确认问答裁决可能在丢弃之后又写回一个合法城市
    // （丢弃把 city 清空，恰恰让那条裁决的"本轮已有高置信城市则让位"守卫放行）。
    // 只按 droppedCity 强清会把刚裁定的城市在合并后抹掉。
    if (droppedCity && !newFacts.preferences.city) forceNullPreferenceFields.push('city');
    // 品牌写入收口（§9.2 三处之一）：LLM 抽出的品牌不再直接落 preferences.brands——
    // 经品牌库验证 + 极性判定转成 BrandResolution 后，与其它来源一起走 brand_state reducer。
    const factsForSave: SessionFacts = {
      ...newFacts,
      preferences: { ...newFacts.preferences, brands: null },
    };
    await this.saveFacts(corpId, userId, sessionId, factsForSave, {
      forceNullFields: forceNullInterviewFields.length > 0 ? forceNullInterviewFields : undefined,
      forceNullPreferenceFields:
        forceNullPreferenceFields.length > 0 ? forceNullPreferenceFields : undefined,
    });

    return {
      llmDegraded,
      brandIntents: this.validateBrandIntents(
        rawBrandIntents,
        brandData,
        scopedMessages.filter((m) => m.role === 'assistant').map((m) => m.content),
      ),
    };
  }

  /**
   * LLM 极性轨输出验证（§6.3.1）：品牌名必须经品牌库标准化验证，未命中即整条丢弃，
   * 不允许 LLM 创造标准品牌；极性沿用 LLM 判断（指代链接后的品牌名同样过目录验证）。
   *
   * 2026-07-27 追加两道确定性输入闸（llm-intent-guards）：系统文本回流与助手话术
   * 回声整条丢弃——brand 字段被塞进整句时包含匹配仍能过目录验证，但说话人不是候选人
   * （2026-07-24 chat 6a633590 Agent 找店话术凭空立主品牌塔可贝尔）。
   */
  private validateBrandIntents(
    intents: BrandIntentEntry[],
    brandData: BrandItem[],
    assistantTexts: string[] = [],
  ): BrandResolution[] {
    const normalizedAssistantTexts = assistantTexts.map(normalizeForBrandMatch).filter(Boolean);
    const out: BrandResolution[] = [];
    for (const intent of intents) {
      const brand = intent.brand?.trim();
      if (!brand) {
        // 品牌为空只对排斥/不限有意义（"换个品牌"/"这个不考虑"链接失败时的裸排斥）
        if (intent.polarity === 'negative' || intent.polarity === 'browse_all') {
          out.push({
            canonicalName: null,
            brandId: null,
            matchedText: null,
            // 裸排斥来自 LLM 结构化意图而非文本命中，没有可归因的原文片段
            sourceText: null,
            source: 'user_text',
            matchType: null,
            intentPolarity: intent.polarity,
            confidence: 0.9,
            ambiguous: false,
          });
        }
        continue;
      }
      if (isSystemTextReflow(brand)) {
        this.logger.warn(`[extractFacts] LLM 品牌意图为系统文本回流，整条丢弃：「${brand}」`);
        continue;
      }
      const resolutions = resolveBrands(brand, 'user_text', brandData).filter(
        (r) => !r.ambiguous && r.canonicalName !== null,
      );
      if (resolutions.length === 0) {
        this.logger.debug(`[extractFacts] LLM 品牌意图未过目录验证，整条丢弃：「${brand}」`);
        continue;
      }
      if (
        isAssistantEchoUtterance({
          normalizedBrandField: normalizeForBrandMatch(brand),
          normalizedMatchedTexts: resolutions.map((r) =>
            normalizeForBrandMatch(r.matchedText ?? ''),
          ),
          normalizedAssistantTexts,
        })
      ) {
        this.logger.warn(`[extractFacts] LLM 品牌意图为助手话术回声，整条丢弃：「${brand}」`);
        continue;
      }
      for (const resolution of resolutions) {
        out.push({ ...resolution, intentPolarity: intent.polarity });
      }
    }
    return out;
  }

  private async callLLM(prompt: string): Promise<{
    facts: EntityExtractionResult;
    explicitProvenance: ExplicitProvenanceEntry[];
    brandIntents: BrandIntentEntry[];
    /** true = LLM 调用或 schema 解析失败，已降级为空提取（本轮新事实丢失，旧值不受影响）。 */
    degraded: boolean;
  }> {
    try {
      const result = await this.llm.generateStructured({
        role: ModelRole.Extract,
        modelId: await this.systemConfig.getExtractModelOverride(),
        // LLM 输出使用简单 schema（city 为 string），避免 Zod union/transform 产生
        // 的复杂 JSON schema 让 LLM 误解结构；service 层再归一化为 CityFact。
        schema: LLMEntityExtractionResultSchema,
        outputName: 'WeworkCandidateFacts',
        system: SESSION_EXTRACTION_SYSTEM_PROMPT,
        prompt,
        // 示例回声防线：弱模型会把提示词示例值（占位手机号等）当默认值填进输出
        //（badcase 2026-07-22 张三/13800138000 假身份成单）。命中即判本次生成
        // 失败，走与 API 错误相同的重试/降级，绝不让占位身份落进事实层。
        // 身份出处门（badcase 2026-07-24 赵堤/18833669895 新造身份穿透示例名单）：
        // name/phone 必须能在提取 prompt（消息窗口 + 已确认事实 + 图片描述）里找到，
        // 找不到即臆造，同样判本次生成失败。
        validateOutput: (output) => {
          assertNoExtractionExampleEcho(output);
          assertExtractionIdentityProvenance(output, prompt);
        },
      });

      // explicit_provenance / brand_intents 不属于存储态 schema，归一化前单独取出。
      const rawOutput = result.output as { explicit_provenance?: unknown; brand_intents?: unknown };
      const provenanceParse = z
        .array(ExplicitProvenanceEntrySchema)
        .nullable()
        .optional()
        .safeParse(rawOutput?.explicit_provenance);
      const explicitProvenance = provenanceParse.success ? (provenanceParse.data ?? []) : [];
      const brandIntentsParse = z
        .array(BrandIntentEntrySchema)
        .nullable()
        .optional()
        .safeParse(rawOutput?.brand_intents);
      const brandIntents = brandIntentsParse.success ? (brandIntentsParse.data ?? []) : [];

      // 归一化：LLM 输出的 city 字符串经 EntityExtractionResultSchema 转为 CityFact 对象
      const parsed = EntityExtractionResultSchema.parse(result.output);
      return {
        facts: this.backfillCityFromWhitelist(parsed),
        explicitProvenance,
        brandIntents,
        degraded: false,
      };
    } catch (err) {
      // 降级影响：本轮新事实丢失（下一轮增量窗口可自然补回），旧 facts 经
      // deepMerge "null 不覆盖"不受影响。调用方据 degraded 标记把
      // post_processing_status 标成降级，使提取实际成功率可观测。
      this.logger.warn('[extractFacts] LLM extraction failed, using fallback', err);
      return {
        facts: FALLBACK_EXTRACTION,
        explicitProvenance: [],
        brandIntents: [],
        degraded: true,
      };
    }
  }

  /**
   * 候选人明确提供的字段，置信度可由 LLM 来源声明升级到 high 的白名单。
   *
   * 刻意排除：
   * - name：报名真名校验红线，升级通道仍只走规则的结构化姓名识别；
   * - applied_store / applied_position / interview_time：事务字段升 high 后，
   *   候选人改约时新一轮 medium 提取会被置信度守卫拒绝覆盖，反而制造新 bug。
   */
  private static readonly EXPLICIT_UPGRADE_FIELDS = new Set([
    'phone',
    'gender',
    'age',
    'education',
    'has_health_certificate',
    'experience',
    'height',
    'weight',
    'is_student',
    'household_register_province',
  ]);

  /**
   * 按 LLM 的来源声明升级置信度：candidate_explicit（表单回填/直接自陈）→ high/candidate。
   *
   * 背景：LLM 提取整组统一打 medium，候选人在收资表单明确回填的字段（仅因规则正则
   * 没接住）也被一刀切成 medium，工具预填（只信 high）拿不到 → 重复收资。
   * 防 LLM 高报：声明必须附逐字 quote，且 quote 能在候选人消息原文中找到才生效；
   * phone 额外做手机号格式校验。
   */
  private applyExplicitProvenanceUpgrade(
    facts: SessionFacts,
    provenance: ExplicitProvenanceEntry[],
    userMessages: string[],
  ): SessionFacts {
    if (provenance.length === 0) return facts;

    const result: SessionFacts = {
      ...facts,
      interview_info: { ...facts.interview_info },
    };
    const target = result.interview_info as unknown as Record<string, unknown>;

    for (const entry of provenance) {
      // 容忍 "interview_info.phone" 与 "phone" 两种写法
      const field = entry.field.includes('.') ? entry.field.split('.').pop()! : entry.field;
      if (!SessionService.EXPLICIT_UPGRADE_FIELDS.has(field)) continue;

      const quote = entry.quote?.trim();
      if (!quote || quote.length < 2) continue;
      // 裁决 B3：phone 的升级 quote 只认候选人手打文本——证件/简历图描述里的号码
      // quote 不得作为升 high 依据（medium 锁定，须经确认问答升级）。其余字段照旧。
      const quoteCorpus =
        field === 'phone'
          ? userMessages
              .filter((message) => !isVisualDescriptionText(stripTimeContextSuffix(message).trim()))
              .map((message) => stripQuotedBlocks(message))
          : userMessages;
      if (!quoteCorpus.some((message) => message.includes(quote))) {
        this.logger.debug(
          `[extractFacts] explicit_provenance quote 未在候选人消息中找到，拒绝升级 ${field}`,
        );
        continue;
      }

      const current = target[field];
      if (!isSessionFactValue(current)) continue;
      if (sessionFactConfidenceRank(current.confidence) >= sessionFactConfidenceRank('high')) {
        continue;
      }
      if (field === 'phone' && !/^1\d{10}$/.test(String(current.value))) continue;

      const meta = {
        confidence: 'high' as const,
        source: 'candidate' as const,
        evidence: truncateEvidence(`候选人明确提供："${quote}"`),
        extractedAt: new Date().toISOString(),
      };
      target[field] = { ...current, ...meta };
      if (field === 'gender') {
        target.gender_source = sessionFactValue('candidate' as const, meta);
      }
      this.logger.log(
        `[extractFacts] 来源声明升级：${field} medium→high（候选人明确提供，quote 已验证）`,
      );
    }

    return result;
  }

  private ensureSessionFacts(facts: EntityExtractionResult | SessionFacts): SessionFacts {
    return SessionFactsSchema.parse(facts) as SessionFacts;
  }

  /**
   * 本轮候选人定位分享 → 逆地理编码 → 城市事实（A2）。
   *
   * 只扫当前 user 消息块（尾部连续 user 段）；坐标解析（含引用块剥离、多条取最新）
   * 收拢在 parseLocationShareCoords（preparation 轮内锚点与本方法共用同一份约定）。
   * 逆解失败/服务缺失静默跳过。
   */
  private async buildLocationShareCityFact(
    currentTurnUserTexts: readonly string[],
    existingCity: SessionFacts['preferences']['city'],
  ): Promise<SessionFactValue<string> | null> {
    if (!this.geocoding) return null;
    if (existingCity && existingCity.confidence === 'high') return null;

    const coords = parseLocationShareCoords(currentTurnUserTexts);
    if (!coords) return null;

    const regeo = await this.geocoding.reverseGeocode(coords.longitude, coords.latitude);
    if (!regeo?.city?.trim()) return null;
    const city = regeo.city.trim().replace(/市$/, '');
    if (!city) return null;

    this.logger.log(`[extractFacts] 定位分享逆解析城市入档: ${city}（source=tool）`);
    return {
      value: city,
      confidence: 'high',
      source: 'tool',
      evidence: truncateEvidence(
        `定位分享逆解析：${regeo.formattedAddress || `${regeo.province}${regeo.city}${regeo.district}`}`,
      ),
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * 纯应答词判定：整条消息（去时间后缀）由 1-3 个应答/寒暄词 + 标点构成。
   * 用白名单而非长度判断，避免把"好的约明天"这类短但有信息的消息误判。
   */
  private isPureAcknowledgment(text: string): boolean {
    if (!text) return false;
    if (text.length > SessionService.MAX_ACK_TEXT_LENGTH) return false;
    const ackWord =
      '(?:好的|好滴|好嘞|好呀|好|嗯+|嗯呢|可以|行|没事|没问题|是的|对的|对|ok|okk|👌|收到|知道了|明白了?|了解|谢谢你?|谢了|麻烦了|辛苦了|在吗|在不在|你好|您好|哦+|噢|嗷|哈+)';
    const pattern = new RegExp(`^(?:${ackWord}[~～。.!！?？，,、\\s]*){1,3}$`, 'i');
    return pattern.test(text);
  }

  private buildLlmFactEvidence(reasoning: string | null | undefined): string {
    const trimmed = reasoning?.trim();
    // evidence 只服务排障，入库前截断；reasoning 全文曾把每个字段的 evidence 撑到
    // 600+ 字并经沉淀永久污染长期画像、重复注入 prompt。
    return trimmed ? truncateEvidence(`LLM 结构化提取：${trimmed}`) : 'LLM 结构化提取';
  }

  /**
   * 把对话裁剪到"当前会话段"：从最后一条消息往回扫，相邻消息时间差 ≥ settlementGap
   * 即视为旧会话边界并截断（与 SettlementService 的断层语义一致）。
   *
   * 时间戳从消息内容的 `[消息发送时间：…]` 后缀解析（短期记忆注入，见
   * MessageParser.injectTimeContext）；无法解析的消息保守视为同一会话。
   */
  private trimToCurrentSessionSegment<T extends { content: string }>(messages: T[]): T[] {
    const gapMs = this.config.settlementGapSeconds * 1000;
    let laterTs: number | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const ts = this.parseMessageSentAt(messages[i].content);
      if (ts === null) continue;
      if (laterTs !== null && laterTs - ts >= gapMs) {
        return messages.slice(i + 1);
      }
      laterTs = ts;
    }
    return messages;
  }

  /** 解析 `[消息发送时间：2026-06-03 12:11 星期三]` 后缀（北京时间）为毫秒时间戳。 */
  private parseMessageSentAt(content: string): number | null {
    const match = /\[消息发送时间：(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(content);
    if (!match) return null;
    const parsed = Date.parse(
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * 同轮 rule × LLM 统一合并。
   *
   * 一次遍历对每个字段决定胜者值与最终元数据：
   * - 标量：通常由 LLM 非空值优先、rule 在 LLM 空时补位。健康证是有限枚举且
   *   直接控制约面资格，因此当前轮确定性 rule 命中时由 rule 覆盖 LLM，避免模型把
   *   “愿意/拒绝办理”压缩回含义不完整的“无”。
   * - 数组（brands/position/district/location/time_windows）：LLM 与 rule 累积去重。
   * - 元数据：rule 该字段高置信有值，且 LLM 无值（rule 补位）或与 rule 同值（二者一致）时，
   *   最终元数据采用 rule（high/rule）；否则保留 LLM（medium/llm）。即「先值合并，
   *   再用规则高置信值重打元数据」。
   *
   * gender/gender_source（联动）、schedule_constraint（逐子字段 ?? 合并）、city
   * （CityFact 值合并 + 经 toSessionFacts 的 derived/CityFact 归一化）行为难以套进
   * 统一标量/数组形态，保留为下方手写分支；它们仍共用同一套「rule 元数据归属」判定。
   *
   * reasoning：追加规则参考线索，并作为 LLM 取胜字段的 evidence。
   */
  private mergeRuleAndLlmFacts(
    llmFacts: EntityExtractionResult,
    ruleFacts: HighConfidenceFacts | null,
  ): SessionFacts {
    if (!ruleFacts) {
      return toSessionFacts(llmFacts, {
        confidence: 'medium',
        source: 'llm',
        evidence: this.buildLlmFactEvidence(llmFacts.reasoning),
        extractedAt: new Date().toISOString(),
      });
    }

    const merged: EntityExtractionResult = {
      ...llmFacts,
      interview_info: { ...llmFacts.interview_info },
      preferences: { ...llmFacts.preferences },
    };
    const infoMerge = merged.interview_info as unknown as Record<string, unknown>;
    const prefMerge = merged.preferences as unknown as Record<string, unknown>;
    const ruleInfo = ruleFacts.interview_info as unknown as Record<
      string,
      HighConfidenceValue<unknown> | null
    >;
    const rulePref = ruleFacts.preferences as unknown as Record<
      string,
      HighConfidenceValue<unknown> | null
    >;

    // 收集最终应采用 rule 高置信元数据的字段：`{group}.{field}` → rule 事实。
    const ruleMetaFields = new Map<string, HighConfidenceValue<unknown>>();
    const noteRuleMeta = (
      groupKey: 'interview_info' | 'preferences',
      field: string,
      ruleFact: HighConfidenceValue<unknown> | null,
      currentValue: unknown,
    ): void => {
      if (ruleFact && shouldAdoptRuleMeta(currentValue, ruleFact.value)) {
        ruleMetaFields.set(`${groupKey}.${field}`, ruleFact);
      }
    };

    // ── 标量字段：通常 LLM 非空优先，rule 补位；健康证确定性枚举由 rule 优先 ──
    for (const [groupKey, target, ruleGroup] of [
      ['interview_info', infoMerge, ruleInfo],
      ['preferences', prefMerge, rulePref],
    ] as const) {
      const fields =
        groupKey === 'interview_info'
          ? SessionService.SCALAR_INFO_FIELDS
          : SessionService.SCALAR_PREF_FIELDS;
      for (const field of fields) {
        const ruleFact = ruleGroup[field];
        const shouldRuleOverride =
          groupKey === 'interview_info' &&
          field === 'has_health_certificate' &&
          ruleFact &&
          hasMeaningfulValue(ruleFact.value);
        if (
          shouldRuleOverride ||
          (!hasMeaningfulValue(target[field]) && ruleFact && hasMeaningfulValue(ruleFact.value))
        ) {
          target[field] = ruleFact.value;
        }
        noteRuleMeta(groupKey, field, ruleFact, target[field]);
      }
    }

    // ── 数组字段：LLM 与 rule 累积去重 ──
    for (const field of SessionService.ARRAY_PREF_FIELDS) {
      const ruleFact = rulePref[field];
      const mergedArray = mergeNullableStringArrays(
        prefMerge[field] as string[] | null,
        ruleFact && hasMeaningfulValue(ruleFact.value) ? (ruleFact.value as string[]) : null,
      );
      prefMerge[field] = mergedArray;
      noteRuleMeta('preferences', field, ruleFact, mergedArray);
    }

    // ── gender + gender_source：联动补位（注册表单字段模型表达不了） ──
    const ruleGender = ruleInfo.gender;
    if (!merged.interview_info.gender && ruleGender && hasMeaningfulValue(ruleGender.value)) {
      merged.interview_info.gender = ruleGender.value as string;
      merged.interview_info.gender_source =
        (ruleInfo.gender_source?.value as 'candidate' | 'system' | undefined) ??
        merged.interview_info.gender_source;
    }
    noteRuleMeta('interview_info', 'gender', ruleGender, merged.interview_info.gender);
    noteRuleMeta(
      'interview_info',
      'gender_source',
      ruleInfo.gender_source,
      merged.interview_info.gender_source,
    );

    // ── schedule_constraint：逐子字段 ?? 合并（LLM 优先，rule 补缺） ──
    const ruleConstraint = rulePref.schedule_constraint;
    if (ruleConstraint && ruleConstraint.value) {
      const r = ruleConstraint.value as ScheduleConstraintFact;
      const llmConstraint = merged.preferences.schedule_constraint;
      merged.preferences.schedule_constraint = {
        onlyWeekends: llmConstraint?.onlyWeekends ?? r.onlyWeekends ?? null,
        onlyEvenings: llmConstraint?.onlyEvenings ?? r.onlyEvenings ?? null,
        onlyMornings: llmConstraint?.onlyMornings ?? r.onlyMornings ?? null,
        maxDaysPerWeek: llmConstraint?.maxDaysPerWeek ?? r.maxDaysPerWeek ?? null,
      };
    }
    noteRuleMeta(
      'preferences',
      'schedule_constraint',
      ruleConstraint,
      merged.preferences.schedule_constraint,
    );

    // ── city：CityFact 值合并（LLM 空时 rule 补位），元数据按 city 字符串比较 ──
    const ruleCity = rulePref.city;
    if (!merged.preferences.city && ruleCity && hasMeaningfulValue(ruleCity.value)) {
      merged.preferences.city = unwrapHighConfidenceFacts(ruleFacts)?.preferences.city ?? null;
    }
    noteRuleMeta('preferences', 'city', ruleCity, merged.preferences.city?.value ?? null);

    // reasoning：追加规则参考线索（同时作为 LLM 取胜字段的 evidence）。
    const ruleReasoning = ruleFacts.reasoning?.trim();
    if (ruleReasoning) {
      merged.reasoning = [merged.reasoning?.trim(), `规则模式匹配参考线索：\n${ruleReasoning}`]
        .filter(Boolean)
        .join('\n');
    }

    // 先整体打 medium/llm，再把 rule 取胜字段重打 high/rule。
    const sessionFacts = toSessionFacts(merged, {
      confidence: 'medium',
      source: 'llm',
      evidence: this.buildLlmFactEvidence(merged.reasoning),
      extractedAt: new Date().toISOString(),
    });
    return this.stampRuleMetadata(sessionFacts, ruleMetaFields);
  }

  /** interview_info 下走「先到先得」标量合并的字段（gender/gender_source 因联动单列）。 */
  private static readonly SCALAR_INFO_FIELDS: readonly string[] = [
    'name',
    'phone',
    'age',
    'applied_store',
    'applied_position',
    'interview_time',
    'is_student',
    'education',
    'has_health_certificate',
    'experience',
    'upload_resume',
    'height',
    'weight',
    'household_register_province',
  ];

  /** preferences 下走「先到先得」标量合并的字段（city/schedule_constraint 单列）。 */
  private static readonly SCALAR_PREF_FIELDS: readonly string[] = [
    'salary',
    'schedule',
    'labor_form',
    'delayed_intent',
    'short_term',
    'open_position',
    'available_after',
  ];

  /** preferences 下走「累积去重」数组合并的字段（brands 已收口到 brand_state，不再参与并集）。 */
  private static readonly ARRAY_PREF_FIELDS: readonly string[] = [
    'position',
    'district',
    'location',
    'time_windows',
  ];

  /** 把 ruleMetaFields 列出的字段从 medium/llm 重打为 rule 的 high/rule 元数据。 */
  private stampRuleMetadata(
    sessionFacts: SessionFacts,
    ruleMetaFields: Map<string, HighConfidenceValue<unknown>>,
  ): SessionFacts {
    if (ruleMetaFields.size === 0) return sessionFacts;

    const result: SessionFacts = {
      ...sessionFacts,
      interview_info: { ...sessionFacts.interview_info },
      preferences: { ...sessionFacts.preferences },
    };
    const groups: Record<string, Record<string, unknown>> = {
      interview_info: result.interview_info as unknown as Record<string, unknown>,
      preferences: result.preferences as unknown as Record<string, unknown>,
    };

    for (const [path, ruleFact] of ruleMetaFields) {
      const [groupKey, field] = path.split('.');
      const target = groups[groupKey];
      const current = unwrapSessionFactValue(
        target[field] as SessionFactValue<unknown> | unknown | null,
      );
      // 防御：medium/llm 重打前再校验一次值未被偏移（与旧 applyHighConfidenceField 一致）。
      if (!hasMeaningfulValue(ruleFact.value)) continue;
      if (hasMeaningfulValue(current) && !isSameFactValue(current, ruleFact.value)) continue;

      target[field] = sessionFactValue(ruleFact.value, {
        confidence: ruleFact.confidence,
        source: ruleFact.source,
        evidence: truncateEvidence(ruleFact.evidence),
        extractedAt: new Date().toISOString(),
      });
    }

    return result;
  }

  /**
   * LLM 按 session-extraction prompt 对"单独的区/镇/街道"留 null city（防跨城同名）。
   * 但 UNIQUE_SUBDIVISION_TO_CITY / UNIQUE_PLACE_ALIAS_TO_CITY 白名单恰好已经把跨城同名排除，剩下的
   * （青浦/浦东/朝阳/海淀…）应当无歧义补出。此处用确定性兜底覆盖 LLM 的保守留空，
   * 避免"高置信明明能识别，sessionFacts 却 city=null"的尴尬（badcase: 候选人多轮
   * 反复说"青浦区/金泽"，Agent 仍被硬约束卡在"当前没有已确认城市"循环里反问）。
   */
  private backfillCityFromWhitelist(facts: EntityExtractionResult): EntityExtractionResult {
    // 非空但不是合法城市名时不算"已有城市"——否则一个 `hello` 就能把白名单回填
    // 冻结整轮，本轮 district/location 里的真实城市线索白白丢掉（形状门要到本轮
    // 末尾才把脏值清掉，那时回填时机已过）。
    if (facts.preferences.city && isRecognizedCityName(facts.preferences.city.value)) {
      return facts;
    }
    // 冲突 shadow（方案 §8.2 / Phase 3）：多信号指向不同城市时现行先命中先赢；
    // 落库观测走岗位工具 queryMeta.geoSignalConflictShadow，这里仅辅助定位。
    //
    // 不传 knownCity：本方法在 L1 已对 facts.preferences.city 非空早返回，走到这里
    // city 必为空，已知城市裁决在此天然无从谈起。这也意味着 enforce（本方法是其落点）
    // 无法靠"已知城市裁决"降低误伤面——真正的防线是脏别名清表
    // （DIRTY_ALIAS_EXCLUSIONS + geo:validate 检查项 8），见方案 §17.4.1。
    const conflictShadow = detectGeoSignalConflict(
      facts.preferences.district,
      facts.preferences.location,
    );
    if (conflictShadow) {
      this.logger.warn(
        `[extractFacts] 地理信号冲突（shadow，行为不变仍先命中先赢）: ${JSON.stringify(conflictShadow)}`,
      );
    }
    const resolved = resolveCityFromGeoSignals(
      facts.preferences.district,
      facts.preferences.location,
    );
    if (!resolved) return facts;
    this.logger.debug(
      `[extractFacts] 白名单回填 city=${resolved.value}（evidence: ${resolved.evidence}）`,
    );
    return {
      ...facts,
      preferences: {
        ...facts.preferences,
        city: { value: resolved.value, confidence: 'high', evidence: resolved.evidence },
      },
    };
  }

  /** 旧版单 blob key（只读 + 迁移删除，禁止新写入）。 */
  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `facts:${corpId}:${userId}:${sessionId}`;
  }

  /** hash 形态的 session state key（所有写入的唯一目标）。 */
  private buildHashKey(corpId: string, userId: string, sessionId: string): string {
    return `factsv2:${corpId}:${userId}:${sessionId}`;
  }

  private serializeStateContent(content: Partial<WeworkSessionState>): Partial<WeworkSessionState> {
    return SessionFactsRedisContentSchema.parse(content) as Partial<WeworkSessionState>;
  }
}
