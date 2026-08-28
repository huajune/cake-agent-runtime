import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModelMessage } from 'ai';
import { SpongeService } from '@sponge/sponge.service';
import type { PostProcessingStatus, PostProcessingStepStatus } from '@shared-types/tracking.types';
import type { CityAttestation } from '@shared-types/turn.types';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import { BrandStateService } from './short-term/brand-state.service';
import { LongTermService } from './long-term/long-term.service';
import { ConsolidationSchedulerService } from './long-term/consolidation-scheduler.service';
import { SessionStateService } from './short-term/session-state.service';
import { SessionWorkbenchService } from './short-term/workbench.service';
import { MessageWindowService } from './short-term/message-window.service';
import { stripQuotedBlocks, stripTimeContext } from '@resolution/signal/markers';
import type { AgentMemoryContext } from './recall.types';
import type { ShortTermMessage } from './short-term/short-term.types';
import type { WeworkSessionState } from './short-term/short-term.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { LaborFormIntentDecision } from '@resolution/labor-form';
import { MEMORY_MESSAGE_PROCESSING_PORT, type MemoryMessageProcessingPort } from './memory.ports';

export interface MemoryLifecycleTurnContext {
  corpId: string;
  userId: string;
  sessionId: string;
  messageId?: string;
  /** 当前与候选人聊天的托管账号 wxid（imBotId）；沉淀时作为长期事实的 bot 血缘。 */
  botImId?: string;
  /** 当前托管账号的稳定企微身份（wecomUserId）；长期记忆严格按此维度隔离。 */
  botUserId?: string;
  normalizedMessages: ModelMessage[];
  /** 本轮工具查到的候选池；回合结束时统一写入会话记忆。 */
  candidatePool?: RecommendedJobSummary[] | null;
  /** 本轮 duliday_job_list 查询签名；回合结束时写入会话记忆，供下一轮重复查询检测。 */
  jobListQuerySignature?: string | null;
  /** 候选人微信昵称；facts.brand 首次初始化（seed，§9.4）用。 */
  contactName?: string;
  /** 本轮图片描述的品牌解析结果（save_image_description execute 内同步产出，§10.2）。 */
  imageBrandResolutions?: BrandResolution[] | null;
  /** 本轮 geocode unique 解析确权的城市；回合结束写入 pref.city（source='system'）。 */
  cityAttestation?: CityAttestation | null;
  /**
   * 本轮工具判定失效（海绵查不到）的 jobId；回合结束从会话岗位记忆剔除，
   * 避免下一轮模型又从记忆取到死岗位重试 precheck（badcase chat 6a685393）。
   */
  invalidatedJobIds?: number[] | null;
  /** prep 时刻唯一一次规则轨判定；轮末直接消费，禁止重跑。 */
  turnHints: TurnHints | null;
  /** prep 时刻规则轨的 labor-form 三态判定；轮末只消费、不重跑。 */
  laborFormIntent: LaborFormIntentDecision;
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
 * - `onTurnStart` 读取运行时需要的两层记忆与本轮 sidecar
 * - `onTurnEnd` 按固定顺序做收尾
 *
 * 它不直接承担具体的领域判断：
 * - 会话记忆投影交给 SessionStateService
 * - 长期记忆沉淀排程交给 ConsolidationSchedulerService
 */
@Injectable()
export class MemoryLifecycleService {
  private readonly logger = new Logger(MemoryLifecycleService.name);

