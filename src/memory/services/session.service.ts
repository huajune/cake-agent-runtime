import { Injectable, Logger } from '@nestjs/common';
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
} from '../types/session-facts.types';
import type {
  AuthoritativeSessionState,
  CollectedField,
  FieldProvenance,
} from '../types/authoritative-session-state.types';
import { parseCandidateFieldsFromText } from '@tools/shared/candidate-field-parser';
import { MessageParser } from '@channels/wecom/message/utils/message-parser.util';
import {
  buildSessionExtractionPrompt,
  SESSION_EXTRACTION_SYSTEM_PROMPT,
} from './session-extraction.prompt';
import {
  detectBrandAliasHints,
  extractHighConfidenceFacts,
  filterHighConfidenceFacts,
  unwrapHighConfidenceFacts,
} from '../facts/high-confidence-facts';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import type { BrandItem } from '@/sponge/sponge.types';
import { resolveCityFromGeoSignals } from '../facts/geo-mappings';
import { decideLaborFormIntent } from '../facts/labor-form';
import { sanitizeInterviewName } from '../facts/name-guard';
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

    return this.applyBrandProjection({
      ...EMPTY_SESSION_STATE,
      ...content,
      lastCandidatePool: content.lastCandidatePool ?? null,
      presentedJobs: content.presentedJobs ?? null,
      currentFocusJob: content.currentFocusJob ?? null,
    });
  }

  /**
   * preferences.brands 只读投影（§9.2 过渡期）：brand_state 存在时由其现算
   * （派生口径 = currentBrand 单元素数组，空状态为空数组→null），旧存储值不可见；
   * brand_state 不存在时保留旧数组原值——它是懒迁移（§9.4）的初始化数据源。
   * 禁止任何路径直接写入该字段（写入点已全部收口到 brand_state reducer）。
   */
  private applyBrandProjection(state: WeworkSessionState): WeworkSessionState {
    const brandState = state.brand_state;
    if (!brandState || !state.facts) return state;

    const projected = brandState.currentBrand
      ? sessionFactValue([brandState.currentBrand.canonicalName], {
          confidence: 'high',
          source: 'system',
          evidence: '会话品牌状态投影（currentBrand）',
          extractedAt: new Date().toISOString(),
        })
      : null;

    return {
      ...state,
      facts: {
        ...state.facts,
        preferences: { ...state.facts.preferences, brands: projected },
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
   * Profile 层（Supabase RPC）有 "high 不被非 high 覆盖" 守卫，session 层此前没有——
   * 这里补齐同等语义：新值置信度严格低于旧值时，保留旧值整体（含元数据）。
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

    return {
      collectedFields,
      recalledJobIds,
      hardConstraints: [],
      presentedStores: (state.presentedJobs ?? []).map((job) => ({ jobId: job.jobId })),
      stage: null,
      terminal: state.terminal ?? undefined,
      lastCandidateMessageAt: Number.isFinite(lastCandidateMessageAt)
        ? lastCandidateMessageAt
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
    if (previousFacts && this.isPureAcknowledgment(lastUserText)) {
      const currentTurnRuleHits = extractHighConfidenceFacts([lastUserText], brandData);
      if (!currentTurnRuleHits) {
        this.logger.log(`[extractFacts] 纯应答轮无新信号，跳过 LLM 提取：「${lastUserText}」`);
        return { llmDegraded: false, brandIntents: [] };
      }
    }

    const aliasHints = detectBrandAliasHints(userMessages, brandData);
    const ruleFacts = extractHighConfidenceFacts(userMessages, brandData);
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
    // 先 sanitize LLM 输出，再 merge 规则 — 确保 LLM 昵称被 drop 后规则的结构化姓名能补位
    const { sanitized: sanitizedLlm, droppedName } = sanitizeInterviewName(llmRaw, userMessages);
    if (droppedName) {
      this.logger.log(
        `[extractFacts] 丢弃来自"我是xx"打招呼语的昵称"${droppedName}"，不写入 interview_info.name`,
      );
    }
    const newFacts = this.applyExplicitProvenanceUpgrade(
      this.mergeRuleAndLlmFacts(sanitizedLlm, highConfidenceRuleFacts),
      explicitProvenance,
      userMessages,
    );

    // sanitizer 命中且规则也没补上真名时，用 forceNullFields 显式覆盖
    // Redis 中可能已被早期漏网昵称污染的字段，避免 deepMerge "null 不覆盖" 留存旧值。
    const nameStillNull = droppedName && !unwrapSessionFactValue(newFacts.interview_info.name);
    const persistedLaborForm = unwrapSessionFactValue(previousFacts?.preferences.labor_form);
    const laborFormExplicitlyCleared =
      currentLaborFormIntent.kind === 'clear' &&
      typeof persistedLaborForm === 'string' &&
      currentLaborFormIntent.clearedValues.some((value) => value === persistedLaborForm);
    // 品牌写入收口（§9.2 三处之一）：LLM 抽出的品牌不再直接落 preferences.brands——
    // 经品牌库验证 + 极性判定转成 BrandResolution 后，与其它来源一起走 brand_state reducer。
    const factsForSave: SessionFacts = {
      ...newFacts,
      preferences: { ...newFacts.preferences, brands: null },
    };
    await this.saveFacts(corpId, userId, sessionId, factsForSave, {
      forceNullFields: nameStillNull ? ['name'] : undefined,
      forceNullPreferenceFields: laborFormExplicitlyCleared ? ['labor_form'] : undefined,
    });

    return {
      llmDegraded,
      brandIntents: this.validateBrandIntents(rawBrandIntents, brandData),
    };
  }

  /**
   * LLM 极性轨输出验证（§6.3.1）：品牌名必须经品牌库标准化验证，未命中即整条丢弃，
   * 不允许 LLM 创造标准品牌；极性沿用 LLM 判断（指代链接后的品牌名同样过目录验证）。
   */
  private validateBrandIntents(
    intents: BrandIntentEntry[],
    brandData: BrandItem[],
  ): BrandResolution[] {
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
            source: 'user_text',
            matchType: null,
            intentPolarity: intent.polarity,
            confidence: 0.9,
            ambiguous: false,
          });
        }
        continue;
      }
      const resolutions = resolveBrands(brand, 'user_text', brandData).filter(
        (r) => !r.ambiguous && r.canonicalName !== null,
      );
      if (resolutions.length === 0) {
        this.logger.debug(`[extractFacts] LLM 品牌意图未过目录验证，整条丢弃：「${brand}」`);
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
      if (!userMessages.some((message) => message.includes(quote))) {
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
   * 同轮 rule × LLM 统一合并（取代旧 [c] mergeHighConfidenceRuleFacts +
   * [d] applyHighConfidenceMetadata 的两次遍历）。
   *
   * 一次遍历对每个字段决定胜者值与最终元数据：
   * - 标量：LLM 非空优先取 LLM；LLM 空时 rule 补位（boolean 的「空」= null，
   *   故 LLM 给出 false 也算有值，与旧实现的 `=== null` 判定等价）。
   * - 数组（brands/position/district/location/time_windows）：LLM 与 rule 累积去重。
   * - 元数据：rule 该字段高置信有值，且 LLM 无值（rule 补位）或与 rule 同值（二者一致）时，
   *   最终元数据采用 rule（high/rule）；否则保留 LLM（medium/llm）。这是旧 [c]+[d]
   *   叠加后的实际语义（先值合并，再用规则高置信值重打元数据）。
   *
   * gender/gender_source（联动）、schedule_constraint（逐子字段 ?? 合并）、city
   * （CityFact 值合并 + 经 toSessionFacts 的 derived/CityFact 归一化）行为难以套进
   * 统一标量/数组形态，保留为下方手写分支；它们仍共用同一套「rule 元数据归属」判定。
   *
   * reasoning：追加规则参考线索，并作为 LLM 取胜字段的 evidence（与旧实现一致）。
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

    // ── 标量字段：LLM 非空优先，rule 补位 ──
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
        if (!hasMeaningfulValue(target[field]) && ruleFact && hasMeaningfulValue(ruleFact.value)) {
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
   * 但 DISTRICT_TO_CITY / LOCATION_TO_CITY 白名单恰好已经把跨城同名排除，剩下的
   * （青浦/浦东/朝阳/海淀…）应当无歧义补出。此处用确定性兜底覆盖 LLM 的保守留空，
   * 避免"高置信明明能识别，sessionFacts 却 city=null"的尴尬（badcase: 候选人多轮
   * 反复说"青浦区/金泽"，Agent 仍被硬约束卡在"当前没有已确认城市"循环里反问）。
   */
  private backfillCityFromWhitelist(facts: EntityExtractionResult): EntityExtractionResult {
    if (facts.preferences.city) return facts;
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
