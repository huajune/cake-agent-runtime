import { Injectable, Logger, Optional } from '@nestjs/common';
import type { WorkingMemory } from './working-memory.types';
import { ModelMessage, ToolSet } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { decideLaborFormIntent } from '@resolution/labor-form';
import { parseLocationShareCoordinates } from '@resolution/signal/markers';
import { inferCitiesFromGeoSignals } from '@resolution/evidence/producers/city';
import { produceRuleFactClaims } from '@resolution/evidence/producers/rule-track';
import { extractCandidateTextsFromCorpus } from '@resolution/signal/self-report';
import { parseCandidateFieldsFromText } from '@resolution/candidate';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { MemoryService, type CandidateIdentityHint } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import { BrandStateService, type TurnBrandContext } from '@memory/session/brand-state.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { SpongeService } from '@sponge/sponge.service';
import {
  buildJobPolicyAnalysis,
  isOfflineInterviewMethod,
} from '@tools/job-list/job-policy-parser';
import { isUserProfileFactValue, type UserProfileFacts } from '@memory/long-term/long-term.types';
import type { TurnLedger } from '@shared-types/turn.types';
import type { WeworkSessionState } from '@memory/session/session-facts.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { AlertLevel } from '@enums/alert.enum';
import { toErrorMessage } from '@infra/utils/error.util';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { ContextService } from '../context/context.service';
import { PromptInjectionService } from '../../guardrail/input/prompt-injection.service';
import { type GeneratorInvokeParams, type AgentMemorySnapshot } from '../generator.types';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { CRITICAL_TURN_GUARD_RULES } from './critical-turn-guard.rules';
import {
  BOOKING_CONTEXT_SHARED_RULES,
  buildMemoryBlock,
  formatBookingContext,
  type RealtimeGroupStatus,
  type TurnStartMemory,
} from './memory-block.formatter';
import {
  extractTextFromContent,
  normalizeConversationWithCorpus,
  trailingUserContent,
  trailingUserMessages,
  truncateToCharBudget,
} from './conversation-normalizer';
import { buildProactiveDirective } from './revise-directives';
import { resolveToolsForMode, wrapToolsWithTiming } from './tool-set.util';
import { buildToolContext } from './tool-context.builder';
import { createTurnLedger } from './turn-ledger';
import { renderPromptBlocks } from '../context/sections/section.interface';
import type { CorpusBlock, PromptCorpusBlock } from '@shared-types/corpus.types';

export type { WorkingMemory } from './working-memory.types';

