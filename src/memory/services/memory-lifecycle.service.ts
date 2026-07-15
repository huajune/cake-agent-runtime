import { Injectable, Logger } from '@nestjs/common';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { ModelMessage } from 'ai';
import { SpongeService } from '@sponge/sponge.service';
import type { PostProcessingStatus, PostProcessingStepStatus } from '@shared-types/tracking.types';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import { MessageParser } from '@channels/wecom/message/utils/message-parser.util';
import { BrandStateService } from './brand-state.service';
import { LongTermService } from './long-term.service';
import { MemoryEnrichmentService, type CandidateIdentityHint } from './memory-enrichment.service';
import { ProceduralService } from './procedural.service';
import { SettlementService } from './settlement.service';
import { SessionService } from './session.service';
import { ShortTermService } from './short-term.service';
import { extractHighConfidenceFacts, stripQuotedBlocks } from '../facts/high-confidence-facts';
import type { AgentMemoryContext } from '../types/memory-runtime.types';
import type {
  LongTermPreferenceFacts,
  SummaryData,
  UserProfileFacts,
} from '../types/long-term.types';
import { isUserProfileFactValue } from '../types/long-term.types';
import type { ShortTermMessage } from '../types/short-term.types';
import {
  type HighConfidenceFacts,
  type RecommendedJobSummary,
  type WeworkSessionState,
} from '../types/session-facts.types';

