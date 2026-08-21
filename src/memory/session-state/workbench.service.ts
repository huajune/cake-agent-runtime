import { Injectable, Logger } from '@nestjs/common';
import { RecommendedJobSummarySchema, type RecommendedJobSummary } from '@resolution/job/types';
import {
  extractPresentedJobs,
  resolveAssistantAnchoredFocusJob,
  resolveCurrentFocusJob,
} from '@resolution/job';
import { type JobListQueryRecord, JobListQueryRecordSchema } from './session-facts.types';
import { SessionFactsService } from './facts.service';

/**
 * 会话记忆·工作台舱（working state，M3 分家 2026-08-21）
 *
 * 职责：注意力与查询状态——lastCandidatePool / presentedJobs / currentFocusJob /
 * lastJobListQuery 的投影与维护（覆盖写 + cap，P1-3）。它们是"小王桌上摊开的纸"，
 * 不是事实：治理策略与事实舱（置信度合并）不同。状态 IO 经事实舱（状态所有者）。
 */
@Injectable()
export class SessionWorkbenchService {
  private readonly logger = new Logger(SessionWorkbenchService.name);

  constructor(private readonly facts: SessionFactsService) {}

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
}
