import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { SpongeService } from '@/sponge/sponge.service';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import { deepMerge } from '../stores/deep-merge.util';
import {
  EntityExtractionResultSchema,
  LLMEntityExtractionResultSchema,
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type HighConfidenceValue,
  type RecommendedJobSummary,
  RecommendedJobSummarySchema,
  type InvitedGroupRecord,
  InvitedGroupRecordSchema,
  SessionFactsSchema,
  SessionFactsRedisContentSchema,
  type SessionFacts,
  type SessionFactValue,
  type WeworkSessionState,
  EMPTY_SESSION_STATE,
  FALLBACK_EXTRACTION,
  sessionFactValue,
  toSessionFacts,
  unwrapSessionFactValue,
} from '../types/session-facts.types';
import {
  buildSessionExtractionPrompt,
  SESSION_EXTRACTION_SYSTEM_PROMPT,
} from './session-extraction.prompt';
import {
  detectBrandAliasHints,
  extractHighConfidenceFacts,
  filterHighConfidenceFacts,
  mergeDetectedBrands,
  unwrapHighConfidenceFacts,
} from '../facts/high-confidence-facts';
import { resolveCityFromGeoSignals } from '../facts/geo-mappings';
import { sanitizeInterviewName } from '../facts/name-guard';
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

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
    private readonly llm: LlmExecutorService,
    private readonly sponge: SpongeService,
  ) {}

  // ==================== store ====================

  async getSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<WeworkSessionState> {
    // 这里统一返回完整的空态，避免调用方反复处理 null/undefined 的分支。
    const key = this.buildKey(corpId, userId, sessionId);
    const entry = await this.redisStore.get(key);
    if (!entry) return { ...EMPTY_SESSION_STATE };
    const parsed = SessionFactsRedisContentSchema.safeParse(entry.content ?? {});
    if (!parsed.success) {
      this.logger.warn(
        `[getSessionState] Invalid session facts entry ignored: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
      return { ...EMPTY_SESSION_STATE };
    }
    const content = parsed.data as Partial<WeworkSessionState>;

    return {
      ...EMPTY_SESSION_STATE,
      ...content,
      lastCandidatePool: content.lastCandidatePool ?? null,
      presentedJobs: content.presentedJobs ?? null,
      currentFocusJob: content.currentFocusJob ?? null,
    };
  }

  async clearSessionState(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    return await this.redisStore.del(this.buildKey(corpId, userId, sessionId));
  }

  async getFacts(corpId: string, userId: string, sessionId: string): Promise<SessionFacts | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.facts;
  }

  /**
   * 保存本轮提取的会话事实。
   *
   * 默认走 deepMerge（null/空串不覆盖旧值，保留历史积累）；但 `forceNullFields`
   * 列出的 `interview_info` 字段会在 merge 之后被显式覆盖为 null，用于让调用方
   * 把确定不该保留的旧值（如 sanitizer 识别出的昵称）从 Redis 中清掉。
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
    options?: { forceNullFields?: readonly (keyof EntityExtractionResult['interview_info'])[] },
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const sessionFacts = this.ensureSessionFacts(facts);
    const baseMerge = state.facts ? deepMerge(state.facts, sessionFacts) : sessionFacts;
    const forcedMerge = this.applyForceNullFields(
      baseMerge as SessionFacts,
      options?.forceNullFields,
    );
    const mergedFacts = SessionFactsSchema.parse(forcedMerge) as SessionFacts;

    await this.redisStore.set(
      key,
      this.serializeStateContent({ ...state, facts: mergedFacts }) as Record<string, unknown>,
      this.config.sessionTtl,
      false,
    );
  }

  private applyForceNullFields(
    facts: SessionFacts,
    forceNullFields?: readonly (keyof EntityExtractionResult['interview_info'])[],
  ): SessionFacts {
    if (!forceNullFields || forceNullFields.length === 0) return facts;
    // interview_info 的字段类型异构（string|null、boolean|null 等），
    // 用 Record 视图收敛成 null 赋值，避免逐字段命中具体联合类型的推导限制。
    const interview = { ...facts.interview_info } as Record<
      keyof SessionFacts['interview_info'],
      unknown
    >;
    for (const field of forceNullFields) {
      interview[field] = null;
    }
    return {
      ...facts,
      interview_info: interview as SessionFacts['interview_info'],
    };
  }

  async saveLastCandidatePool(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const validatedJobs = jobs.map(
      (job) => RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary,
    );

    await this.redisStore.set(
      key,
      this.serializeStateContent({ ...state, lastCandidatePool: validatedJobs }) as Record<
        string,
        unknown
      >,
      this.config.sessionTtl,
      false,
    );
  }

  async savePresentedJobs(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    if (jobs.length === 0) return;

    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const validatedJobs = jobs.map(
      (job) => RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary,
    );
    const merged = [...validatedJobs, ...(state.presentedJobs ?? [])].filter(
      (job, index, arr) => arr.findIndex((item) => item.jobId === job.jobId) === index,
    );

    await this.redisStore.set(
      key,
      this.serializeStateContent({ ...state, presentedJobs: merged.slice(0, 10) }) as Record<
        string,
        unknown
      >,
      this.config.sessionTtl,
      false,
    );
  }

  async saveCurrentFocusJob(
    corpId: string,
    userId: string,
    sessionId: string,
    job: RecommendedJobSummary | null,
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const validatedJob = job
      ? (RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary)
      : null;

    await this.redisStore.set(
      key,
      this.serializeStateContent({ ...state, currentFocusJob: validatedJob }) as Record<
        string,
        unknown
      >,
      this.config.sessionTtl,
      false,
    );
  }

  async saveInvitedGroup(
    corpId: string,
    userId: string,
    sessionId: string,
    record: InvitedGroupRecord,
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const validated = InvitedGroupRecordSchema.parse(record) as InvitedGroupRecord;
    const existing = state.invitedGroups ?? [];
    // 按群名去重
    const merged = [validated, ...existing].filter(
      (g, i, arr) => arr.findIndex((item) => item.groupName === g.groupName) === i,
    );

    await this.redisStore.set(
      key,
      this.serializeStateContent({ ...state, invitedGroups: merged }) as Record<string, unknown>,
      this.config.sessionTtl,
      false,
    );
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
  ): Promise<void> {
    // conversationHistory 是“本轮最后一条消息之前的历史”，
    // currentMessage 是“本轮最后一条消息”。
    // 这样做是为了让提取 prompt 明确区分“新信息”与“历史上下文”。
    const allHistory = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .filter((s) => s.trim().length > 0);

    if (allHistory.length === 0) return;

    const currentMessage = allHistory.at(-1) ?? '';
    const conversationHistory = allHistory.slice(0, -1);
    const userMessages = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .filter((content) => content.trim().length > 0);

    const previousFacts = await this.getFacts(corpId, userId, sessionId);
    // 事实提取每轮都会触发，但不是每轮都全量重算：
    // - 首次提取：使用当前短期窗口里的全部历史
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
        `processing ${processedCount}/${conversationHistory.length} history messages ` +
        `(token saving: ${savingPercent}%)`,
    );

    const brandData = await this.sponge.fetchBrandList();
    const aliasHints = detectBrandAliasHints(userMessages, brandData);
    const ruleFacts = extractHighConfidenceFacts(userMessages, brandData);
    const highConfidenceRuleFacts = filterHighConfidenceFacts(ruleFacts);
    const ruleFactValues = unwrapHighConfidenceFacts(highConfidenceRuleFacts);
    const prompt = buildSessionExtractionPrompt(
      brandData,
      currentMessage,
      messagesToProcess,
      aliasHints,
      ruleFacts,
    );
    const llmFacts = mergeDetectedBrands(await this.callLLM(prompt), aliasHints);
    // 先 sanitize LLM 输出，再 merge 规则 — 确保 LLM 昵称被 drop 后规则的结构化姓名能补位
    const { sanitized: sanitizedLlm, droppedName } = sanitizeInterviewName(llmFacts, userMessages);
    if (droppedName) {
      this.logger.log(
        `[extractFacts] 丢弃来自"我是xx"打招呼语的昵称"${droppedName}"，不写入 interview_info.name`,
      );
    }
    const mergedFactValues = this.mergeHighConfidenceRuleFacts(sanitizedLlm, ruleFactValues);
    const newFacts = this.applyHighConfidenceMetadata(
      toSessionFacts(mergedFactValues, {
        confidence: 'medium',
        source: 'llm',
        evidence: this.buildLlmFactEvidence(mergedFactValues.reasoning),
      }),
      highConfidenceRuleFacts,
    );

    // sanitizer 命中且规则也没补上真名时，用 forceNullFields 显式覆盖
    // Redis 中可能已被早期漏网昵称污染的字段，避免 deepMerge "null 不覆盖" 留存旧值。
    const nameStillNull = droppedName && !unwrapSessionFactValue(newFacts.interview_info.name);
    await this.saveFacts(corpId, userId, sessionId, newFacts, {
      forceNullFields: nameStillNull ? ['name'] : undefined,
    });
  }

  private async callLLM(prompt: string): Promise<EntityExtractionResult> {
    try {
      const result = await this.llm.generateStructured({
        role: ModelRole.Extract,
        // LLM 输出使用简单 schema（city 为 string），避免 Zod union/transform 产生
        // 的复杂 JSON schema 让 LLM 误解结构；service 层再归一化为 CityFact。
        schema: LLMEntityExtractionResultSchema,
        outputName: 'WeworkCandidateFacts',
        system: SESSION_EXTRACTION_SYSTEM_PROMPT,
        prompt,
      });

      // 归一化：LLM 输出的 city 字符串经 EntityExtractionResultSchema 转为 CityFact 对象
      const parsed = EntityExtractionResultSchema.parse(result.output);
      return this.backfillCityFromWhitelist(parsed);
    } catch (err) {
      this.logger.warn('[extractFacts] LLM extraction failed, using fallback', err);
      return FALLBACK_EXTRACTION;
    }
  }

  private ensureSessionFacts(facts: EntityExtractionResult | SessionFacts): SessionFacts {
    return SessionFactsSchema.parse(facts) as SessionFacts;
  }

  private buildLlmFactEvidence(reasoning: string | null | undefined): string {
    const trimmed = reasoning?.trim();
    return trimmed ? `LLM 结构化提取：${trimmed}` : 'LLM 结构化提取';
  }

  private applyHighConfidenceMetadata(
    sessionFacts: SessionFacts,
    ruleFacts: HighConfidenceFacts | null,
  ): SessionFacts {
    if (!ruleFacts) return sessionFacts;

    const result: SessionFacts = {
      ...sessionFacts,
      interview_info: { ...sessionFacts.interview_info },
      preferences: { ...sessionFacts.preferences },
    };
    const infoTarget = result.interview_info as unknown as Record<string, unknown>;
    const prefTarget = result.preferences as unknown as Record<string, unknown>;

    this.applyHighConfidenceField(infoTarget, 'name', ruleFacts.interview_info.name);
    this.applyHighConfidenceField(infoTarget, 'phone', ruleFacts.interview_info.phone);
    this.applyHighConfidenceField(infoTarget, 'gender', ruleFacts.interview_info.gender);
    this.applyHighConfidenceField(
      infoTarget,
      'gender_source',
      ruleFacts.interview_info.gender_source,
    );
    this.applyHighConfidenceField(infoTarget, 'age', ruleFacts.interview_info.age);
    this.applyHighConfidenceField(
      infoTarget,
      'applied_store',
      ruleFacts.interview_info.applied_store,
    );
    this.applyHighConfidenceField(
      infoTarget,
      'applied_position',
      ruleFacts.interview_info.applied_position,
    );
    this.applyHighConfidenceField(
      infoTarget,
      'interview_time',
      ruleFacts.interview_info.interview_time,
    );
    this.applyHighConfidenceField(infoTarget, 'is_student', ruleFacts.interview_info.is_student);
    this.applyHighConfidenceField(infoTarget, 'education', ruleFacts.interview_info.education);
    this.applyHighConfidenceField(
      infoTarget,
      'has_health_certificate',
      ruleFacts.interview_info.has_health_certificate,
    );

    this.applyHighConfidenceField(prefTarget, 'brands', ruleFacts.preferences.brands);
    this.applyHighConfidenceField(prefTarget, 'salary', ruleFacts.preferences.salary);
    this.applyHighConfidenceField(prefTarget, 'position', ruleFacts.preferences.position);
    this.applyHighConfidenceField(prefTarget, 'schedule', ruleFacts.preferences.schedule);
    this.applyHighConfidenceField(prefTarget, 'city', ruleFacts.preferences.city);
    this.applyHighConfidenceField(prefTarget, 'district', ruleFacts.preferences.district);
    this.applyHighConfidenceField(prefTarget, 'location', ruleFacts.preferences.location);
    this.applyHighConfidenceField(prefTarget, 'labor_form', ruleFacts.preferences.labor_form);
    this.applyHighConfidenceField(
      prefTarget,
      'delayed_intent',
      ruleFacts.preferences.delayed_intent,
    );
    this.applyHighConfidenceField(prefTarget, 'short_term', ruleFacts.preferences.short_term);
    this.applyHighConfidenceField(prefTarget, 'open_position', ruleFacts.preferences.open_position);
    this.applyHighConfidenceField(prefTarget, 'time_windows', ruleFacts.preferences.time_windows);
    this.applyHighConfidenceField(
      prefTarget,
      'schedule_constraint',
      ruleFacts.preferences.schedule_constraint,
    );
    this.applyHighConfidenceField(
      prefTarget,
      'available_after',
      ruleFacts.preferences.available_after,
    );

    return result;
  }

  private applyHighConfidenceField<T>(
    target: Record<string, unknown>,
    field: string,
    fact: HighConfidenceValue<T> | null,
  ): void {
    if (!fact || !this.hasMeaningfulValue(fact.value)) return;

    const currentValue = unwrapSessionFactValue(target[field] as SessionFactValue<T> | T | null);
    if (this.hasMeaningfulValue(currentValue) && !this.isSameFactValue(currentValue, fact.value)) {
      return;
    }

    target[field] = sessionFactValue(fact.value, {
      confidence: fact.confidence,
      source: fact.source,
      evidence: fact.evidence,
    });
  }

  private hasMeaningfulValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  private isSameFactValue(left: unknown, right: unknown): boolean {
    if (Array.isArray(left) && Array.isArray(right)) {
      const normalize = (values: unknown[]) =>
        values
          .map((value) => String(value).trim())
          .filter(Boolean)
          .sort();
      return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
    }
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).trim() === String(right).trim();
    }
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /**
   * 规则提取作为 LLM 的参考依据，已通过 prompt 注入。
   * 此处做兜底合并：LLM 输出为主，规则仅在 LLM 未提取到时补位。
   * 数组字段仍做累积合并（品牌别名归一化等规则独有的映射能力）。
   */
  private mergeHighConfidenceRuleFacts(
    llmFacts: EntityExtractionResult,
    ruleFacts: EntityExtractionResult | null,
  ): EntityExtractionResult {
    if (!ruleFacts) return llmFacts;

    const merged: EntityExtractionResult = {
      ...llmFacts,
      interview_info: { ...llmFacts.interview_info },
      preferences: { ...llmFacts.preferences },
    };

    const ruleInfo = ruleFacts.interview_info;
    if (!merged.interview_info.name && ruleInfo.name) merged.interview_info.name = ruleInfo.name;
    if (!merged.interview_info.phone && ruleInfo.phone)
      merged.interview_info.phone = ruleInfo.phone;
    if (!merged.interview_info.gender && ruleInfo.gender) {
      merged.interview_info.gender = ruleInfo.gender;
      merged.interview_info.gender_source =
        ruleInfo.gender_source ?? merged.interview_info.gender_source;
    }
    if (!merged.interview_info.age && ruleInfo.age) merged.interview_info.age = ruleInfo.age;
    if (!merged.interview_info.applied_store && ruleInfo.applied_store)
      merged.interview_info.applied_store = ruleInfo.applied_store;
    if (!merged.interview_info.applied_position && ruleInfo.applied_position)
      merged.interview_info.applied_position = ruleInfo.applied_position;
    if (!merged.interview_info.interview_time && ruleInfo.interview_time)
      merged.interview_info.interview_time = ruleInfo.interview_time;
    if (merged.interview_info.is_student === null && ruleInfo.is_student !== null)
      merged.interview_info.is_student = ruleInfo.is_student;
    if (!merged.interview_info.education && ruleInfo.education)
      merged.interview_info.education = ruleInfo.education;
    if (!merged.interview_info.has_health_certificate && ruleInfo.has_health_certificate) {
      merged.interview_info.has_health_certificate = ruleInfo.has_health_certificate;
    }

    const rulePrefs = ruleFacts.preferences;
    merged.preferences.brands = this.mergeNullableStringArrays(
      merged.preferences.brands,
      rulePrefs.brands,
    );
    if (!merged.preferences.salary && rulePrefs.salary)
      merged.preferences.salary = rulePrefs.salary;
    merged.preferences.position = this.mergeNullableStringArrays(
      merged.preferences.position,
      rulePrefs.position,
    );
    if (!merged.preferences.schedule && rulePrefs.schedule)
      merged.preferences.schedule = rulePrefs.schedule;
    if (!merged.preferences.city && rulePrefs.city) merged.preferences.city = rulePrefs.city;
    merged.preferences.district = this.mergeNullableStringArrays(
      merged.preferences.district,
      rulePrefs.district,
    );
    merged.preferences.location = this.mergeNullableStringArrays(
      merged.preferences.location,
      rulePrefs.location,
    );
    if (!merged.preferences.labor_form && rulePrefs.labor_form)
      merged.preferences.labor_form = rulePrefs.labor_form;
    if (!merged.preferences.delayed_intent && rulePrefs.delayed_intent)
      merged.preferences.delayed_intent = rulePrefs.delayed_intent;
    if (merged.preferences.short_term === null && rulePrefs.short_term !== null)
      merged.preferences.short_term = rulePrefs.short_term;
    if (merged.preferences.open_position === null && rulePrefs.open_position !== null)
      merged.preferences.open_position = rulePrefs.open_position;
    merged.preferences.time_windows = this.mergeNullableStringArrays(
      merged.preferences.time_windows,
      rulePrefs.time_windows,
    );
    if (rulePrefs.schedule_constraint) {
      const llmConstraint = merged.preferences.schedule_constraint;
      merged.preferences.schedule_constraint = {
        onlyWeekends:
          llmConstraint?.onlyWeekends ?? rulePrefs.schedule_constraint.onlyWeekends ?? null,
        onlyEvenings:
          llmConstraint?.onlyEvenings ?? rulePrefs.schedule_constraint.onlyEvenings ?? null,
        onlyMornings:
          llmConstraint?.onlyMornings ?? rulePrefs.schedule_constraint.onlyMornings ?? null,
        maxDaysPerWeek:
          llmConstraint?.maxDaysPerWeek ?? rulePrefs.schedule_constraint.maxDaysPerWeek ?? null,
      };
    }
    if (!merged.preferences.available_after && rulePrefs.available_after)
      merged.preferences.available_after = rulePrefs.available_after;

    const ruleReasoning = ruleFacts.reasoning?.trim();
    if (ruleReasoning) {
      merged.reasoning = [merged.reasoning?.trim(), `规则模式匹配参考线索：\n${ruleReasoning}`]
        .filter(Boolean)
        .join('\n');
    }

    return merged;
  }

  private mergeNullableStringArrays(
    first: string[] | null | undefined,
    second: string[] | null | undefined,
  ): string[] | null {
    const merged = Array.from(new Set([...(first ?? []), ...(second ?? [])]));
    return merged.length > 0 ? merged : null;
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

  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `facts:${corpId}:${userId}:${sessionId}`;
  }

  private serializeStateContent(content: Partial<WeworkSessionState>): Partial<WeworkSessionState> {
    return SessionFactsRedisContentSchema.parse(content) as Partial<WeworkSessionState>;
  }
}
