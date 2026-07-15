import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelMessage, ToolSet } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { decideLaborFormIntent } from '@memory/facts/labor-form';
import { MemoryService, type CandidateIdentityHint } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import { BrandStateService, type TurnBrandContext } from '@memory/services/brand-state.service';
import { LongTermService } from '@memory/services/long-term.service';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { SpongeService } from '@sponge/sponge.service';
import { isUserProfileFactValue, type UserProfileFacts } from '@memory/types/long-term.types';
import {
  type RecommendedJobSummary,
  type WeworkSessionState,
} from '@memory/types/session-facts.types';
import { ContextService } from './context/context.service';
import { PromptInjectionService } from '../guardrail/input/prompt-injection.service';
import {
  type GeneratorInputMessage,
  type GeneratorInvokeParams,
  type AgentMemorySnapshot,
} from '../generator/generator.types';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { CRITICAL_TURN_GUARD_RULES } from './preparation-utils/critical-turn-guard.rules';
import {
  buildMemoryBlock,
  formatBookingContext,
  type RealtimeGroupStatus,
  type TurnStartMemory,
} from './preparation-utils/memory-block.formatter';
import {
  normalizeConversation,
  trailingUserContent,
  truncateToCharBudget,
} from './preparation-utils/conversation-normalizer';
import {
  buildProactiveDirective,
  buildReviseNotice,
  buildReviseUserDirective,
} from './preparation-utils/revise-directives';
import { resolveToolsForMode, wrapToolsWithTiming } from './preparation-utils/tool-set.util';
import { buildToolContext } from './preparation-utils/tool-context.builder';

export interface PreparedAgentContext {
  finalPrompt: string;
  normalizedMessages: ModelMessage[];
  memoryLoadWarning?: string;
  tools: ToolSet;
  corpId: string;
  userId: string;
  sessionId: string;
  /** 当前与候选人聊天的托管账号 wxid（imBotId）；沉淀时作为长期事实的 bot 血缘。 */
  botImId?: string;
  maxSteps: number;
  /** 本轮入口阶段；由 recruitmentCase + procedural currentStage 共同解析出的 effectiveStage。 */
  entryStage: string | null;
  /** 本轮临时状态；回合结束时统一交给 memory lifecycle。 */
  turnState: {
    candidatePool: RecommendedJobSummary[] | null;
    /** save_image_description 落描述时同步解析出的图片品牌（§10.2 回合上下文）。 */
    imageBrandResolutions: BrandResolution[];
  };
  /** 候选人微信昵称；回合收尾 brand_state 首次初始化（seed）用。 */
  contactName?: string;
  /** 本轮触发时的记忆上下文快照（写入 message_processing_records.memory_snapshot 用于排障） */
  memorySnapshot?: AgentMemorySnapshot;
  /**
   * toolCallId → 工具 execute 的真实执行耗时（毫秒）。
   * 由 prepare 阶段的 timing wrapper 在每次工具执行时写入；
   * runner.buildRunResult 按 toolCallId 合并进 AgentToolCall.durationMs，
   * 与"步骤墙钟"（含 LLM 思考/输出时间）区分开。
   */
  toolExecutionTimings: Map<string, number>;
}

/**
 * 回合准备编排：记忆召回 → 消息归一化 → memoryBlock/system prompt 组装 →
 * 工具集构建 → 观测快照。
 *
 * 纯函数辅助层按职责拆在 preparation-utils/ 子目录：memory-block.formatter（记忆渲染）、
 * conversation-normalizer（消息归一化）、revise-directives（HC-1/主动回合指令）、
 * tool-set.util（工具计时/过滤）、tool-context.builder（工具上下文组装）、
 * critical-turn-guard.rules（动态硬禁令规则表）。本类只保留需要 IO/DI 的编排逻辑。
 */
@Injectable()
export class PreparationService {
  private readonly logger = new Logger(PreparationService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly memoryService: MemoryService,
    private readonly memoryConfig: MemoryConfig,
    private readonly context: ContextService,
    private readonly promptInjection: PromptInjectionService,
    private readonly longTermService: LongTermService,
    private readonly spongeService: SpongeService,
    private readonly groupResolver: GroupResolverService,
    private readonly groupMembership: GroupMembershipService,
    private readonly brandStateService: BrandStateService,
    @Optional()
    private readonly tracer?: AgentTracerService,
  ) {}

