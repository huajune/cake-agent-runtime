import { Injectable, Logger } from '@nestjs/common';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { ModelMessage } from 'ai';
import { SpongeService } from '@sponge/sponge.service';
import type { PostProcessingStatus, PostProcessingStepStatus } from '@shared-types/tracking.types';
import { LongTermService } from './long-term.service';
import { MemoryEnrichmentService, type CandidateIdentityHint } from './memory-enrichment.service';
import { ProceduralService } from './procedural.service';
import { SettlementService } from './settlement.service';
import { SessionService } from './session.service';
import { ShortTermService } from './short-term.service';
import { extractHighConfidenceFacts } from '../facts/high-confidence-facts';
import type { AgentMemoryContext } from '../types/memory-runtime.types';
import type { ShortTermMessage } from '../types/short-term.types';
import {
  type EntityExtractionResult,
  type RecommendedJobSummary,
} from '../types/session-facts.types';

export interface MemoryLifecycleTurnContext {
  corpId: string;
  userId: string;
  sessionId: string;
  messageId?: string;
  normalizedMessages: ModelMessage[];
  /** 本轮工具查到的候选池；回合结束时统一写入会话记忆。 */
  candidatePool?: RecommendedJobSummary[] | null;
}

interface StepOutcome<T = void> {
  step: PostProcessingStepStatus;
  value?: T;
}

interface TimedTask<T = void> {
  name: string;
  timings: {
    startedAt: number;
    endedAt: number;
  };
  promise: Promise<T>;
}

/**
 * 统一处理回合开始读取、回合结束写回。
 *
 * 这个服务只负责 turn lifecycle：
 * - `onTurnStart` 读取运行时需要的四类记忆
 * - `onTurnEnd` 按固定顺序做收尾
 *
 * 它不直接承担具体的领域判断：
 * - 会话记忆投影交给 SessionService
 * - 长期记忆沉淀交给 SettlementService
 */
@Injectable()
export class MemoryLifecycleService {
  private readonly logger = new Logger(MemoryLifecycleService.name);

  constructor(
    private readonly shortTerm: ShortTermService,
    private readonly procedural: ProceduralService,
    private readonly longTerm: LongTermService,
    private readonly settlement: SettlementService,
    private readonly session: SessionService,
    private readonly sponge: SpongeService,
    private readonly enrichment: MemoryEnrichmentService,
    private readonly messageProcessing: MessageProcessingService,
  ) {}

  /**
   * @param currentUserMessage 本轮 user 的最新文本。同时服务于两件事：
   *   - 前置高置信识别（品牌/城市/年龄等规则抽取）
   *   - 短期窗口空兜底（includeShortTerm=true 但 DB/Redis 无数据时兜上）
   */
  async onTurnStart(
    corpId: string,
    userId: string,
    sessionId: string,
    currentUserMessage?: string,
    options?: {
      includeShortTerm?: boolean;
      /**
       * 短期记忆读取上界。用于 WeCom 聚合/重跑批次，防止尚未被本批消费的
       * pending 入站消息因已写入 Redis/DB 历史而提前进入 Agent 上下文。
       */
      shortTermEndTimeInclusive?: number;
      /**
       * 外部身份定位，用于向外部系统补全快照中缺失的画像字段（如性别）。
       * 提供时触发 MemoryEnrichmentService。
       */
      enrichmentIdentity?: CandidateIdentityHint;
    },
  ): Promise<AgentMemoryContext> {
    const includeShortTerm = options?.includeShortTerm ?? true;

    const [rawShortTermMessages, sessionState, proceduralState, profile] = await Promise.all([
      includeShortTerm
        ? this.loadShortTermMessages(sessionId, options?.shortTermEndTimeInclusive)
        : Promise.resolve([]),
      this.session.getSessionState(corpId, userId, sessionId),
      this.procedural.get(corpId, userId, sessionId),
      this.longTerm.getProfile(corpId, userId),
    ]);

    const shortTermMessages = this.applyShortTermFallback(
      rawShortTermMessages,
      includeShortTerm ? currentUserMessage : undefined,
      sessionId,
    );

    const highConfidenceFacts = await this.detectHighConfidenceFacts(currentUserMessage);
    const warnings: string[] = [];
    if (includeShortTerm && this.shortTerm.lastLoadError) {
      warnings.push(`shortTerm: ${this.shortTerm.lastLoadError}`);
    }

    const snapshot: AgentMemoryContext = {
      shortTerm: {
        messageWindow: shortTermMessages,
      },
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      sessionMemory: this.hasStructuredSessionMemoryState(sessionState) ? sessionState : null,
      highConfidenceFacts,
      procedural: proceduralState,
      longTerm: { profile },
    };

    if (options?.enrichmentIdentity) {
      return await this.enrichment.enrich(snapshot, options.enrichmentIdentity);
    }

    return snapshot;
  }