export interface MemoryLifecycleTurnContext {
  corpId: string;
  userId: string;
  sessionId: string;
  messageId?: string;
  /** 当前与候选人聊天的托管账号 wxid（imBotId）；沉淀时作为长期事实的 bot 血缘。 */
  botImId?: string;
  normalizedMessages: ModelMessage[];
  /** 本轮工具查到的候选池；回合结束时统一写入会话记忆。 */
  candidatePool?: RecommendedJobSummary[] | null;
  /** 候选人微信昵称；brand_state 首次初始化（懒迁移 seed，§9.4）用。 */
  contactName?: string;
  /** 本轮图片描述的品牌解析结果（save_image_description execute 内同步产出，§10.2）。 */
  imageBrandResolutions?: BrandResolution[] | null;
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
      /**
       * 外部身份定位，用于向外部系统补全快照中缺失的画像字段（如性别）。
       * 提供时触发 MemoryEnrichmentService。
       */
      enrichmentIdentity?: CandidateIdentityHint;
    },
  ): Promise<AgentMemoryContext> {
    const includeShortTerm = options?.includeShortTerm ?? true;

    const [
      rawShortTermMessages,
      sessionState,
      proceduralState,
      profile,
      longTermPreferences,
      summaryData,
    ] = await Promise.all([
      includeShortTerm
        ? this.loadShortTermMessages(sessionId, options?.shortTermEndTimeInclusive)
        : Promise.resolve([]),
      this.session.getSessionState(corpId, userId, sessionId),
      this.procedural.get(corpId, userId, sessionId),
      this.longTerm.getProfile(corpId, userId),
      this.longTerm.getPreferences(corpId, userId),
      this.longTerm.getSummaryData(corpId, userId),
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

    const hasOwnSessionMemory = this.hasStructuredSessionMemoryState(sessionState);
    const fromOtherConversation = this.detectCrossConversationOrigin({
      sessionId,
      hasOwnSessionMemory,
      profile,
      preferences: longTermPreferences,
      summaryData,
    });

    const snapshot: AgentMemoryContext = {
      shortTerm: {
        messageWindow: shortTermMessages,
      },
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      sessionMemory: hasOwnSessionMemory ? sessionState : null,
      highConfidenceFacts,
      procedural: proceduralState,
      longTerm: {
        profile,
        preferences: longTermPreferences,
        ...(fromOtherConversation ? { origin: { fromOtherConversation: true } } : {}),
      },
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

      // 会话沉淀：不再依赖 Redis 中的 lastSessionActiveAt（已从 schema 中删除）。
      // 改用 detectAndSettle：通过 chat_messages DB 时间戳检测断层，驱动沉淀触发。
      // 读取失败时降级跳过，不中断主流程。
      if (previousStateResult.step.status === 'failure') {
        steps.push(
          this.buildSkippedStep('settlement', '上一轮 session state 读取失败，跳过 settlement'),
        );
      } else {
        const settlementTask = this.createTimedTask('settlement', async () => {
          await this.settlement.detectAndSettle(
            ctx.corpId,
            ctx.userId,
            ctx.sessionId,
            previousState?.facts ?? null,
            ctx.botImId,
          );
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
      }

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
    brand_state?: unknown;
  }): boolean {
    return Boolean(
      state.facts ||
        state.lastCandidatePool?.length ||
        state.presentedJobs?.length ||
        state.currentFocusJob ||
        // 品牌状态本身就是结构化会话记忆：seed-only 会话（首轮只落了 brand_state）
        // 不能被判成空会话，否则准备阶段读不到已存在的状态、触发重复 seed
        state.brand_state,
    );
  }

  /**
   * 研判本轮注入的长期记忆是否来自候选人此前的"另一段会话"（多为另一位招募经理）。
   *
   * 仅在「全新 chat 首聊」时触发：当前会话已有自有会话记忆即视为延续，不提示。
   * 判定优先用逐字段数据血缘（originSessionId）；存量事实无血缘时，回退到沉淀边界
   * / 历史摘要里是否出现过其它会话。
   */
  private detectCrossConversationOrigin(input: {
    sessionId: string;
    hasOwnSessionMemory: boolean;
    profile: UserProfileFacts | null;
    preferences: LongTermPreferenceFacts | null;
    summaryData: SummaryData | null;
  }): boolean {
    const { sessionId, hasOwnSessionMemory, profile, preferences, summaryData } = input;
    if (hasOwnSessionMemory) return false;

    const hasLongTerm = this.hasAnyFact(profile) || this.hasAnyFact(preferences);
    if (!hasLongTerm) return false;

    // 优先：逐字段血缘——任一长期事实标注的来源会话不是当前会话即判定跨会话。
    if (
      this.hasFactFromOtherSession(profile, sessionId) ||
      this.hasFactFromOtherSession(preferences, sessionId)
    ) {
      return true;
    }

    // 回退：存量事实无 origin 血缘时，看沉淀边界 / 历史摘要里是否出现过其它会话。
    const settledSessions = new Set<string>([
      ...Object.keys(summaryData?.lastSettledBySession ?? {}),
      ...(summaryData?.recent ?? []).map((entry) => entry.sessionId).filter(Boolean),
    ]);
    settledSessions.delete(sessionId);
    return settledSessions.size > 0;
  }

  private hasAnyFact(facts: Record<string, unknown> | null | undefined): boolean {
    if (!facts) return false;
    return Object.values(facts).some((value) => value !== null && value !== undefined);
  }

  private hasFactFromOtherSession(
    facts: Record<string, unknown> | null | undefined,
    currentSessionId: string,
  ): boolean {
    if (!facts) return false;
    return Object.values(facts).some(
      (value) =>
        isUserProfileFactValue(value) &&
        Boolean(value.originSessionId) &&
        value.originSessionId !== currentSessionId,
    );
  }

  private async detectHighConfidenceFacts(
    currentUserMessage?: string,
  ): Promise<HighConfidenceFacts | null> {
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
    previousState?: WeworkSessionState,
  ): Promise<PostProcessingStepStatus[]> {
    const steps: PostProcessingStepStatus[] = [];

    // session state 已改为 hash 字段级原子写（save* 只 HSET 自己的字段），跨字段并发
    // 不再互相覆盖。这里保留串行执行是为了步骤间的数据依赖（projectAssistantTurn 读
    // saveLastCandidatePool 刚写入的候选池）与 step 统计顺序，不再承担防覆盖职责。
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
      return await this.session.extractAndSave(ctx.corpId, ctx.userId, ctx.sessionId, flatMessages);
    });
    // LLM 提取降级（fallback 空值）此前被吞掉、step 仍标 success，提取实际成功率
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

    // 品牌状态 reducer（§6.3.1/§9.3）：排在 extract_facts 之后（吃它的极性/指代链接产出），
    // 且不因其失败/降级跳过——extract_facts 抛错时以规则轨 + 图片解析结果照常运行，
    // 否则当轮确定性解析出的 positive/negative（连同首轮 seed）会随异常一起丢失。
    const brandStateResult = await this.runMeasuredStep('apply_brand_state', async () => {
      return await this.applyBrandState(ctx, extractFactsResult.value?.brandIntents ?? [], {
        previousState,
      });
    });
    steps.push(brandStateResult.step);

    return steps;
  }

  /**
   * 汇总本轮全部品牌解析结果 → reducer 批量应用 → 单字段写回（§5.3 锚点二）。
   *
   * 三路输入：规则轨（本轮 user 文本重解析，确定性）、LLM 轨（extract_facts 扩展输出，
   * 已过目录验证）、图片轨（save_image_description execute 内产出，挂回合上下文）。
   */
  private async applyBrandState(
    ctx: MemoryLifecycleTurnContext,
    llmBrandIntents: BrandResolution[],
    options: { previousState?: WeworkSessionState },
  ): Promise<{ changed: boolean; initialized: boolean }> {
    let brandData: Awaited<ReturnType<SpongeService['fetchBrandList']>> = [];
    try {
      brandData = await this.sponge.fetchBrandList();
    } catch {
      brandData = [];
    }

    // 规则轨：本轮末尾连续 user 块的文本（与回合准备的 trailingUserContent 同口径），
    // 剥引用块与时间后缀后逐条解析。
    const ruleResolutions = this.collectTrailingUserTexts(ctx.normalizedMessages).flatMap((text) =>
      resolveBrands(text, 'user_text', brandData),
    );
    const resolutions: BrandResolution[] = [
      ...(ctx.imageBrandResolutions ?? []),
      ...ruleResolutions,
      ...llmBrandIntents,
    ];

    return await this.brandState.applyTurnResolutions({
      corpId: ctx.corpId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      resolutions,
      contactName: ctx.contactName,
      persistedBrandState: options.previousState
        ? (options.previousState.brand_state ?? null)
        : undefined,
      facts: options.previousState?.facts ?? null,
    });
  }

  /** 末尾连续 user 块的纯文本（剥引用块 + 时间后缀），供品牌规则轨解析。 */
  private collectTrailingUserTexts(messages: ModelMessage[]): string[] {
    const texts: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'user') break;
      const text = stripQuotedBlocks(
        MessageParser.stripTimeContext(this.extractTextFromContent(message.content)),
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