  async prepare(
    params: GeneratorInvokeParams,
    mode: 'invoke' | 'stream',
    options?: { enableVision?: boolean },
  ): Promise<PreparedAgentContext> {
    const {
      callerKind,
      userId,
      corpId,
      sessionId,
      scenario = 'candidate-consultation',
      maxSteps = 5,
    } = params;

    this.logger.log(
      `Agent ${mode}: callerKind=${callerKind}, userId=${userId}, corpId=${corpId}, sessionId=${sessionId}, scenario=${scenario}`,
    );

    // 入参归一化：只认 messages[]。本轮的 user 文本 = 末尾连续的 user 块（上一条 assistant 之后的所有 user）。
    // 这样不管上层是否已把多条消息合并成单条 user，都能覆盖本轮全部用户输入——
    // 合并场景（WeCom replay、test-suite 多条连发）下后续事实提取/阶段推断才不会漏内容。
    const truncatedMessages = truncateToCharBudget(
      params.messages,
      this.memoryConfig.sessionWindowMaxChars,
    );
    const currentUserMessage = trailingUserContent(truncatedMessages);
    const currentLaborFormIntent = decideLaborFormIntent(currentUserMessage);

    // 并行拉取本轮依赖：四类记忆快照 + 当前预约工单上下文 + 实时群状态。
    const [memory, bookingContext, realtimeGroups] = await Promise.all([
      this.memoryService.onTurnStart(corpId, userId, sessionId, currentUserMessage, {
        includeShortTerm: callerKind === CallerKind.WECOM,
        shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
        enrichmentIdentity: this.buildEnrichmentIdentity(params),
      }),
      // [当前预约信息] 改由 active_booking 指针 + 海绵工单实时状态渲染（不再依赖 recruitment_cases 本地字段）。
      this.loadBookingContext(
        corpId,
        userId,
        currentUserMessage,
        this.buildSpongeTokenContext(params),
      ),
      this.loadRealtimeGroupStatus(params),
    ]);

    // 对话消息归一化为 AI SDK ModelMessage[]（含多模态图片/表情注入）。
    const normalizedMessages = normalizeConversation({
      callerKind,
      memoryWindow: memory.shortTerm.messageWindow,
      passedMessages: truncatedMessages,
      enableVision: options?.enableVision ?? false,
      imageUrls: params.imageUrls,
      imageMessageIds: params.imageMessageIds,
      visualMessageTypes: params.visualMessageTypes,
    });

    // 输入安全检查：扫 prompt injection → 异步告警 → 返回需要追加到 system prompt 的 guard suffix。
    const guardSuffix = this.applyInputGuard(normalizedMessages, currentUserMessage, userId);

    // 品牌上下文（§5.3 锚点一）：读 SessionBrandState；brand_state 不存在时按
    // 「旧并集末位 > 已验证昵称品牌 seed > 空」构造本轮生效的初始状态（首轮推荐即按
    // 该品牌启动），持久化仍随收尾 reducer 统一落盘。昵称品牌必须先经品牌库确定性
    // 命中——未命中的昵称（如 Gattouzo）不产生任何品牌线索。
    const turnBrandContext = await this.deriveTurnBrandContext(params.contactName, memory);
    const contactBrandAliases = turnBrandContext.nicknameBrands;

    // Compose 的输入：memoryBlock 渲染 + 当前阶段（直接取程序性记忆 currentStage；
    // recruitment_cases 已废弃，不再由 case 推导 onboard_followup）。
    const memoryBlock = buildMemoryBlock(
      memory,
      bookingContext.block,
      realtimeGroups,
      params.contactName,
      contactBrandAliases,
      currentLaborFormIntent,
    );
    const persistedStage = memory.procedural.currentStage ?? undefined;
    // 程序性阶段存 Redis（TTL 2 天），过期后此前隐式兜底到策略第一个阶段——
    // 已服务过的老候选人回访被当新客从 trust_building 重走（张漪 case：6-03 已
    // 约面，6-08/6-10 回访都从信任建立重来）。长期画像已有身份字段即视为老用户，
    // 回访直接进入岗位咨询阶段。
    const returningUserStage = persistedStage
      ? undefined
      : this.resolveReturningUserStage(memory.longTerm.profile);
    const stageFromResolver = persistedStage ?? returningUserStage;

    // System prompt 组装（委托 ContextService.compose）
    const { systemPrompt, stageGoals, thresholds } = await this.context.compose({
      scenario,
      currentStage: stageFromResolver ?? undefined,
      memoryBlock,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      highConfidenceFacts: memory.highConfidenceFacts,
      currentLaborFormIntent,
      sessionBrandState: turnBrandContext.state,
      strategySource: params.strategySource,
    });

    // 本轮入口阶段：持久化阶段优先；老用户兜底阶段需在策略阶段表中存在才采用；
    // 都没有则回到策略第一个 stage（"新会话的起点"）。
    const entryStage =
      persistedStage ??
      (returningUserStage && stageGoals[returningUserStage] ? returningUserStage : undefined) ??
      Object.keys(stageGoals)[0] ??
      null;
    if (!persistedStage && returningUserStage && stageGoals[returningUserStage]) {
      this.logger.log(
        `[prepare] 老用户回访阶段兜底: userId=${params.userId}, entryStage=${returningUserStage}（程序性阶段已过期，长期画像存在）`,
      );
    }

    // 工具上下文 + 观测快照（都消费 entryStage）。
    const turnState: PreparedAgentContext['turnState'] = {
      candidatePool: null,
      imageBrandResolutions: [],
    };
    const toolContext = buildToolContext({
      params,
      memory,
      normalizedMessages,
      entryStage,
      stageGoals,
      thresholds,
      turnState,
      contactBrandAliases,
      sessionBrandState: turnBrandContext.state,
      currentUserMessage,
      currentLaborFormIntent,
      bookingWorkOrderJobIds: bookingContext.jobIds,
    });
    const toolExecutionTimings = new Map<string, number>();
    const scenarioTools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const tools = wrapToolsWithTiming(
      resolveToolsForMode(scenarioTools, params.toolMode ?? 'scenario', params.allowedToolNames),
      toolExecutionTimings,
      this.tracer,
    );
    const memorySnapshot = this.buildMemorySnapshot(memory, entryStage);

    const criticalTurnGuard = this.buildCriticalTurnGuard(currentUserMessage, truncatedMessages);
    const reviseNotice = buildReviseNotice(params);
    const proactiveDirective = buildProactiveDirective(params);

    // HC-1 repair/revise 回合：重写指令同时追加为对话末尾的 user 消息。
    // 只拼在超长 system 末尾时弱模型会无视它、把本轮当新对话重新规划任务
    // （badcase batch_6a4790c7ce406a6aeee9c102：repair 模型重新计划查岗、
    // 想调 geocode，工具已被物理移除，最终只发出一句悬空的"我帮你查下"）。
    const reviseUserDirective = buildReviseUserDirective(params);
    if (reviseUserDirective) {
      normalizedMessages.push({ role: 'user', content: reviseUserDirective });
    }

    return {
      finalPrompt:
        systemPrompt + guardSuffix + criticalTurnGuard + reviseNotice + proactiveDirective,
      normalizedMessages,
      memoryLoadWarning: memory._warnings?.join('; '),
      tools,
      corpId,
      userId,
      sessionId,
      botImId: params.botImId,
      maxSteps,
      entryStage,
      turnState,
      contactName: params.contactName,
      memorySnapshot,
      toolExecutionTimings,
    };
  }