  private loadShortTermMessages(
    sessionId: string,
    endTimeInclusive?: number,
  ): Promise<ShortTermMessage[]> {
    if (endTimeInclusive === undefined) {
      return this.shortTerm.getMessages(sessionId);
    }
    return this.shortTerm.getMessages(sessionId, { endTimeInclusive });
  }

  /**
   * 当短期窗口为空时，用调用方提供的 user 消息兜底。
   *
   * 这是 wecom 链路的瞬时故障兜底：当前轮消息刚写入 DB/Redis 但读回为空，
   * 模型至少拿到"这一轮 user 说了什么"而不会因为 messages=[] 直接抛错。
   */
  private applyShortTermFallback(
    messages: ShortTermMessage[],
    fallbackUserMessage: string | undefined,
    sessionId: string,
  ): ShortTermMessage[] {
    if (messages.length > 0) return messages;
    const trimmed = fallbackUserMessage?.trim();
    if (!trimmed) return messages;

    this.logger.warn(
      `短期记忆为空，使用 fallback 消息兜底: sessionId=${sessionId}, len=${trimmed.length}`,
    );
    return [{ role: 'user', content: trimmed }];
  }

  async onTurnEnd(ctx: MemoryLifecycleTurnContext, assistantText?: string): Promise<void> {
    const lifecycleStartedAt = Date.now();
    await this.persistPostProcessingStatus(ctx.messageId, {
      status: 'running',
      startedAt: new Date(lifecycleStartedAt).toISOString(),
      counts: {
        total: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      },
      steps: [],
    });

    const steps: PostProcessingStepStatus[] = [];

    try {
      const lastUserMsg = ctx.normalizedMessages.filter((m) => m.role === 'user').pop();
      if (!lastUserMsg) {
        steps.push(
          this.buildSkippedStep(
            'locate_last_user_message',
            'normalizedMessages 中没有 user 消息，跳过 turn-end post-processing',
          ),
        );
        await this.persistFinalPostProcessingStatus(ctx.messageId, lifecycleStartedAt, steps);
        return;
      }

      const lastUserText = this.extractTextFromContent(lastUserMsg.content);
      const previousStateResult = await this.runMeasuredStep(
        'load_previous_state',
        async () => await this.session.getSessionState(ctx.corpId, ctx.userId, ctx.sessionId),
      );
      steps.push(previousStateResult.step);

      const branchNames: string[] = [];
      const branchPromises: Array<Promise<PostProcessingStepStatus[]>> = [];
      const previousState = previousStateResult.value;

      if (previousState && this.settlement.shouldSettle(previousState.lastSessionActiveAt)) {
        const settlementTask = this.createTimedTask('settlement', async () => {
          await this.settlement.settle(ctx.corpId, ctx.userId, ctx.sessionId, previousState);
        });
        branchNames.push(settlementTask.name);
        branchPromises.push(
          settlementTask.promise
            .then(() => [
              this.buildSuccessStep(
                settlementTask.name,
                settlementTask.timings.startedAt,
                settlementTask.timings.endedAt,
              ),
            ])
            .catch((error) =>
              Promise.reject({
                error,
                durationMs: Math.max(
                  settlementTask.timings.endedAt - settlementTask.timings.startedAt,
                  0,
                ),
              }),
            ),
        );
      } else {
        const reason =
          previousStateResult.step.status === 'failure'
            ? '上一轮 session state 读取失败，跳过 settlement'
            : '会话未达到沉淀阈值';
        steps.push(this.buildSkippedStep('settlement', reason));
      }

      branchNames.push('session_turn_end_updates');
      branchPromises.push(this.runSessionTurnEndSteps(ctx, lastUserText, assistantText));

      const settledBranches = await Promise.allSettled(branchPromises);
      settledBranches.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          steps.push(...result.value);
          return;
        }

        const branchError = this.extractBranchError(result.reason);
        steps.push(
          this.buildFailureStep(
            branchNames[index] ?? 'turn_end_branch',
            branchError.message,
            branchError.durationMs,
          ),
        );
      });

      await this.persistFinalPostProcessingStatus(ctx.messageId, lifecycleStartedAt, steps);
    } catch (error) {
      steps.push(this.buildFailureStep('turn_end_lifecycle', this.normalizeError(error), 0));
      await this.persistFinalPostProcessingStatus(ctx.messageId, lifecycleStartedAt, steps);
      throw error;
    }
  }

  /** 把消息内容扁平化成纯文本。 */
  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
    }
    return '';
  }

  /** 判断会话记忆里是否已有可用的结构化状态。 */
  private hasStructuredSessionMemoryState(state: {
    facts: unknown;
    lastCandidatePool: unknown[] | null;
    presentedJobs: unknown[] | null;
    currentFocusJob: unknown | null;
    lastSessionActiveAt?: string;
  }): boolean {
    return Boolean(
      state.facts ||
        state.lastCandidatePool?.length ||
        state.presentedJobs?.length ||
        state.currentFocusJob ||
        state.lastSessionActiveAt,
    );
  }

  private async detectHighConfidenceFacts(
    currentUserMessage?: string,
  ): Promise<EntityExtractionResult | null> {
    const trimmed = currentUserMessage?.trim();
    if (!trimmed) return null;

    const brandData = await this.sponge.fetchBrandList();
    const highConfidenceFacts = extractHighConfidenceFacts([trimmed], brandData);
    if (!highConfidenceFacts) return null;

    this.logger.debug(`前置高置信识别命中: ${highConfidenceFacts.reasoning}`);
    return highConfidenceFacts;
  }

  private async runSessionTurnEndSteps(
    ctx: MemoryLifecycleTurnContext,
    lastUserText: string,
    assistantText?: string,
  ): Promise<PostProcessingStepStatus[]> {
    const steps: PostProcessingStepStatus[] = [];

    // 这些步骤都会读改写同一份 session state，保留串行执行以避免 Redis 状态互相覆盖。
    if (ctx.candidatePool?.length) {
      const candidatePoolResult = await this.runMeasuredStep('save_candidate_pool', async () => {
        await this.session.saveLastCandidatePool(
          ctx.corpId,
          ctx.userId,
          ctx.sessionId,
          ctx.candidatePool ?? [],
        );
      });
      steps.push(candidatePoolResult.step);
    } else {
      steps.push(this.buildSkippedStep('save_candidate_pool', '本轮没有 candidatePool 需要写入'));
    }

    const activityResult = await this.runMeasuredStep('store_activity', async () => {
      await this.session.storeActivity(ctx.corpId, ctx.userId, ctx.sessionId, {
        lastSessionActiveAt: new Date().toISOString(),
      });
    });
    steps.push(activityResult.step);

    if (assistantText?.trim()) {
      const projectionResult = await this.runMeasuredStep('project_assistant_turn', async () => {
        await this.session.projectAssistantTurn({
          corpId: ctx.corpId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          userText: lastUserText,
          assistantText,
        });
      });
      steps.push(projectionResult.step);
    } else {
      steps.push(
        this.buildSkippedStep('project_assistant_turn', '本轮没有 assistantText，跳过岗位记忆投影'),
      );
    }

    const flatMessages = ctx.normalizedMessages.map((m) => ({
      role: String(m.role),
      content: this.extractTextFromContent(m.content),
    }));
    const extractFactsResult = await this.runMeasuredStep('extract_facts', async () => {
      await this.session.extractAndSave(ctx.corpId, ctx.userId, ctx.sessionId, flatMessages);
    });
    steps.push(extractFactsResult.step);

    return steps;
  }

  private createTimedTask<T>(name: string, task: () => Promise<T>): TimedTask<T> {
    const timings = {
      startedAt: Date.now(),
      endedAt: Date.now(),
    };

    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        timings.endedAt = Date.now();
      });

    return {
      name,
      timings,
      promise,
    };
  }

  private async runMeasuredStep<T>(name: string, task: () => Promise<T>): Promise<StepOutcome<T>> {
    const startedAt = Date.now();
    try {
      const value = await task();
      return {
        value,
        step: this.buildSuccessStep(name, startedAt, Date.now()),
      };
    } catch (error) {
      const message = this.normalizeError(error);
      this.logger.warn(`${name} 失败: ${message}`);
      return {
        step: this.buildFailureStep(name, message, Date.now() - startedAt),
      };
    }
  }

  private buildSuccessStep(
    name: string,
    startedAt: number,
    endedAt: number,
  ): PostProcessingStepStatus {
    return {
      name,
      status: 'success',
      success: true,
      durationMs: Math.max(endedAt - startedAt, 0),
    };
  }

  private buildFailureStep(
    name: string,
    error: string,
    durationMs: number,
  ): PostProcessingStepStatus {
    return {
      name,
      status: 'failure',
      success: false,
      durationMs: Math.max(durationMs, 0),
      error,
    };
  }

  private buildSkippedStep(name: string, reason: string): PostProcessingStepStatus {
    return {
      name,
      status: 'skipped',
      success: true,
      durationMs: 0,
      reason,
    };
  }

  private async persistPostProcessingStatus(
    messageId: string | undefined,
    status: PostProcessingStatus,
  ): Promise<void> {
    if (!messageId) return;

    try {
      await this.messageProcessing.updatePostProcessingStatus(messageId, status);
    } catch (error) {
      this.logger.warn(`写入 post_processing_status 失败 [${messageId}]`, error);
    }
  }

  private async persistFinalPostProcessingStatus(
    messageId: string | undefined,
    lifecycleStartedAt: number,
    steps: PostProcessingStepStatus[],
  ): Promise<void> {
    const completedAt = Date.now();
    const failed = steps.filter((step) => step.status === 'failure').length;
    const skipped = steps.filter((step) => step.status === 'skipped').length;
    const succeeded = steps.filter((step) => step.status === 'success').length;
    const finalStatus: PostProcessingStatus = {
      status:
        steps.length === 1 && steps[0]?.status === 'skipped'
          ? 'skipped'
          : failed > 0
            ? 'completed_with_errors'
            : 'completed',
      startedAt: new Date(lifecycleStartedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(completedAt - lifecycleStartedAt, 0),
      counts: {
        total: steps.length,
        succeeded,
        failed,
        skipped,
      },
      steps,
    };

    await this.persistPostProcessingStatus(messageId, finalStatus);
  }

  private normalizeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private extractBranchError(reason: unknown): { message: string; durationMs: number } {
    if (typeof reason === 'object' && reason !== null) {
      const typed = reason as { error?: unknown; durationMs?: unknown };
      return {
        message: this.normalizeError(typed.error ?? reason),
        durationMs:
          typeof typed.durationMs === 'number' && Number.isFinite(typed.durationMs)
            ? typed.durationMs
            : 0,
      };
    }

    return {
      message: this.normalizeError(reason),
      durationMs: 0,
    };
  }
}