  constructor(
    private readonly shortTerm: MessageWindowService,
    private readonly workbench: SessionWorkbenchService,
    private readonly longTerm: LongTermService,
    private readonly consolidationScheduler: ConsolidationSchedulerService,
    private readonly session: SessionStateService,
    private readonly sponge: SpongeService,
    @Inject(MEMORY_MESSAGE_PROCESSING_PORT)
    private readonly messageProcessing: MemoryMessageProcessingPort,
    private readonly brandState: BrandStateService,
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
      /** prep 已运行的本轮规则轨；memory 只装配，不重复判定。 */
      turnHints?: TurnHints | null;
      /** 当前托管账号的稳定企微身份（wecomUserId）；缺失时长期记忆 fail-closed。 */
      botUserId?: string;
    },
  ): Promise<AgentMemoryContext> {
    const includeShortTerm = options?.includeShortTerm ?? true;
    const botUserId = options?.botUserId?.trim();

    const [rawShortTermMessages, sessionState, stageState, profile, longTermPreferences] =
      await Promise.all([
        includeShortTerm
          ? this.loadShortTermMessages(sessionId, options?.shortTermEndTimeInclusive)
          : Promise.resolve([]),
        this.session.getSessionState(corpId, userId, sessionId),
        this.workbench.getStage(corpId, userId, sessionId),
        botUserId ? this.longTerm.getProfile(corpId, userId, botUserId) : Promise.resolve(null),
        botUserId ? this.longTerm.getPreferences(corpId, userId, botUserId) : Promise.resolve(null),
      ]);

    const shortTermMessages = this.applyShortTermFallback(
      rawShortTermMessages,
      includeShortTerm ? currentUserMessage : undefined,
      sessionId,
    );

    const turnHints = options?.turnHints ?? null;
    const warnings: string[] = [];
    if (includeShortTerm && this.shortTerm.lastLoadError) {
      warnings.push(`shortTerm: ${this.shortTerm.lastLoadError}`);
    }

    const hasOwnSessionMemory = this.hasStructuredSessionMemoryState(sessionState);
    const snapshot: AgentMemoryContext = {
      shortTerm: {
        messageWindow: shortTermMessages,
        sessionState: hasOwnSessionMemory ? sessionState : null,
        stage: stageState,
      },
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      turnHints,
      longTerm: {
        semantic: { profile, jobIntent: longTermPreferences },
      },
    };

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

      // 每回合结束刷新 3 天 delayed job；真正沉淀到点后重读 facts 与 DB 活跃时间。
      const consolidationTask = this.createTimedTask('schedule_consolidation', async () => {
        await this.consolidationScheduler.schedule({
          corpId: ctx.corpId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          botUserId: ctx.botUserId,
          botImId: ctx.botImId,
          activityAt: Date.now(),
        });
      });
      branchNames.push(consolidationTask.name);
      branchPromises.push(
        consolidationTask.promise
          .then(() => [
            this.buildSuccessStep(
              consolidationTask.name,
              consolidationTask.timings.startedAt,
              consolidationTask.timings.endedAt,
            ),
          ])
          .catch((error) =>
            Promise.reject({
              error,
              durationMs: Math.max(
                consolidationTask.timings.endedAt - consolidationTask.timings.startedAt,
                0,
              ),
            }),
          ),
      );

      branchNames.push('session_turn_end_updates');
      branchPromises.push(
        this.runSessionTurnEndSteps(ctx, lastUserText, assistantText, previousState),
      );

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
    lastJobListQuery?: unknown;
  }): boolean {
    // 品牌状态已归入 facts.brand；seed-only 会话同样会留下非空 facts。
    return Boolean(
      state.facts ||
        state.lastCandidatePool?.length ||
        state.presentedJobs?.length ||
        state.currentFocusJob ||
        // 0 结果查询可能不会留下 candidatePool / presentedJobs，但查询指纹本身必须在
        // 下一轮继续注入，否则最需要防复读的“连续无结果”场景会被误判为空会话。
        state.lastJobListQuery,
    );
  }

  private async runSessionTurnEndSteps(
    ctx: MemoryLifecycleTurnContext,
    lastUserText: string,
    assistantText?: string,
    previousState?: WeworkSessionState,
  ): Promise<PostProcessingStepStatus[]> {
    const steps: PostProcessingStepStatus[] = [];

    // session state 是 hash 字段级原子写（save* 只 HSET 自己的字段），跨字段并发
    // 不会互相覆盖。这里的串行执行是为了步骤间的数据依赖（projectAssistantTurn 读
    // saveLastCandidatePool 刚写入的候选池）与 step 统计顺序，不承担防覆盖职责。
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

    if (ctx.jobListQuerySignature) {
      const querySignatureResult = await this.runMeasuredStep('save_job_list_query', async () => {
        await this.session.saveLastJobListQuery(ctx.corpId, ctx.userId, ctx.sessionId, {
          signature: ctx.jobListQuerySignature as string,
          turnId: ctx.messageId ?? null,
          updatedAtMs: Date.now(),
        });
      });
      steps.push(querySignatureResult.step);
    } else {
      steps.push(this.buildSkippedStep('save_job_list_query', '本轮没有 job_list 查询需要记录'));
    }

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

    // 死岗位剔除：必须排在 save_candidate_pool 与 project_assistant_turn 之后——
    // 前者刚写入本轮候选池、后者会依据回复文本重设 currentFocusJob，若先剔除，
    // 这两步会把同一个死岗位重新写回记忆，下一轮模型照样取到它重试。
    if (ctx.invalidatedJobIds?.length) {
      const dropResult = await this.runMeasuredStep('drop_invalidated_jobs', async () => {
        return await this.session.dropInvalidatedJobs(
          ctx.corpId,
          ctx.userId,
          ctx.sessionId,
          ctx.invalidatedJobIds ?? [],
        );
      });
      steps.push(dropResult.step);
    } else {
      steps.push(this.buildSkippedStep('drop_invalidated_jobs', '本轮没有失效岗位需要剔除'));
    }

    // 工具确权城市入档（候选人资料证据化 A1）：排在 extract_facts 之前——若本轮候选人
    // 原文也报了城市，规则/LLM 抽取（T1 亲证）随后覆盖工具确权（T2），采信优先级正确。
    if (ctx.cityAttestation) {
      const attestedCityResult = await this.runMeasuredStep('save_attested_city', async () => {
        return await this.session.saveToolAttestedCity(
          ctx.corpId,
          ctx.userId,
          ctx.sessionId,
          ctx.cityAttestation as CityAttestation,
        );
      });
      steps.push(attestedCityResult.step);
    } else {
      steps.push(this.buildSkippedStep('save_attested_city', '本轮没有工具确权城市需要写入'));
    }

    const flatMessages = ctx.normalizedMessages.map((m) => ({
      role: String(m.role),
      content: this.extractTextFromContent(m.content),
    }));
    const extractFactsResult = await this.runMeasuredStep('extract_facts', async () => {
      return await this.session.extractAndSave(
        ctx.corpId,
        ctx.userId,
        ctx.sessionId,
        flatMessages,
        ctx.turnHints,
        ctx.laborFormIntent,
      );
    });
    // LLM 提取降级（fallback 空值）若被吞掉、step 仍标 success，提取实际成功率
    // 不可观测。这里把降级显式标成 failure step，使整轮落 completed_with_errors。
    if (extractFactsResult.step.status === 'success' && extractFactsResult.value?.llmDegraded) {
      steps.push(
        this.buildFailureStep(
          'extract_facts_llm_degraded',
          'LLM 提取失败已降级为空值，本轮新事实丢失',
          0,
        ),
      );
    }
    steps.push(extractFactsResult.step);

    // 品牌状态 reducer 排在 extract_facts 之后。正常提取时，LLM 负责复杂极性，
    // 规则只做目录验证；仅提取失败/降级时才用本轮文本规则恢复核心显式极性。
    const brandStateResult = await this.runMeasuredStep('apply_brand_state', async () => {
      return await this.applyBrandState(ctx, extractFactsResult.value?.brandIntents ?? [], {
        previousState,
        llmDegraded:
          extractFactsResult.step.status !== 'success' ||
          extractFactsResult.value?.llmDegraded === true,
      });
    });
    steps.push(brandStateResult.step);

    return steps;
  }

  /**
   * 汇总本轮全部品牌解析结果 → reducer 批量应用 → 单字段写回（§5.3 锚点二）。
   *
   * 正常输入：LLM 轨（extract_facts 产出且已过目录验证）+ 图片轨。
   * 降级输入：规则轨（本轮 user 文本核心显式极性）+ 图片轨。
   */
  private async applyBrandState(
    ctx: MemoryLifecycleTurnContext,
    llmBrandIntents: BrandResolution[],
    options: { previousState?: WeworkSessionState; llmDegraded: boolean },
  ): Promise<{ changed: boolean; initialized: boolean }> {
    let brandData: Awaited<ReturnType<SpongeService['fetchBrandList']>> = [];
    try {
      brandData = await this.sponge.fetchBrandList();
    } catch {
      brandData = [];
    }

    const fallbackResolutions = options.llmDegraded
      ? this.collectTrailingUserTexts(ctx.normalizedMessages).flatMap((text) =>
          resolveBrands(text, 'user_text', brandData),
        )
      : [];
    const resolutions: BrandResolution[] = [
      ...(ctx.imageBrandResolutions ?? []),
      ...fallbackResolutions,
      ...llmBrandIntents,
    ];

    return await this.brandState.applyTurnResolutions({
      corpId: ctx.corpId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      resolutions,
      contactName: ctx.contactName,
      persistedBrandState: options.previousState
        ? (options.previousState.facts?.brand ?? null)
        : undefined,
    });
  }

  /** 末尾连续 user 块的纯文本（剥引用块 + 时间后缀），供品牌规则轨解析。 */
  private collectTrailingUserTexts(messages: ModelMessage[]): string[] {
    const texts: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'user') break;
      const text = stripQuotedBlocks(
        stripTimeContext(this.extractTextFromContent(message.content)),
      ).trim();
      if (text) texts.unshift(text);
    }
    return texts;
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