  /**
   * 把本轮最容易复发的事故规则追加到 system prompt 最末尾。
   *
   * 这些规则不是替代主 prompt，而是把“当前消息已经命中”的禁令放到最后，
   * 避免模型在长上下文里先承认规则、最后又被阶段策略带回收资或预约。
   * 规则本体（badcase 驱动的正则 + 禁令文案）维护在 critical-turn-guard.rules.ts。
   */
  private buildCriticalTurnGuard(
    currentUserMessage: string | undefined,
    messages: GeneratorInputMessage[],
  ): string {
    const current = currentUserMessage ?? '';
    const recent = messages
      .slice(-12)
      .map((message) => `${message.role}: ${message.content ?? ''}`)
      .join('\n');
    const combined = `${recent}\n${current}`;

    const guards = CRITICAL_TURN_GUARD_RULES.filter((rule) => {
      const text = rule.target === 'current' ? current : combined;
      return rule.patterns.every((pattern) => pattern.test(text));
    }).map((rule) => rule.guard);

    if (guards.length === 0) return '';

    return `\n\n# 本轮动态硬禁令\n${guards.map((guard) => `- ${guard}`).join('\n')}`;
  }

  /**
   * 装配候选人画像富化所需的身份标识。
   * 仅在 candidate-consultation 场景 + 有 token 时触发外部补全。
   */
  private buildEnrichmentIdentity(
    params: GeneratorInvokeParams,
  ): CandidateIdentityHint | undefined {
    const scenario = params.scenario ?? 'candidate-consultation';
    if (scenario !== 'candidate-consultation' || !params.token) return undefined;
    return {
      token: params.token,
      imBotId: params.botImId,
      imContactId: params.imContactId,
      wecomUserId: params.botUserId,
      externalUserId: params.externalUserId,
    };
  }

