import { Injectable, Logger } from '@nestjs/common';
import { generateText, Output } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@providers/types';
import { SpongeService } from '@/sponge/sponge.service';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import { deepMerge } from '../stores/deep-merge.util';
import {
  EntityExtractionResultSchema,
  type EntityExtractionResult,
  type RecommendedJobSummary,
  RecommendedJobSummarySchema,
  SessionFactsRedisContentSchema,
  type WeworkSessionState,
  EMPTY_SESSION_STATE,
  FALLBACK_EXTRACTION,
} from '../types/session-facts.types';
import {
  buildSessionExtractionPrompt,
  SESSION_EXTRACTION_SYSTEM_PROMPT,
} from './session-extraction.prompt';
import { detectBrandAliasHints, mergeDetectedBrands } from './high-confidence-facts';
import { extractPresentedJobs, resolveCurrentFocusJob } from './session-job-matching';

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
    private readonly router: RouterService,
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

  async getFacts(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<EntityExtractionResult | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.facts;
  }

  async getLastSessionActiveAt(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<string | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.lastSessionActiveAt ?? null;
  }

  async saveFacts(
    corpId: string,
    userId: string,
    sessionId: string,
    facts: EntityExtractionResult,
  ): Promise<void> {
    const key = this.buildKey(corpId, userId, sessionId);
    const state = await this.getSessionState(corpId, userId, sessionId);
    const mergedFacts = EntityExtractionResultSchema.parse(
      state.facts ? deepMerge(state.facts, facts) : facts,
    );

    await this.redisStore.set(
      key,
      this.serializeStateContent({ ...state, facts: mergedFacts }) as Record<string, unknown>,
      this.config.sessionTtl,
      false,
    );
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

  async storeActivity(
    corpId: string,
    userId: string,
    sessionId: string,
    data: { lastSessionActiveAt: string },
  ): Promise<void> {
    // 这里只写“这段会话最近一次还在继续聊的时间”，
    // 不负责判断是否应该沉淀；沉淀判断由 MemoryLifecycle + Settlement 组合完成。
    const key = this.buildKey(corpId, userId, sessionId);
    await this.redisStore.set(
      key,
      this.serializeStateContent(data) as Record<string, unknown>,
      this.config.sessionTtl,
      true,
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
    const prompt = buildSessionExtractionPrompt(
      brandData,
      currentMessage,
      messagesToProcess,
      aliasHints,
    );
    const newFacts = mergeDetectedBrands(await this.callLLM(prompt), aliasHints);

    await this.saveFacts(corpId, userId, sessionId, newFacts);
  }

  private async callLLM(prompt: string): Promise<EntityExtractionResult> {
    try {
      const model = this.router.resolveByRole(ModelRole.Extract);

      const result = await generateText({
        model,
        output: Output.object({
          schema: EntityExtractionResultSchema,
          name: 'WeworkCandidateFacts',
        }),
        system: SESSION_EXTRACTION_SYSTEM_PROMPT,
        prompt,
      });

      if (!result.output) {
        this.logger.warn('[extractFacts] No structured output returned');
        return FALLBACK_EXTRACTION;
      }

      return result.output;
    } catch (err) {
      this.logger.warn('[extractFacts] LLM extraction failed, using fallback', err);
      return FALLBACK_EXTRACTION;
    }
  }

  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `facts:${corpId}:${userId}:${sessionId}`;
  }

  private serializeStateContent(content: Partial<WeworkSessionState>): Partial<WeworkSessionState> {
    return SessionFactsRedisContentSchema.parse(content) as Partial<WeworkSessionState>;
  }
}
