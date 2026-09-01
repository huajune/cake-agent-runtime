import { Injectable, Logger } from '@nestjs/common';
import { RecommendedJobSummarySchema, type RecommendedJobSummary } from '@resolution/job/types';
import {
  extractPresentedJobs,
  resolveAssistantAnchoredFocusJob,
  resolveCurrentFocusJob,
} from '@resolution/job';
import { MemoryConfig } from '../memory.config';
import { RedisStore } from '../stores/redis.store';
import { SessionFactsService } from './facts.service';
import {
  type JobListQueryRecord,
  JobListQueryRecordSchema,
  type StageState,
} from './short-term.types';

/**
 * 会话记忆·工作台舱（working state）。
 *
 * 职责：注意力与查询状态——lastCandidatePool / presentedJobs / currentFocusJob /
 * lastJobListQuery 与阶段指针的投影与维护。候选池等字段的状态 IO 经事实舱
 * （hash 状态所有者）；阶段指针保留既有 `stage:` 独立 key 与覆盖写纪律。
 */
@Injectable()
export class SessionWorkbenchService {
  private readonly logger = new Logger(SessionWorkbenchService.name);

  constructor(
    private readonly facts: SessionFactsService,
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
  ) {}

  /** 读取当前 session 的阶段指针；不存在时返回统一空态。 */
  async getStage(corpId: string, userId: string, sessionId: string): Promise<StageState> {
    const entry = await this.redisStore.get(this.buildStageKey(corpId, userId, sessionId));
    if (!entry) return { currentStage: null };

    const content = entry.content as Record<string, unknown>;
    return { currentStage: (content.currentStage as string) ?? null };
  }

  /** 覆盖写当前阶段；阶段合理性仍由 advance_stage 工具层判断。 */
  async setStage(
    corpId: string,
    userId: string,
    sessionId: string,
    state: StageState,
  ): Promise<void> {
    await this.redisStore.set(
      this.buildStageKey(corpId, userId, sessionId),
      state as unknown as Record<string, unknown>,
      this.config.sessionTtl,
      false,
    );
    this.logger.log(`阶段更新: ${state.currentStage} (user=${userId})`);
  }

  async clearStage(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    return await this.redisStore.del(this.buildStageKey(corpId, userId, sessionId));
  }

  async saveLastCandidatePool(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    const MAX_CANDIDATE_POOL_SIZE = 30;
    const validatedJobs = jobs
      .slice(0, MAX_CANDIDATE_POOL_SIZE)
      .map((job) => RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary);
    await this.facts.patchSessionState(corpId, userId, sessionId, {
      lastCandidatePool: validatedJobs,
    });
  }

  /** 记录本轮 duliday_job_list 查询签名，供下一轮做跨轮重复查询检测。 */
  async saveLastJobListQuery(
    corpId: string,
    userId: string,
    sessionId: string,
    record: JobListQueryRecord,
  ): Promise<void> {
    const validated = JobListQueryRecordSchema.parse(record) as JobListQueryRecord;
    await this.facts.patchSessionState(corpId, userId, sessionId, { lastJobListQuery: validated });
  }

  async savePresentedJobs(
    corpId: string,
    userId: string,
    sessionId: string,
    jobs: RecommendedJobSummary[],
  ): Promise<void> {
    if (jobs.length === 0) return;

    const state = await this.facts.getSessionState(corpId, userId, sessionId);
    const validatedJobs = jobs.map(
      (job) => RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary,
    );
    const merged = [...validatedJobs, ...(state.presentedJobs ?? [])].filter(
      (job, index, arr) => arr.findIndex((item) => item.jobId === job.jobId) === index,
    );

    await this.facts.patchSessionState(corpId, userId, sessionId, {
      presentedJobs: merged.slice(0, 10),
      storePresentationRounds: (state.storePresentationRounds ?? 0) + 1,
    });
  }

  /**
   * 把工具已判定失效（海绵查不到：下架/满员）的岗位从会话岗位记忆里剔除。
   *
   * 覆盖 lastCandidatePool / presentedJobs / currentFocusJob 三处——它们同时是
   * 下一轮 prompt 的岗位来源与 precheck/booking 的 jobId provenance 集，漏掉任一处
   * 死岗位就会被重新喂给模型。
   *
   * 不剔除时，模型会连续多轮拿同一个死 jobId 重试 precheck，每轮 job_not_found，最终转人工。
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
    const state = await this.facts.getSessionState(corpId, userId, sessionId);
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

    await this.facts.patchSessionState(corpId, userId, sessionId, {
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
    await this.facts.patchSessionState(corpId, userId, sessionId, {
      currentFocusJob: validatedJob,
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

    const state = await this.facts.getSessionState(corpId, userId, sessionId);

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

  private buildStageKey(corpId: string, userId: string, sessionId: string): string {
    return `stage:${corpId}:${userId}:${sessionId}`;
  }
}