  private buildSpongeTokenContext(
    params: GeneratorInvokeParams,
  ): { botImId?: string; botUserId?: string; groupId?: string } | undefined {
    if (!params.botImId && !params.botUserId && !params.groupId) return undefined;
    return {
      botImId: params.botImId,
      botUserId: params.botUserId,
      groupId: params.groupId,
    };
  }

  /**
   * 输入安全检查闭环：扫描 prompt injection → 异步告警 → 返回需要追加到 system prompt 的防护 suffix。
   * 命中注入时返回 GUARD_SUFFIX，否则返回空字符串。
   */
  private applyInputGuard(
    normalizedMessages: ModelMessage[],
    currentUserMessage: string | undefined,
    userId: string,
  ): string {
    const guardResult = this.promptInjection.detectMessages(normalizedMessages);
    if (guardResult.safe) return '';
    this.promptInjection
      .alertInjection(userId, guardResult.reason!, currentUserMessage ?? '')
      .catch(() => {});
    return PromptInjectionService.GUARD_SUFFIX;
  }

  /**
   * 派生本轮品牌上下文（§5.3 锚点一）：SessionBrandState + 昵称品牌线索。
   *
   * 昵称品牌统一经 BrandResolutionService 的目录验证（resolve(contact_name)）：
   * brand_state 不存在时唯一命中的昵称品牌 seed 为 currentBrand 初始值（仅此一次），
   * 首轮推荐即按该品牌启动；状态一旦存在永不重新 seed。
   * 失败一律降级为空状态（不阻断主流程）。
   */
  private async deriveTurnBrandContext(
    contactName: string | undefined,
    memory: TurnStartMemory,
  ): Promise<TurnBrandContext> {
    try {
      return await this.brandStateService.deriveTurnBrandContext({
        persisted: memory.sessionMemory?.brand_state ?? null,
        facts: memory.sessionMemory?.facts ?? null,
        contactName,
      });
    } catch (error) {
      this.logger.warn('品牌上下文派生失败（按空状态降级）', error);
      return {
        state: { currentBrand: null, excludedBrands: [] },
        persisted: false,
        nicknameBrands: [],
      };
    }
  }

  /**
   * 实时核验候选人当前在哪些兼职群。
   *
   * 拉群记忆存会话层（TTL 2 天）：过期后 Agent 不知道候选人已在群，可能重复
   * 邀请/重复承诺；候选人也可能自行退群，记忆会反向过期。实时成员关系
   * （GroupMembershipService，10 分钟缓存）是唯一可靠事实源——这里与记忆召回
   * 并行加载，失败返回空（按"未知"降级，不阻断主流程）。
   */
  private async loadRealtimeGroupStatus(
    params: GeneratorInvokeParams,
  ): Promise<RealtimeGroupStatus[]> {
    const contactId = params.imContactId || params.userId;
    if (!contactId || params.callerKind !== CallerKind.WECOM) return [];

    try {
      const groups = await this.groupResolver.resolveGroups('兼职群');
      if (groups.length === 0) return [];
      const idToGroup = new Map(groups.map((group) => [group.imRoomId, group]));
      const roomIds = await this.groupMembership.listUserRooms(contactId, idToGroup.keys());
      return roomIds
        .map((roomId) => idToGroup.get(roomId))
        .filter((group): group is NonNullable<typeof group> => Boolean(group))
        .map((group) => ({ groupName: group.groupName, city: group.city }));
    } catch (error) {
      this.logger.warn('实时群状态核验失败（按未知降级）', error);
      return [];
    }
  }