/**
 * 回合准备编排：记忆召回 → 消息归一化 → memoryBlock/system prompt 组装 →
 * 工具集构建 → 观测快照。
 *
 * 纯函数辅助层按职责拆在 preparation-utils/ 子目录：memory-block.formatter（记忆渲染）、
 * conversation-normalizer（消息归一化）、revise-directives（主动回合指令）、
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
    private readonly hostingMemberConfig: HostingMemberConfigService,
    @Optional()
    private readonly tracer?: AgentTracerService,
    @Optional()
    private readonly geocoding?: GeocodingService,
    @Optional()
    private readonly alertNotifier?: AlertNotifierService,
  ) {}

  /**
   * 定位分享轮内锚点（候选人资料证据化，badcase 6a6846e2）：候选人本轮发定位时，
   * prep 阶段就逆解析坐标并 seed 进回合账本——A2 的落档在轮末，
   * 若本轮 job_list 直接吃坐标、不调 geocode，invite 城市门四档出处全空仍会误拒。
   * 逆解析走 30 天 Redis 缓存（与 extractFacts A2 同 key，全轮至多一次真实请求）；
   * 失败/服务缺失静默跳过，仅维持既有行为。
   */
  private async seedLocationShareAnchor(
    toolContext: ReturnType<typeof buildToolContext>,
    currentUserMessage: string | undefined,
  ): Promise<void> {
    if (!this.geocoding || !currentUserMessage) return;
    const coords = parseLocationShareCoordinates([currentUserMessage]);
    if (!coords) return;
    try {
      const regeo = await this.geocoding.reverseGeocode(coords.longitude, coords.latitude);
      if (!regeo?.city?.trim()) return;
      toolContext.ledger.recordGeoResolution({
        longitude: coords.longitude,
        latitude: coords.latitude,
        areaLevelQuery: false,
        areaName: null,
        city: regeo.city.trim(),
        district: regeo.district?.trim() || null,
        evidence: `定位分享逆解析：${regeo.formattedAddress || `${regeo.province}${regeo.city}${regeo.district}`}`,
        source: 'location_share',
      });
      this.logger.log(
        `[prepare] 定位分享轮内锚点: city=${regeo.city}（invite 城市门 turn_geocode 档可用）`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[prepare] 定位分享逆解析失败（跳过轮内锚点）: ${message}`);
    }
  }

  async prepare(
    params: GeneratorInvokeParams,
    mode: 'invoke' | 'stream',
    options?: { enableVision?: boolean },
  ): Promise<WorkingMemory> {
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

    // 规则轨在 prep 时刻运行一次，供轮内工具与提取闸门消费（轮末落档前 extractFacts
    // 会带视觉 sheet 对会话段重扫）。输入必须是逐条消息数组（PR #1000 评审 P0-1）：
    // 预 join 会让 `[图片消息]` 占位把整批消息拖进 identity:false 授权域、并击穿
    // 疑问号门等逐消息锚定判据。
    const currentTurnTexts = trailingUserMessages(truncatedMessages);
    const ruleFactsPromise = this.detectRuleFacts(currentTurnTexts);

    // 并行拉取本轮依赖：四类记忆快照 + 当前预约工单上下文 + 实时群状态 + 账号身份配置。
    const [memory, bookingContext, realtimeGroups, accountIdentityConfig] = await Promise.all([
      ruleFactsPromise.then((ruleFacts) =>
        this.memoryService.onTurnStart(corpId, userId, sessionId, currentUserMessage, {
          includeShortTerm: callerKind === CallerKind.WECOM,
          shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
          enrichmentIdentity: this.buildEnrichmentIdentity(params),
          ruleFacts,
        }),
      ),
      // [当前预约信息] 由 active_booking 指针 + 海绵工单实时状态渲染（理由见 loadBookingContext）。
      this.loadBookingContext(
        corpId,
        userId,
        currentUserMessage,
        this.buildSpongeTokenContext(params),
      ),
      this.loadRealtimeGroupStatus(params),
      this.loadAccountIdentity(params.botImId),
    ]);

    // 对话消息归一化为 AI SDK ModelMessage[]（含多模态图片/表情注入）。
    const { messages: normalizedMessages, corpusBlocks: conversationCorpusBlocks } =
      normalizeConversationWithCorpus({
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
    // 不由任何本地 case 状态推导 onboard_followup）。
    const memoryBlock = buildMemoryBlock(
      memory,
      bookingContext.block,
      realtimeGroups,
      params.contactName,
      contactBrandAliases,
      currentLaborFormIntent,
    );
    const persistedStage = memory.stageState.currentStage ?? undefined;
    // 程序性阶段存 Redis（TTL 2 天），过期后若隐式兜底到策略第一个阶段——
    // 已服务过的老候选人回访会被当新客从 trust_building 重走（张漪 case：6-03 已
    // 约面，6-08/6-10 回访都从信任建立重来）。长期画像已有身份字段即视为老用户，
    // 回访直接进入岗位咨询阶段。
    const returningUserStage = persistedStage
      ? undefined
      : this.resolveReturningUserStage(memory.longTerm.semantic.profile);
    const stageFromResolver = persistedStage ?? returningUserStage;

    // System prompt 组装（委托 ContextService.compose）
    const {
      systemPrompt,
      promptBlocks: composedPromptBlocks,
      stageGoals,
      thresholds,
    } = await this.context.compose({
      scenario,
      currentStage: stageFromResolver ?? undefined,
      memoryBlock,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      ruleFacts: memory.ruleFacts,
      currentTurnTexts,
      currentLaborFormIntent,
      sessionBrandState: turnBrandContext.state,
      accountIdentity: {
        botUserId: params.botUserId,
        nickname: accountIdentityConfig.nickname ?? undefined,
        gender: accountIdentityConfig.gender ?? undefined,
      },
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
    const candidateTexts = extractCandidateTextsFromCorpus(conversationCorpusBlocks);
    const ledger = createTurnLedger({
      ruleFacts: memory.ruleFacts,
      laborFormIntent: currentLaborFormIntent,
      collectedFields: parseCandidateFieldsFromText(
        currentUserMessage ? [currentUserMessage] : [],
        Date.now(),
      ),
      geoSignalCities: inferCitiesFromGeoSignals(candidateTexts),
      currentFocusJob: memory.sessionMemory?.currentFocusJob ?? null,
    });
    const toolContext = buildToolContext({
      params,
      memory,
      normalizedMessages,
      conversationCorpusBlocks,
      entryStage,
      stageGoals,
      thresholds,
      ledger,
      contactBrandAliases,
      sessionBrandState: turnBrandContext.state,
      currentUserMessage,
      currentLaborFormIntent,
      bookingWorkOrderJobIds: bookingContext.jobIds,
    });
    await this.seedLocationShareAnchor(toolContext, currentUserMessage);
    const toolExecutionTimings = new Map<string, number>();
    const scenarioTools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const tools = wrapToolsWithTiming(
      resolveToolsForMode(scenarioTools, params.toolMode ?? 'scenario', params.allowedToolNames),
      toolExecutionTimings,
      this.tracer,
    );
    const memorySnapshot = this.buildMemorySnapshot(memory, entryStage);

    const criticalTurnGuard = this.buildCriticalTurnGuard(currentUserMessage, normalizedMessages);
    const proactiveDirective = buildProactiveDirective(params);

    // 测试替身/旧调用方可能只返回 systemPrompt；生产 ContextService 始终给出逐块标签。
    const basePromptBlocks =
      composedPromptBlocks?.length > 0
        ? composedPromptBlocks
        : [this.createTeachingPromptBlock('system-prompt', systemPrompt)];
    const promptBlocks = [
      ...basePromptBlocks,
      ...[
        this.createTeachingPromptBlock('input-guard', guardSuffix),
        this.createTeachingPromptBlock('critical-turn-guard', criticalTurnGuard),
        this.createTeachingPromptBlock('proactive-directive', proactiveDirective),
      ].filter((block) => block.content.length > 0),
    ];

    const finalPrompt = renderPromptBlocks(promptBlocks);
    this.checkFinalPromptBloat(finalPrompt, { sessionId, userId, scenario });

    return {
      finalPrompt,
      promptBlocks,
      normalizedMessages,
      conversationCorpusBlocks,
      memoryLoadWarning: memory._warnings?.join('; '),
      tools,
      corpId,
      userId,
      sessionId,
      botImId: params.botImId,
      maxSteps,
      entryStage,
      ledger,
      contactName: params.contactName,
      memorySnapshot,
      toolExecutionTimings,
    };
  }

  private createTeachingPromptBlock(id: string, content: string): PromptCorpusBlock {
    return { id, domain: 'teaching', role: 'system', content: content.trim() };
  }

  /**
   * finalPrompt 膨胀哨兵（治理方案 P0-2 / 防腐机制 F4）：出口测长，超阈值飞书告警。
   *
   * 历史上"张漪 case"的 27K evidence 膨胀靠 badcase 反查才发现——组装出口此前
   * 无测长、无告警，任何一处渲染失控都只能等对话质量劣化后倒查。阈值取实测
   * p-max（~43K 字符）上浮：超过 60K 即说明某个 section/记忆块渲染跑飞。
   * 告警自带节流（AlertNotifier throttle + dedupe），不会刷屏；发送失败不影响主链路。
   */
  private checkFinalPromptBloat(
    finalPrompt: string,
    scope: { sessionId: string; userId: string; scenario: string },
  ): void {
    const FINAL_PROMPT_BLOAT_THRESHOLD_CHARS = 60_000;
    if (finalPrompt.length <= FINAL_PROMPT_BLOAT_THRESHOLD_CHARS) return;
    this.logger.warn(
      `[prepare] finalPrompt 膨胀: length=${finalPrompt.length} > ${FINAL_PROMPT_BLOAT_THRESHOLD_CHARS}, sessionId=${scope.sessionId}`,
    );
    void this.alertNotifier
      ?.sendAlert({
        code: 'agent.prompt_bloat',
        severity: AlertLevel.WARNING,
        summary: `finalPrompt 长度 ${finalPrompt.length} 字符，超过 ${FINAL_PROMPT_BLOAT_THRESHOLD_CHARS} 阈值（正常 p-max ~43K）`,
        source: { subsystem: 'agent', component: 'preparation', action: 'prepare' },
        scope: { sessionId: scope.sessionId, userId: scope.userId, scenario: scope.scenario },
        dedupe: { key: 'agent.prompt_bloat' },
      })
      .catch((error) => {
        this.logger.warn(`[prepare] finalPrompt 膨胀告警发送失败: ${toErrorMessage(error)}`);
      });
  }

  /** 当前轮规则 producer（prep 运行点）：产物随 ledger 穿过工具与轮末收编。 */
  private async detectRuleFacts(currentUserMessages: string[]) {
    const texts = currentUserMessages.map((text) => text.trim()).filter(Boolean);
    if (texts.length === 0) return null;
    const brandData = await this.spongeService.fetchBrandList();
    const facts = produceRuleFactClaims(texts, brandData);
    if (facts) this.logger.debug(`前置规则识别命中: ${facts.reasoning}`);
    return facts;
  }

  /**
   * 把本轮最容易复发的事故规则追加到 system prompt 最末尾。
   *
   * 这些规则不是替代主 prompt，而是把“当前消息已经命中”的禁令放到最后，
   * 避免模型在长上下文里先承认规则、最后又被阶段策略带回收资或预约。
   * 规则本体（badcase 驱动的正则 + 禁令文案）维护在 critical-turn-guard.rules.ts。
   *
   * `combined` 的近邻窗口取 **normalizedMessages**（含短期记忆窗口）而非 params.messages：
   * WECOM 生产路径 runner 只构造一条当前 user 消息，完整历史由 memory 层加载进
   * normalizedMessages——用 params.messages 时 combined ≡ current，4 条 target='combined'
   * 的规则（health_cert_is_not_major / post_interview_no_rebook /
   * salary_account_no_fabricated_policy / location_reference_needs_grounding）在生产只剩
   * "候选人单轮消息内命中全部 patterns"一种触发方式，其文案自证依赖的跨轮场景
   * （"即使历史助手说过专业不符"、"近邻上下文显示候选人已在面试"）全部漏过，
   * 而 test-suite/debug 传完整历史时按设计工作——测试覆盖的语义 ≠ 生产语义
   * （core-flow-review 议题 6-1）。test-suite/debug 行为不变：其 normalizedMessages
   * 与 params.messages 同源。
   */
  private buildCriticalTurnGuard(
    currentUserMessage: string | undefined,
    messages: readonly ModelMessage[],
  ): string {
    const current = currentUserMessage ?? '';
    const recent = messages
      .slice(-12)
      .map((message) => `${message.role}: ${extractTextFromContent(message.content)}`)
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
   * 账号身份配置（企微昵称/性别，hosting_member_config 按 botImId 索引）：
   * 供 IdentitySection 锚定"你就是这个账号本人"。读失败按未配置降级，不阻断回合。
   */
  private async loadAccountIdentity(
    botImId: string | undefined,
  ): Promise<{ nickname: string | null; gender: string | null }> {
    try {
      return await this.hostingMemberConfig.resolveAgentAccountIdentity(botImId);
    } catch (error) {
      this.logger.warn(
        `账号身份配置读取失败（按未配置降级）: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { nickname: null, gender: null };
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
      if (activeBookings.length === 0) {
        // B-5 报名空头宣称接地（badcase zvey1mg8/as1f14iz/5wglb8k7：零 booking 调用却对候选人
        // 宣称"已帮你报好/已登记好"）。无工单时明示 ground truth，让完成口径必须以本轮工具结果
        // 为据。注意段名必须区别于 [当前预约信息]——后者的**存在性**被多个工具指令当作"已有
        // 预约"信号（如 request_handoff "存在时必须调用"），空状态复用同名段会毒化这些判断。
        return {
          block:
            '\n\n[预约状态]\n\n当前候选人没有任何进行中的报名/预约工单。' +
            '严禁使用"已帮你报名/已报名成功/已登记好/已提交预约"等完成口径描述报名状态；' +
            '只有本轮 duliday_interview_booking 返回 success 后，才能向候选人确认报名成功。',
          jobIds: [],
        };
      }

      const requiresFreshLookup = this.requiresFreshBookingContext(currentUserMessage);
      const requiresLocationDetails = this.requiresBookingLocationDetails(currentUserMessage);
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
            const normalizedJobId = this.normalizeJobId(workOrder?.jobId);
            let location:
              | { storeAddress?: string; interviewMethod?: string; interviewAddress?: string }
              | undefined;
            if (requiresLocationDetails && normalizedJobId != null) {
              try {
                const detail = await this.spongeService.fetchJobs(
                  {
                    jobIdList: [normalizedJobId],
                    pageNum: 1,
                    pageSize: 1,
                    onlySignableJobs: false,
                    options: { includeBasicInfo: true, includeInterviewProcess: true },
                  },
                  tokenContext,
                );
                const job = detail.jobs[0];
                if (job) {
                  const storeAddress =
                    typeof job.basicInfo?.storeInfo?.storeAddress === 'string'
                      ? job.basicInfo.storeInfo.storeAddress.trim()
                      : undefined;
                  const interviewMeta = buildJobPolicyAnalysis(job).interviewMeta;
                  const interviewMethod = interviewMeta.method ?? undefined;
                  const interviewAddress = isOfflineInterviewMethod(interviewMethod)
                    ? (interviewMeta.address ?? undefined)
                    : undefined;
                  location = { storeAddress, interviewMethod, interviewAddress };
                }
              } catch (error) {
                this.logger.warn(
                  `加载预约地址详情失败 workOrderId=${workOrderId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
            }
            return { workOrderId, workOrder, location, fetchFailed: false };
          } catch (error) {
            this.logger.warn(
              `加载单个预约工单上下文失败 workOrderId=${workOrderId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return { workOrderId, workOrder: null, location: undefined, fetchFailed: true };
          }
        }),
      );

      const contexts: Array<{ block: string; jobId: number | null }> = [];
      let fetchFailedCount = 0;
      for (const { workOrderId, workOrder, location, fetchFailed } of lookups) {
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
        const block = formatBookingContext(workOrder, contexts.length + 1, location);
        const normalizedJobId = this.normalizeJobId(workOrder.jobId);
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
      // 通用处理规则只渲染一次（P1-2）：有 ≥1 个预约块时才附加；仅剩同步中提示
      // （contexts 为空）时规则引用的「岗位ID」「面试时间」都不存在，维持原先不渲染的行为。
      const renderedContexts = [
        ...contexts.map((context) => context.block),
        ...(contexts.length > 0 ? [BOOKING_CONTEXT_SHARED_RULES] : []),
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
    return /面试|预约|报名|改约|改期|改到|换(?:个|一)?时间|取消|不去|去不了|来不了|推迟|延期|迟到|到店|报到|入职|地址|位置|定位|导航|怎么走|找不到|搞错/u.test(
      currentUserMessage,
    );
  }

  private requiresBookingLocationDetails(currentUserMessage: string | undefined): boolean {
    return Boolean(
      currentUserMessage &&
        /面试|到店|报到|地址|位置|定位|导航|怎么走|找不到|搞错/u.test(currentUserMessage),
    );
  }

  private normalizeJobId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
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

    const profile = memory.longTerm.semantic.profile;
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
      currentFocusJob: this.buildFocusJobSnapshot(session?.currentFocusJob ?? null),
    };
  }

  private buildFocusJobSnapshot(
    job: RecommendedJobSummary | null,
  ): AgentMemorySnapshot['currentFocusJob'] {
    if (!job) return null;

    const availableDetailFields: NonNullable<
      AgentMemorySnapshot['currentFocusJob']
    >['availableDetailFields'] = [];
    if (job.salaryDesc) availableDetailFields.push('salary');
    if (job.settlementSummary) availableDetailFields.push('settlement');
    if (job.shiftSummary) availableDetailFields.push('shift');
    if (job.welfareFacts) availableDetailFields.push('welfare');
    if (job.ageRequirement) availableDetailFields.push('age_requirement');
    if (job.educationRequirement) availableDetailFields.push('education_requirement');
    if (job.healthCertificateRequirement) {
      availableDetailFields.push('health_certificate_requirement');
    }
    if (job.studentRequirement) availableDetailFields.push('student_requirement');
    if (job.storeAddress) availableDetailFields.push('address');
    if (job.laborForm || job.partTimeJobType) availableDetailFields.push('employment');
    return { jobId: job.jobId, availableDetailFields };
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