  /**
   * 渲染 [当前预约信息]：active_booking 指针 + 海绵工单实时状态。
   *
   * 不再读 recruitment_cases 本地字段（历史 booking_id 全 NULL、状态与海绵脱节）。
   * 非预约回合允许使用短缓存；预约相关回合强制直查海绵，并区分两种「拿不到工单」：
   * - 查询失败（网络/海绵抖动）：注入「最新预约信息确认中」的封闭提示，不使用本地
   *   业务快照，也不阻断本轮；
   * - 海绵明确查不到（指针已失效，active_booking 无过期机制、只有取消工具会清）：
   *   按无此预约静默跳过——若也走「确认中」，失效指针会让每个预约回合永久停留在
   *   「稍等一下」。
   */
  private async loadBookingContext(
    corpId: string,
    userId: string,
    currentUserMessage: string | undefined,
    tokenContext?: { botImId?: string; botUserId?: string; groupId?: string },
  ): Promise<{ block: string; jobIds: number[] }> {
    try {
      const activeBookings = await this.longTermService.getActiveBookings(corpId, userId);
      if (activeBookings.length === 0) return { block: '', jobIds: [] };

      const requiresFreshLookup = this.requiresFreshBookingContext(currentUserMessage);
      // 并行查询：直查路径下多工单串行会把多次海绵 API 耗时叠加进 prepare 热路径。
      const lookups = await Promise.all(
        activeBookings.map(async (activeBooking) => {
          const workOrderId = activeBooking.work_order_id;
          try {
            const workOrder = requiresFreshLookup
              ? await this.spongeService.getWorkOrderById(workOrderId, tokenContext, {
                  throwOnFetchError: true,
                })
              : await this.spongeService.getCachedWorkOrderById(workOrderId, tokenContext);
            return { workOrderId, workOrder, fetchFailed: false };
          } catch (error) {
            this.logger.warn(
              `加载单个预约工单上下文失败 workOrderId=${workOrderId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return { workOrderId, workOrder: null, fetchFailed: true };
          }
        }),
      );

      const contexts: Array<{ block: string; jobId: number | null }> = [];
      let fetchFailedCount = 0;
      for (const { workOrderId, workOrder, fetchFailed } of lookups) {
        if (fetchFailed) {
          fetchFailedCount += 1;
          continue;
        }
        if (!workOrder) {
          this.logger.warn(
            `active_booking 指向的工单海绵查不到（指针可能已失效，按无此预约跳过）workOrderId=${workOrderId}`,
          );
          continue;
        }

        // workOrder.jobId 也是 provenance 合法来源：改约场景下 system prompt 把它作为「岗位ID」
        // 暴露给模型并指示先 precheck 校验新日期，但改约不调 job_list，故必须并入召回集。
        const block = formatBookingContext(workOrder, contexts.length + 1);
        const normalizedJobId =
          typeof workOrder.jobId === 'number'
            ? workOrder.jobId
            : typeof workOrder.jobId === 'string' && /^\d+$/.test(workOrder.jobId)
              ? Number(workOrder.jobId)
              : null;
        if (block) contexts.push({ block, jobId: normalizedJobId });
      }

      const syncingBlock =
        requiresFreshLookup && fetchFailedCount > 0
          ? [
              '预约信息同步中：候选人存在进行中的预约工单，但暂时查询不到最新详情。',
              '禁止使用历史记忆猜测该预约的品牌、门店、岗位、面试时间、地址或状态；禁止对同一工单/同一岗位重复提交报名（候选人报名其它岗位不受影响，正常推进）。',
              '候选人询问该预约、要求改约或取消时，只能自然说明“我正在确认最新预约信息，稍等一下”；不得提及工单、海绵、缓存或系统同步。',
            ].join('\n')
          : '';
      const renderedContexts = [
        ...contexts.map((context) => context.block),
        ...(syncingBlock ? [syncingBlock] : []),
      ];
      const block =
        renderedContexts.length > 0 ? `\n\n[当前预约信息]\n\n${renderedContexts.join('\n\n')}` : '';
      return {
        block,
        // 仅当 block 非空（[当前预约信息] 真进了 system prompt、模型能看到「岗位ID」）才把 jobId
        // 当 provenance：block 为空（工单展示字段全缺）时模型根本看不到该 jobId。
        jobIds: block
          ? contexts
              .map((context) => context.jobId)
              .filter((jobId): jobId is number => jobId != null)
          : [],
      };
    } catch (error) {
      this.logger.warn(
        `加载预约上下文失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { block: '', jobIds: [] };
    }
  }

  /**
   * 预约事实会发生改约、取消和状态推进；相关回合必须绕过 5 分钟缓存读取海绵。
   * currentUserMessage 为空（如主动跟进回合、消息以 assistant 收尾）时走缓存路径。
   */
  private requiresFreshBookingContext(currentUserMessage: string | undefined): boolean {
    if (!currentUserMessage) return false;
    return /面试|预约|报名|改约|改期|改到|换(?:个|一)?时间|取消|不去|去不了|来不了|推迟|延期|迟到|到店|报到|入职/u.test(
      currentUserMessage,
    );
  }

  /** 老用户回访的入口阶段（需在场景策略阶段表中存在才生效）。 */
  private static readonly RETURNING_USER_ENTRY_STAGE = 'job_consultation';

  /**
   * 老用户回访的入口阶段兜底。
   *
   * 长期画像里有身份字段（姓名/电话，主要来自报名成功或会话沉淀写入）即视为
   * 服务过的老用户——回访时跳过信任建立，直接进入岗位咨询。
   * 返回 undefined 表示按新用户处理（兜底到策略第一个阶段）。
   */
  private resolveReturningUserStage(profile: UserProfileFacts | null): string | undefined {
    if (!profile) return undefined;
    const hasIdentity = Boolean(profile.name?.value || profile.phone?.value);
    return hasIdentity ? PreparationService.RETURNING_USER_ENTRY_STAGE : undefined;
  }

  /**
   * 基于 memory recall 构造 memory_snapshot。
   *
   * 字段设计：
   * - currentStage: 本轮入口阶段，用于判定"阶段机器是否走到预期位置"
   * - presentedJobIds / recommendedJobIds: 让排障能看出"模型本轮是否遗忘了上轮推荐过的岗位"
   * - sessionFacts: 扁平化的硬约束（时间/性别/区域等）——Case 2 排障的关键
   * - profileKeys: 长期档案已填字段（不落值避免 PII）
   */
  private buildMemorySnapshot(
    memory: TurnStartMemory,
    entryStage: string | null,
  ): AgentMemorySnapshot {
    const session = memory.sessionMemory;
    const presentedJobIds =
      session?.presentedJobs?.map((j) => j.jobId).filter((id): id is number => id != null) ?? null;
    const recommendedJobIds =
      session?.lastCandidatePool?.map((j) => j.jobId).filter((id): id is number => id != null) ??
      null;

    const sessionFacts = this.flattenSessionFacts(session?.facts ?? null);

    const profile = memory.longTerm.profile;
    const profileKeys = profile
      ? Object.entries(profile)
          .filter(([, value]) => isUserProfileFactValue(value))
          .map(([key]) => key)
      : null;

    return {
      currentStage: entryStage,
      presentedJobIds: presentedJobIds && presentedJobIds.length > 0 ? presentedJobIds : null,
      recommendedJobIds:
        recommendedJobIds && recommendedJobIds.length > 0 ? recommendedJobIds : null,
      sessionFacts,
      profileKeys: profileKeys && profileKeys.length > 0 ? profileKeys : null,
    };
  }

  /** 扁平化 facts.interview_info + facts.preferences，只保留非空字段。 */
  private flattenSessionFacts(
    facts: WeworkSessionState['facts'] | null,
  ): Record<string, unknown> | null {
    if (!facts) return null;
    const flat: Record<string, unknown> = {};
    const collect = (group: Record<string, unknown> | null | undefined, prefix: string) => {
      if (!group) return;
      for (const [key, value] of Object.entries(group)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        flat[`${prefix}.${key}`] = value;
      }
    };
    collect(facts.interview_info as unknown as Record<string, unknown>, 'interview');
    collect(facts.preferences as unknown as Record<string, unknown>, 'pref');
    return Object.keys(flat).length > 0 ? flat : null;
  }
}
