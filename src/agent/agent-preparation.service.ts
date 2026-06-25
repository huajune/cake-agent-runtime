import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage, ToolSet } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import { sanitizeJobDisplayText, sanitizeLaborFormForDisplay } from '@memory/facts/labor-form';
import {
  detectBrandAliasHints,
  filterHighConfidenceFacts,
  unwrapHighConfidenceFacts,
} from '@memory/facts/high-confidence-facts';
import { MemoryService, type CandidateIdentityHint } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import { LongTermService } from '@memory/services/long-term.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { SpongeService } from '@sponge/sponge.service';
import type { SignupWorkOrderItem } from '@sponge/sponge.types';
import {
  isUserProfileFactValue,
  type LongTermPreferenceFacts,
  type UserProfileFacts,
  unwrapUserProfileFacts,
} from '@memory/types/long-term.types';
import {
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type RecommendedJobSummary,
  type WeworkSessionState,
  unwrapSessionFacts,
} from '@memory/types/session-facts.types';
import { ContextService } from './context/context.service';
import { InputGuardService } from './input-guard.service';
import {
  type AgentInputMessage,
  type AgentInvokeParams,
  type AgentMemorySnapshot,
  type ToolMode,
} from './agent-run.types';

interface RealtimeGroupStatus {
  groupName: string;
  city: string;
}

const SIDE_EFFECT_TOOL_NAMES = new Set([
  'duliday_interview_booking',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
  'invite_to_group',
  'send_store_location',
  'raise_risk_alert',
  'request_handoff',
]);

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
  };
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

@Injectable()
export class AgentPreparationService {
  private readonly logger = new Logger(AgentPreparationService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly memoryService: MemoryService,
    private readonly memoryConfig: MemoryConfig,
    private readonly context: ContextService,
    private readonly inputGuard: InputGuardService,
    private readonly longTermService: LongTermService,
    private readonly spongeService: SpongeService,
    private readonly groupResolver: GroupResolverService,
    private readonly groupMembership: GroupMembershipService,
  ) {}

  async prepare(
    params: AgentInvokeParams,
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
    const truncatedMessages = this.truncateToCharBudget(params.messages);
    const currentUserMessage = this.trailingUserContent(truncatedMessages);

    // 并行拉取本轮依赖：四类记忆快照 + 当前预约工单上下文 + 实时群状态。
    const [memory, bookingContext, realtimeGroups] = await Promise.all([
      this.memoryService.onTurnStart(corpId, userId, sessionId, currentUserMessage, {
        includeShortTerm: callerKind === CallerKind.WECOM,
        shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
        enrichmentIdentity: this.buildEnrichmentIdentity(params),
      }),
      // [当前预约信息] 改由 latest_booking 指针 + 海绵工单实时状态渲染（不再依赖 recruitment_cases 本地字段）。
      this.loadBookingContext(corpId, userId, this.buildSpongeTokenContext(params)),
      this.loadRealtimeGroupStatus(params),
    ]);

    // 对话消息归一化为 AI SDK ModelMessage[]（含多模态图片/表情注入）。
    const normalizedMessages = this.normalizeConversation({
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

    // Compose 的输入：memoryBlock 渲染 + 当前阶段（直接取程序性记忆 currentStage；
    // recruitment_cases 已废弃，不再由 case 推导 onboard_followup）。
    const memoryBlock = this.buildMemoryBlock(
      memory,
      bookingContext.block,
      realtimeGroups,
      params.contactName,
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
    const turnState: PreparedAgentContext['turnState'] = { candidatePool: null };
    const contactBrandAliases = await this.deriveContactBrandAliases(params.contactName);
    const toolContext = this.buildToolContext({
      params,
      memory,
      normalizedMessages,
      entryStage,
      stageGoals,
      thresholds,
      turnState,
      contactBrandAliases,
      bookingWorkOrderJobId: bookingContext.jobId,
    });
    const toolExecutionTimings = new Map<string, number>();
    const scenarioTools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const tools = this.wrapToolsWithTiming(
      this.resolveToolsForMode(scenarioTools, params.toolMode ?? 'scenario'),
      toolExecutionTimings,
    );
    const memorySnapshot = this.buildMemorySnapshot(memory, entryStage);

    const criticalTurnGuard = this.buildCriticalTurnGuard(currentUserMessage, truncatedMessages);
    const reviseNotice = this.buildReviseNotice(params);
    const proactiveDirective = this.buildProactiveDirective(params);

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
      memorySnapshot,
      toolExecutionTimings,
    };
  }

  /**
   * 给工具集的 execute 包一层真实计时（按 AI SDK 传入的 toolCallId 记录）。
   *
   * 没有这层时，观测里的工具耗时只能用"步骤墙钟"近似——它包含 LLM 思考与输出时间，
   * 曾导致 skip_reply 这类纯本地工具在流水里显示平均 7s+，无法区分模型慢还是外部 API 慢。
   */
  private wrapToolsWithTiming(tools: ToolSet, timings: Map<string, number>): ToolSet {
    const wrapped: ToolSet = {};
    for (const [name, toolDef] of Object.entries(tools)) {
      const execute = (toolDef as { execute?: unknown }).execute;
      if (typeof execute !== 'function') {
        wrapped[name] = toolDef;
        continue;
      }
      wrapped[name] = {
        ...toolDef,
        execute: async (...args: unknown[]) => {
          const startedAt = Date.now();
          try {
            return await (execute as (...callArgs: unknown[]) => unknown).apply(toolDef, args);
          } finally {
            const options = args[1] as { toolCallId?: string } | undefined;
            if (options?.toolCallId) {
              timings.set(options.toolCallId, Date.now() - startedAt);
            } else {
              // AI SDK execute(input, options) 签名变更会走到这里：计时静默失效，
              // durationMs 退回墙钟近似。打日志便于升级 SDK 后发现。
              this.logger.warn(
                `[tool-timing] 工具 ${name} 执行选项缺少 toolCallId，真实计时未记录`,
              );
            }
          }
        },
      } as ToolSet[string];
    }
    return wrapped;
  }

  private resolveToolsForMode(tools: ToolSet, mode: ToolMode): ToolSet {
    if (mode === 'scenario') return tools;
    if (mode === 'none') return {};

    const readonlyTools: ToolSet = {};
    for (const [name, toolDef] of Object.entries(tools)) {
      if (!SIDE_EFFECT_TOOL_NAMES.has(name)) {
        readonlyTools[name] = toolDef;
      }
    }
    return readonlyTools;
  }

  /**
   * 取本轮用户输入：末尾连续的 user 块（到上一条 assistant 为止），以换行合并。
   *
   * 为什么不只取最后一条：合并请求（WeCom replay、test-suite 多条连发）下，
   * 末尾可能连续多条 user 且尚未有 assistant 打断。只取最后一条会让下游的
   * 高置信事实提取、阶段推断、guard 告警文本漏掉前面几条的内容。
   */
  private trailingUserContent(messages: AgentInputMessage[]): string | undefined {
    const collected: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const role = messages[i].role;
      if (role === 'user') {
        const content = messages[i].content?.trim();
        if (content) collected.unshift(content);
        continue;
      }
      if (role === 'assistant') break;
    }
    return collected.length > 0 ? collected.join('\n') : undefined;
  }

  /**
   * 把本轮最容易复发的事故规则追加到 system prompt 最末尾。
   *
   * 这些规则不是替代主 prompt，而是把“当前消息已经命中”的禁令放到最后，
   * 避免模型在长上下文里先承认规则、最后又被阶段策略带回收资或预约。
   */
  private buildCriticalTurnGuard(
    currentUserMessage: string | undefined,
    messages: AgentInputMessage[],
  ): string {
    const current = currentUserMessage ?? '';
    const recent = messages
      .slice(-12)
      .map((message) => `${message.role}: ${message.content ?? ''}`)
      .join('\n');
    const combined = `${recent}\n${current}`;
    const guards: string[] = [];

    if (
      /每周.{0,6}(最多|至多|只能|只).{0,4}[一二两三四五六七八九十\d]+天|做一休一|只周末|下班后|[一二两三四五六七八九十\d]+点才(?:能)?下班|现在决定不了时间|不上夜班/.test(
        current,
      )
    ) {
      guards.push(
        '本轮候选人补充或重复了出勤/班次硬约束。最终回复在本轮工具校验前严禁说“资料都收到了/资料已收到/没问题/可以/备注上/资料备注/后面安排/随时发我再安排/到时候沟通/先把资料录上”，也严禁继续追问身高、体重、住址、支援意愿等收资字段。必须先用 duliday_interview_precheck 或 duliday_job_list(includeWorkTime=true) 校验当前岗位；若当前岗位不明确或没有本轮工具结果，只能说明“这个时间/每周出勤属于硬约束，需要先按班次核岗位是否匹配”，然后再询问岗位/位置用于筛选，不能基于历史助手话术直接断言“门店面试最晚到5点/今天来不及/等确定了再安排”或说资料已收好。若候选人问“6点下班还能不能面试”，未校验前必须回复“我先按下班后/晚班可约来核岗位”，不能直接给可约或不可约结论。',
      );
    }

    if (
      /(?:\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|下周[一二三四五六日天]?|这?周[一二三四五六日天]|周[一二三四五六日天]).{0,12}(回来)?面试.{0,8}(可以|行|方便|吗)|面试.{0,12}(?:\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|下周[一二三四五六日天]?|这?周[一二三四五六日天]|周[一二三四五六日天])|(?:\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|下周[一二三四五六日天]?|这?周[一二三四五六日天]|周[一二三四五六日天]).{0,8}(上午|下午|晚上|[一二两三四五六七八九十\d]+点)?.{0,8}(可以|行吗|方便|能不能)/.test(
        current,
      )
    ) {
      guards.push(
        '本轮候选人指定了面试日期。未调用 duliday_interview_precheck(requestedDate=候选人指定日期) 前，最终回复严禁说“可以/能约/通常可以/一般可以/帮你登记/帮你预约”，也不要催更近日期、改成其他日期时间或继续收整套资料。若 jobId/当前岗位不明确，先确认门店/岗位，不能直接承诺该日期可约；若 job_list 没查到当前岗位，也只能先确认门店/岗位。',
      );
    }

    if (/健康证/.test(combined) && /专业|食品|新媒体|填写错误|职业/.test(combined)) {
      guards.push(
        '本轮涉及“健康证”和“专业筛选”。健康证只代表证件，不代表候选人的专业；即使历史助手说过专业不符，也不能把“有食品健康证”当成“食品专业”。最终回复必须先澄清“你实际专业是什么”，严禁直接拒绝预约或复述“食品/新媒体专业不符”，也不要声称已拉群，除非本轮 invite_to_group 成功。',
      );
    }

    if (
      /已面试|面试通过|通过了|入职|报到|培训|店长.{0,8}联系|只能一家店|选[^，。！？\n]{0,8}店|先去[^，。！？\n]{0,8}面试/.test(
        combined,
      )
    ) {
      guards.push(
        '近邻上下文显示候选人已在面试/入职/只能保留一家店/门店已联系的跟进状态。最终回复严禁重新问“哪天方便面试”、重新收资、重新预约或继续推荐；需要处理状态、门店选择、异常或图片信息时，优先 request_handoff。若无 active case，也只能说让同事确认。',
      );
    }

    if (
      /1[3-9]\d{9}/.test(current) &&
      /大专|本科|中专|高中|学历|年龄|岁|时间|周[一二三四五六日天]|下午|上午/.test(current)
    ) {
      guards.push(
        '本轮候选人已经提交了报名/预约资料。最终回复必须先确认已收到姓名、电话、年龄、学历、面试时间等已给字段；候选人给了“周三下午/明天下午/具体日期时间”时必须原样承接，严禁擅自改成周四、两点或其他时间。严禁让候选人重填整套模板，也严禁回到“发地址/哪个区/查附近岗位”的入口。若当前岗位缺失，只能确认报名岗位/门店，不要改问住址。',
      );
    }

    if (/银行卡|工资|扣税|税务|本人卡|别人卡|房贷|起诉|没几块钱|没啥税/.test(combined)) {
      guards.push(
        '本轮在讨论银行卡/税务/发薪主体。若没有本轮工具或明确岗位规则，最终回复严禁说“总部统一规定/公司统一流程/公司统一走账/统一流程/财务流程统一/按平台规则走/没法绕过/个人操作不了/必须/一定/不管多少/门店也按规定办事”，也严禁说“面试时问门店/让门店同事问问/现场沟通/灵活处理/特殊处理/变通”。只能说“通常需要本人账户，具体以岗位或同事确认”。候选人因银行卡异常、被起诉、房贷断供等无法本人卡发薪时，必须 request_handoff 或说明让同事确认；最终回复不要反问附近岗位/在聊的店/要不要看岗位，也不要继续强推约面。',
      );
    }

    if (/\[位置分享\]|经纬度|这是我住的地方|住处|地址|附近/.test(combined)) {
      guards.push(
        '近邻上下文包含位置线索。若最终回复要引用“刚才那家/这家/那个奥乐齐/附近岗位”等具体推荐，必须写清门店名或地址，并且事实来自本轮 duliday_job_list、当前焦点岗位或当前预约信息。若历史推荐只有品牌/距离/薪资而缺门店/地址，不能继续用“这家”承接，必须重新查岗或先补清门店/地址。',
      );
    }

    if (guards.length === 0) return '';

    return `\n\n# 本轮动态硬禁令\n${guards.map((guard) => `- ${guard}`).join('\n')}`;
  }

  /**
   * HC-1：把 revise 回路的违规意见 / 已提交副作用摘要拼到 system prompt 末尾。
   *
   * - committedSideEffects（配 toolMode:'none' 无工具重写）：告知模型副作用已生效、
   *   只改措辞，既不声称未发生也不重复执行；
   * - reviseFeedback：把出站守卫的违规意见喂回，让模型只修正这些问题。
   *
   * 二者均为可选；都缺省时返回空串，不影响普通回合。
   */
  private buildReviseNotice(params: AgentInvokeParams): string {
    const parts: string[] = [];

    const committed = params.committedSideEffects?.trim();
    if (committed) {
      parts.push(
        `本轮的副作用动作已经执行并生效（${committed}），既成事实，不可撤销也不可重复执行。` +
          `请基于这一事实重写本轮回复：只修正措辞与合规问题，` +
          `严禁声称未发生、严禁再次执行任何操作（系统本轮已物理移除相关工具）。`,
      );
    }

    if (params.reviseFeedback?.length) {
      const lines = params.reviseFeedback.map(
        (v) => `- [${v.type}] 问题：${v.evidence}；应改为：${v.suggestion}`,
      );
      parts.push(
        `上一版回复被出站守卫拦下，存在以下需修正的问题。请只针对这些问题重写一版回复，` +
          `不要改变已确认的事实、不要新增承诺：\n${lines.join('\n')}`,
      );
    }

    if (parts.length === 0) return '';
    return `\n\n# 回复重写要求（HC-1）\n${parts.join('\n\n')}`;
  }

  /**
   * reengagement 主动回合 directive 注入。
   *
   * 告诉模型本回合是系统发起的主动跟进、目标是什么；话术由模型按记忆/上下文实时生成。
   * 强调主动回合的边界：只提醒/答疑，不替候选人报名/拉群（副作用工具已由 toolMode:'readonly'
   * 物理移除，这里再用 prompt 重申，双保险）。被动回合不传，返回空串。
   */
  private buildProactiveDirective(params: AgentInvokeParams): string {
    const directive = params.proactiveDirective?.trim();
    if (!directive) return '';
    return (
      `\n\n# 主动跟进回合（reengagement）\n` +
      `本回合不是候选人发来的消息，而是系统按既定场景发起的主动跟进。跟进目标：${directive}\n` +
      `要求：① 自然、简短、不骚扰，像真人招募经理顺手关心一句；② 只做提醒/答疑，` +
      `严禁替候选人报名/拉群/改约（这些动作只能由候选人本人在后续对话里推进）；` +
      `③ 若记忆显示候选人已报名/已转人工/已明确拒绝，则不要发起跟进。`
    );
  }

  /**
   * 装配候选人画像富化所需的身份标识。
   * 仅在 candidate-consultation 场景 + 有 token 时触发外部补全。
   */
  private buildEnrichmentIdentity(params: AgentInvokeParams): CandidateIdentityHint | undefined {
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
    params: AgentInvokeParams,
  ): { botImId?: string; botUserId?: string; groupId?: string } | undefined {
    if (!params.botImId && !params.botUserId && !params.groupId) return undefined;
    return {
      botImId: params.botImId,
      botUserId: params.botUserId,
      groupId: params.groupId,
    };
  }

  /**
   * 把本轮对话归一化为 AI SDK 的 ModelMessage[]：
   *   1. 按 callerKind 选定消息源（WECOM 用 memory 历史，其他用调用方直传的）
   *   2. 转成 ModelMessage
   *   3. 按需注入顶层图片 parts（多模态 vision）
   */
  private normalizeConversation(input: {
    callerKind: CallerKind;
    memoryWindow: AgentInputMessage[];
    passedMessages: AgentInputMessage[];
    enableVision: boolean;
    imageUrls?: string[];
    imageMessageIds?: string[];
    visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
  }): ModelMessage[] {
    const source =
      input.callerKind === CallerKind.WECOM ? input.memoryWindow : input.passedMessages;
    const normalized = this.toModelMessages(source, input.enableVision);
    if (input.imageUrls?.length && input.enableVision) {
      this.injectImageParts(
        normalized,
        input.imageUrls,
        input.imageMessageIds,
        input.visualMessageTypes,
      );
    }
    return normalized;
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
    const guardResult = this.inputGuard.detectMessages(normalizedMessages);
    if (guardResult.safe) return '';
    this.inputGuard
      .alertInjection(userId, guardResult.reason!, currentUserMessage ?? '')
      .catch(() => {});
    return InputGuardService.GUARD_SUFFIX;
  }

  /**
   * 把本轮相关记忆渲染成 ContextService.compose 能直接消费的 memoryBlock 字符串。
   */
  private buildMemoryBlock(
    memory: Awaited<ReturnType<MemoryService['onTurnStart']>>,
    bookingContext: string,
    realtimeGroups: RealtimeGroupStatus[] = [],
    contactName?: string,
  ): string {
    return (
      this.formatCrossConversationNotice(memory.longTerm.origin?.fromOtherConversation ?? false) +
      this.formatContactNamePreferenceHint(contactName) +
      this.formatProfile(memory.longTerm.profile) +
      this.formatLongTermPreferences(memory.longTerm.preferences ?? null) +
      (memory.sessionMemory ? this.formatSessionFacts(memory.sessionMemory) : '') +
      this.formatRealtimeGroups(realtimeGroups) +
      bookingContext
    );
  }

  /**
   * 跨会话来源口径。双 bot 服务同一候选人时，本轮注入的长期画像/意向可能来自
   * 候选人此前在另一段会话（另一位招募经理）的沉淀——下面的身份/意向不是"你和
   * TA 聊过"的记录。给模型一段泛指口径，避免假装是本会话的延续。
   */
  private formatCrossConversationNotice(fromOtherConversation: boolean): string {
    if (!fromOtherConversation) return '';
    return (
      `\n\n[历史背景｜来自候选人此前在本平台的咨询]\n\n` +
      `_下面的身份与求职意向，来自候选人**此前在本平台与另一位招聘顾问**的沟通沉淀，` +
      `**不是你和 TA 本次/此前的聊天记录**。开场可自然衔接（例如"看到你之前在我们平台咨询过…"），` +
      `但不要假装是你们之前聊过、也不要点名是哪位同事。_`
    );
  }

  /**
   * 企微显示名称/备注常被运营改成「姓名 城市品牌门店」结构，标记这位候选人是
   * 冲着哪个品牌/门店来的——这是运营给本会话指定的目标品牌，不是可有可无的背景。
   *
   * 这里不做程序化解析，只把原文交给模型理解，但要求把读出的品牌当作默认目标：
   * - 能读出品牌+门店：默认带该品牌召回，并在结果里优先该门店；
   * - 只能读出品牌：默认带该品牌召回；
   * - 读不出 / 候选人改口指定别的品牌 / 带该品牌召回为空：才放宽。
   */
  private formatContactNamePreferenceHint(contactName: string | undefined): string {
    const normalized = contactName
      ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';

    const clipped = normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
    return (
      `\n\n[企微名称备注｜运营给本会话指定的目标品牌/门店]\n\n` +
      `- 企微显示名称/备注：${clipped}\n` +
      `- 运营常把「城市+品牌+门店」写进名称，标记这位候选人是冲着哪个品牌/门店来的。请结合上下文判断其中的品牌、门店、城市（可能也夹杂姓名等无关标记）。\n` +
      `- **默认把读出的品牌当作本会话的目标品牌**：调用 duliday_job_list 召回时默认带上它（用 brandIdList/brandAliasList），推荐时优先该品牌的门店——**不要因为别的品牌门店离得更近就改推别家**。能同时读出门店的，在该品牌结果里优先挑这家门店或最近门店（备注门店名常与库内实名对不上，别直接塞 storeNameList 硬过滤，而是召回该品牌后在结果里挑）。\n` +
      `- 例外（以候选人为准）：候选人本轮主动指定了别的品牌、明确说不想要这个品牌、或要求「看看其他品牌/所有岗位」时跟随候选人；带该品牌召回为空时再放宽到不限品牌。\n` +
      `- 品牌名本身含城市词不代表候选人所在城市（如“成都你六姐”的“成都”是品牌名一部分），不要仅凭品牌名推断城市。\n` +
      `- 这是内部线索：回复里禁止提及“备注/企微名称/昵称显示”，也不要称呼候选人昵称。`
    );
  }

  /**
   * 从企微名称备注里确定性解析目标品牌标准名。
   *
   * 纯提示词驱动「备注品牌优先」经实测不可靠（模型会忽略备注按距离推），故在 prep 阶段
   * 用与候选人消息相同的品牌词典匹配器（detectBrandAliasHints）把备注里的品牌抠出来，
   * 交给 duliday_job_list 在模型没传品牌时确定性兜底（见 ToolBuildContext.contactBrandAliases）。
   *
   * 失败/无命中/无备注一律返回空数组（按"无目标品牌"降级，不阻断主流程）。
   */
  private async deriveContactBrandAliases(contactName: string | undefined): Promise<string[]> {
    const normalized = contactName?.trim();
    if (!normalized) return [];
    try {
      const brandData = await this.spongeService.fetchBrandList();
      if (!brandData?.length) return [];
      const hints = detectBrandAliasHints([normalized], brandData);
      return Array.from(new Set(hints.map((hint) => hint.brandName)));
    } catch (error) {
      this.logger.warn('备注品牌解析失败（按无目标品牌降级）', error);
      return [];
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
  private async loadRealtimeGroupStatus(params: AgentInvokeParams): Promise<RealtimeGroupStatus[]> {
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

  /** 渲染实时群状态段；空数组（含核验失败）不渲染。 */
  private formatRealtimeGroups(groups: RealtimeGroupStatus[]): string {
    if (groups.length === 0) return '';
    const lines = groups.map(
      (group, index) => `${index + 1}. ${group.groupName}（城市: ${group.city}）`,
    );
    return (
      `\n\n[候选人当前所在兼职群]\n\n` +
      `_以下为实时核验结果（非记忆）。候选人已在这些群内：禁止调用 invite_to_group 再次邀请，` +
      `也不要承诺"拉你进群"；候选人问群相关问题时直接按"你已经在 X 群里了"口径回应。_\n` +
      lines.join('\n')
    );
  }

  /**
   * 组装工具上下文。entryStage / availableStages 交给 advance_stage 使用；
   * onJobsFetched 回调把本轮候选池暂存到 turnState，交给 onTurnEnd 落盘。
   */
  private buildToolContext(input: {
    params: AgentInvokeParams;
    memory: Awaited<ReturnType<MemoryService['onTurnStart']>>;
    normalizedMessages: ModelMessage[];
    entryStage: string | null;
    stageGoals: Awaited<ReturnType<ContextService['compose']>>['stageGoals'];
    thresholds: Awaited<ReturnType<ContextService['compose']>>['thresholds'];
    turnState: PreparedAgentContext['turnState'];
    contactBrandAliases: string[];
    /** 当前进行中预约工单的 jobId（改约场景 system prompt 暴露给模型的「岗位ID」），并入 provenance 集。 */
    bookingWorkOrderJobId: number | null;
  }): ToolBuildContext {
    const {
      params,
      memory,
      normalizedMessages,
      entryStage,
      stageGoals,
      thresholds,
      turnState,
      contactBrandAliases,
      bookingWorkOrderJobId,
    } = input;
    const recentBrandPool = this.collectRecentBrandPool(memory.sessionMemory);
    // jobId provenance 闸门数据源：turn-start 已召回岗位集 + 进行中预约工单 jobId（改约路径）
    // + 本轮 job_list 抓取的候选池（turnState.candidatePool 由 onJobsFetched 实时写入），
    // 供 precheck/booking 判定 jobId 是否有出处。
    const turnStartRecalledJobIds = this.collectRecentJobIds(memory.sessionMemory);
    if (bookingWorkOrderJobId != null) turnStartRecalledJobIds.add(bookingWorkOrderJobId);
    const highConfidenceSessionFacts = unwrapSessionFacts(memory.sessionMemory?.facts ?? null, {
      minConfidence: 'high',
    });
    const sessionFacts = this.mergeSessionFactsWithHighConfidence(
      highConfidenceSessionFacts,
      memory.highConfidenceFacts,
    );
    return {
      userId: params.userId,
      corpId: params.corpId,
      sessionId: params.sessionId,
      messages: normalizedMessages,
      thresholds,
      imageMessageIds: params.imageMessageIds,
      imageUrls: params.imageUrls,
      visualMessageTypes: params.visualMessageTypes,
      currentStage: entryStage,
      availableStages: Object.keys(stageGoals),
      stageGoals,
      onJobsFetched: async (jobs) => {
        turnState.candidatePool = jobs as RecommendedJobSummary[];
      },
      botUserId: params.botUserId,
      contactName: params.contactName,
      contactBrandAliases,
      botImId: params.botImId,
      groupId: params.groupId,
      strategySource: params.strategySource,
      profile: unwrapUserProfileFacts(memory.longTerm.profile, { minConfidence: 'high' }),
      sessionFacts,
      highConfidenceFacts: memory.highConfidenceFacts,
      currentFocusJob: memory.sessionMemory?.currentFocusJob ?? null,
      recentBrandPool,
      isRecalledJobId: (jobId: number) =>
        turnStartRecalledJobIds.has(jobId) ||
        (turnState.candidatePool?.some((j) => j.jobId === jobId) ?? false),
      token: params.token,
      imContactId: params.imContactId,
      imRoomId: params.imRoomId,
      chatId: params.sessionId,
      apiType: params.apiType,
      turnId: params.messageId,
    };
  }

  /**
   * 把本轮高置信识别结果（interview_info）叠加到上一轮 sessionFacts 上，
   * 让工具（如 precheck）能拿到当前消息里刚提供的候选人字段（年龄/姓名/电话等）。
   * 非 null 的高置信值覆盖旧值，null 不覆盖。
   */
  private mergeSessionFactsWithHighConfidence(
    sessionFacts: EntityExtractionResult | null,
    highConfidence: HighConfidenceFacts | null,
  ): EntityExtractionResult | null {
    const highConfidenceValues = unwrapHighConfidenceFacts(
      filterHighConfidenceFacts(highConfidence),
    );
    if (!highConfidenceValues) return sessionFacts;
    if (!sessionFacts) return highConfidenceValues;

    const merged = { ...sessionFacts };

    // interview_info: 非 null 的高置信值覆盖旧值
    const baseInfo = { ...sessionFacts.interview_info };
    const hcInfo = highConfidenceValues.interview_info;
    for (const key of Object.keys(hcInfo) as Array<keyof typeof hcInfo>) {
      if (hcInfo[key] != null) {
        (baseInfo as Record<string, unknown>)[key] = hcInfo[key];
      }
    }
    merged.interview_info = baseInfo;

    // preferences: 非 null 的高置信值覆盖旧值
    const basePref = { ...sessionFacts.preferences };
    const hcPref = highConfidenceValues.preferences;
    for (const key of Object.keys(hcPref) as Array<keyof typeof hcPref>) {
      if (hcPref[key] != null) {
        (basePref as Record<string, unknown>)[key] = hcPref[key];
      }
    }
    merged.preferences = basePref;

    return merged;
  }

  /**
   * 汇总本会话最近推荐过的品牌名（去重，按出现顺序保留）。
   *
   * 取 presentedJobs（真正发给候选人的岗位）+ lastCandidatePool（最近一次工具结果），
   * 并把 currentFocusJob 的品牌也带上。供 duliday_job_list 做品牌别名同音回指匹配。
   */
  private collectRecentBrandPool(
    session: Awaited<ReturnType<MemoryService['onTurnStart']>>['sessionMemory'],
  ): string[] {
    if (!session) return [];
    const ordered = [
      ...(session.presentedJobs ?? []),
      ...(session.lastCandidatePool ?? []),
      ...(session.currentFocusJob ? [session.currentFocusJob] : []),
    ];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const job of ordered) {
      const brand = job?.brandName?.trim();
      if (!brand) continue;
      if (seen.has(brand)) continue;
      seen.add(brand);
      result.push(brand);
    }
    return result;
  }

  /**
   * 汇总本会话 turn-start 已召回/展示过的全部 jobId（presentedJobs ∪ lastCandidatePool ∪
   * currentFocusJob，去重）。供 precheck/booking 的 jobId provenance 闸门判定"模型传入的 jobId
   * 是否有合法来源"——集合为空即本会话从未召回任何岗位，此时任何 jobId 都属凭空生成。
   */
  private collectRecentJobIds(
    session: Awaited<ReturnType<MemoryService['onTurnStart']>>['sessionMemory'],
  ): Set<number> {
    const ids = new Set<number>();
    if (!session) return ids;
    const ordered = [
      ...(session.presentedJobs ?? []),
      ...(session.lastCandidatePool ?? []),
      ...(session.currentFocusJob ? [session.currentFocusJob] : []),
    ];
    for (const job of ordered) {
      if (typeof job?.jobId === 'number') ids.add(job.jobId);
    }
    return ids;
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
    memory: Awaited<ReturnType<MemoryService['onTurnStart']>>,
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
    return hasIdentity ? AgentPreparationService.RETURNING_USER_ENTRY_STAGE : undefined;
  }

  /** 把长期档案渲染成 prompt 片段。 */
  private formatProfile(profile: UserProfileFacts | null): string {
    if (!profile) return '';

    const lines: string[] = [];
    if (profile.name)
      lines.push(`- 姓名: ${profile.name.value}${this.formatProfileFactMeta(profile.name)}`);
    if (profile.phone)
      lines.push(`- 联系方式: ${profile.phone.value}${this.formatProfileFactMeta(profile.phone)}`);
    if (profile.gender)
      lines.push(`- 性别: ${profile.gender.value}${this.formatProfileFactMeta(profile.gender)}`);
    if (profile.age)
      lines.push(`- 年龄: ${profile.age.value}${this.formatProfileFactMeta(profile.age)}`);
    if (profile.is_student)
      lines.push(
        `- 是否学生: ${profile.is_student.value ? '是' : '否'}${this.formatProfileFactMeta(profile.is_student)}`,
      );
    if (profile.education)
      lines.push(
        `- 学历: ${profile.education.value}${this.formatProfileFactMeta(profile.education)}`,
      );
    if (profile.has_health_certificate)
      lines.push(
        `- 健康证: ${profile.has_health_certificate.value}${this.formatProfileFactMeta(profile.has_health_certificate)}`,
      );

    if (lines.length === 0) return '';
    return `\n\n[用户档案]\n\n${lines.join('\n')}`;
  }

  private formatProfileFactMeta(value: {
    confidence: string;
    source: string;
    evidence: string;
    updatedAt: string;
  }): string {
    // evidence 是排障字段，不注入 prompt：提取 reasoning 全文曾随每个字段重复注入，
    // 单轮 system prompt 被撑到 27K+ 字符（张漪 case）。更新时间保留日期部分，
    // 让模型能判断档案信息的新旧。
    const updatedDate = value.updatedAt?.slice(0, 10) || value.updatedAt;
    return `（置信度: ${value.confidence}，来源: ${value.source}，更新于: ${updatedDate}）`;
  }

  /**
   * 把长期求职意向渲染成 prompt 片段。
   *
   * 这是 settlement 沉淀的上一段求职会话的意向快照——历史参考，不是当前事实：
   * 标注记录日期并明确"以本次会话为准"，避免重蹈旧会话事实复活的覆辙。
   * available_after 已过期（日期早于今天）的直接不渲染。
   */
  private formatLongTermPreferences(preferences: LongTermPreferenceFacts | null): string {
    if (!preferences) return '';

    const labels: Record<string, string> = {
      city: '意向城市',
      district: '意向区域',
      location: '意向地点',
      brands: '意向品牌',
      position: '意向岗位',
      schedule: '意向班次',
      salary: '意向薪资',
      labor_form: '用工形式',
      schedule_constraint: '排班硬约束',
      delayed_intent: '推迟意向',
      available_after: '最早可面日期',
    };

    const lines: string[] = [];
    let latestUpdatedAt = '';
    for (const [key, label] of Object.entries(labels)) {
      const fact = preferences[key as keyof LongTermPreferenceFacts];
      if (!fact || fact.value === null || fact.value === undefined) continue;

      const rendered = this.renderPreferenceValue(key, fact.value);
      if (!rendered) continue;

      lines.push(`- ${label}: ${rendered}`);
      if (fact.updatedAt > latestUpdatedAt) latestUpdatedAt = fact.updatedAt;
    }

    if (lines.length === 0) return '';
    const recordedDate = latestUpdatedAt ? latestUpdatedAt.slice(0, 10) : '未知时间';
    return (
      `\n\n[历史求职意向]\n\n` +
      `_以下是候选人上一段求职会话沉淀的意向（记录于 ${recordedDate}），仅供参考承接；` +
      `候选人本次会话表达的新意向一律优先，不一致时以本次为准，不要拿旧意向反驳候选人。_\n` +
      lines.join('\n')
    );
  }

  /** 渲染单个长期意向值；返回 null 表示该字段不应注入（如已过期）。 */
  private renderPreferenceValue(key: string, value: unknown): string | null {
    if (Array.isArray(value)) {
      return value.length > 0 ? value.map(String).join('、') : null;
    }
    if (key === 'available_after' && typeof value === 'object' && value !== null) {
      const fact = value as { date?: string; raw?: string };
      if (!fact.date) return null;
      // 过期的"最早可面日期"不再注入
      const today = new Date().toISOString().slice(0, 10);
      if (fact.date < today) return null;
      return `${fact.date}（原话: ${fact.raw ?? ''}）`;
    }
    if (key === 'delayed_intent' && typeof value === 'object' && value !== null) {
      const fact = value as { until?: string; raw?: string };
      if (!fact.until) return null;
      return `${fact.until}（原话: ${fact.raw ?? ''}）`;
    }
    if (key === 'schedule_constraint' && typeof value === 'object' && value !== null) {
      const c = value as {
        onlyWeekends?: boolean | null;
        onlyEvenings?: boolean | null;
        onlyMornings?: boolean | null;
        maxDaysPerWeek?: number | null;
      };
      const parts: string[] = [];
      if (c.onlyWeekends) parts.push('只周末');
      if (c.onlyEvenings) parts.push('只晚班');
      if (c.onlyMornings) parts.push('只早班');
      if (c.maxDaysPerWeek) parts.push(`每周最多${c.maxDaysPerWeek}天`);
      return parts.length > 0 ? parts.join('、') : null;
    }
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    return null;
  }

  /** 把会话记忆渲染成 prompt 片段。 */
  private formatSessionFacts(state: WeworkSessionState): string {
    const sections: string[] = [];

    if (state.facts) {
      const factLines = formatExtractionFactLines(state.facts);

      if (factLines.length > 0) {
        sections.push(`## 候选人已知信息\n${factLines.join('\n')}`);
      }
    }

    if (state.lastCandidatePool?.length) {
      // 渲染上限对齐 presentedJobs 的 slice(0,10)：候选池是唯一写入端无 cap 的池子
      // （工具单页 20 条且可能放宽），全量渲染会让 memoryBlock 无界膨胀。
      // Redis 中仍保留全量池供 jobId 复用/品牌回指匹配。
      const MAX_POOL_LINES = 10;
      const pool = state.lastCandidatePool.slice(0, MAX_POOL_LINES);
      const jobLines = pool.map((j, i) => this.formatJobMemoryLine(j, i + 1));
      const omitted = state.lastCandidatePool.length - pool.length;
      const omittedNote =
        omitted > 0 ? `\n（另有 ${omitted} 个候选岗位未展示，可通过工具重新查询）` : '';
      sections.push(`## 上轮候选岗位池\n${jobLines.join('\n')}${omittedNote}`);
    }

    if (state.presentedJobs?.length) {
      const jobLines = state.presentedJobs.map((j, i) => this.formatJobMemoryLine(j, i + 1));
      sections.push(`## 最近已展示岗位\n${jobLines.join('\n')}`);
    }

    if (state.currentFocusJob) {
      sections.push(`## 当前焦点岗位\n${this.formatJobMemoryLine(state.currentFocusJob)}`);
    }

    if (state.invitedGroups?.length) {
      // 历史 badcase 3g1ruov9 / 6vzw8oh3：本会话拉过群但记忆里漏渲染，Agent 看不到导致重复拉群。
      // 触发 invite_to_group 工具时本字段已写入 session 记忆，这里把它注入 prompt 让 Agent 主动避让。
      const groupLines = state.invitedGroups.map((g, i) => {
        const industry = g.industry ? `（${g.industry}）` : '';
        return `${i + 1}. ${g.groupName}${industry} - 城市: ${g.city}, 邀请时间: ${g.invitedAt}`;
      });
      sections.push(
        `## 本会话已邀入的兼职群（禁止重复拉群）\n${groupLines.join('\n')}\n\n_命中以上任一群时，禁止再次调用 invite_to_group；候选人本轮再次同意入群/暗示想进群时，直接告知"之前已经把你拉到 X 群了，可以查看一下手机微信"即可。_`,
      );
    }

    if (sections.length === 0) return '';
    return `\n\n[会话记忆]\n\n${sections.join('\n\n')}`;
  }

  /**
   * 渲染 [当前预约信息]：latest_booking 指针 + 海绵工单实时状态。
   *
   * 不再读 recruitment_cases 本地字段（历史 booking_id 全 NULL、状态与海绵脱节）。
   * 任意一步失败/无指针/查不到工单时返回空串（优雅降级，不阻断本轮）。
   */
  private async loadBookingContext(
    corpId: string,
    userId: string,
    tokenContext?: { botImId?: string; botUserId?: string; groupId?: string },
  ): Promise<{ block: string; jobId: number | null }> {
    try {
      const latestBooking = await this.longTermService.getLatestBooking(corpId, userId);
      const workOrderId = latestBooking?.latest_work_order_id;
      if (workOrderId == null) return { block: '', jobId: null };

      const workOrder = tokenContext
        ? await this.spongeService.getCachedWorkOrderById(workOrderId, tokenContext)
        : await this.spongeService.getCachedWorkOrderById(workOrderId);
      if (!workOrder) return { block: '', jobId: null };

      // workOrder.jobId 也是 provenance 合法来源：改约场景下 system prompt 把它作为「岗位ID」
      // 暴露给模型并指示先 precheck 校验新日期，但改约不调 job_list，故必须并入召回集，
      // 否则 isRecalledJobId 恒 false 把每次改约都误拦成 job_not_provided。
      const block = this.formatBookingContext(workOrder);
      // jobId 口径必须与 formatBookingContext 渲染「岗位ID」时一致（它用 != null，接受数字串）：
      // Upstash 反序列化旧缓存可能把 jobId 给成字符串，若这里只认 number 会出现「prompt 里渲染了
      // 岗位ID: 5678、但 provenance 判 null」→ isRecalledJobId(5678)=false 把改约永久卡死。
      // 故统一归一为 number（数字串也接受），再受 block 非空约束。
      const normalizedJobId =
        typeof workOrder.jobId === 'number'
          ? workOrder.jobId
          : typeof workOrder.jobId === 'string' && /^\d+$/.test(workOrder.jobId)
            ? Number(workOrder.jobId)
            : null;
      return {
        block,
        // 仅当 block 非空（[当前预约信息] 真进了 system prompt、模型能看到「岗位ID」）才把 jobId
        // 当 provenance：block 为空（工单展示字段全缺）时模型根本看不到该 jobId，放行它等于留下
        // 一个静默绕过闸门的口子（模型若恰好编中该 jobId 就被误判为有出处）。
        jobId: block ? normalizedJobId : null,
      };
    } catch (error) {
      this.logger.warn(
        `加载预约上下文失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { block: '', jobId: null };
    }
  }

  private formatBookingContext(workOrder: SignupWorkOrderItem): string {
    const displayJobName = sanitizeJobDisplayText(workOrder.jobName ?? null);
    const businessLines = [
      workOrder.brandName ? `品牌: ${workOrder.brandName}` : null,
      workOrder.projectName ? `门店/项目: ${workOrder.projectName}` : null,
      displayJobName ? `岗位: ${displayJobName}` : null,
      workOrder.currentStatus ? `当前状态: ${workOrder.currentStatus}` : null,
      workOrder.signUpTime ? `报名时间: ${workOrder.signUpTime}` : null,
      workOrder.interviewPassTime ? `面试通过时间: ${workOrder.interviewPassTime}` : null,
    ].filter((line): line is string => Boolean(line));

    // 仅有标题行 + 工单号（无任何业务字段）时不渲染，避免给 Agent 一个空壳 case。
    if (businessLines.length === 0) return '';

    // 岗位ID 单独渲染：改约前 Agent 要用它调 duliday_interview_precheck 校验新日期是否可约。
    const lines = [
      '当前存在一个仍在进行中的面试/上岗跟进 case（状态实时取自海绵工单系统）。',
      `工单号: ${workOrder.workOrderId}`,
      workOrder.jobId != null ? `岗位ID: ${workOrder.jobId}` : null,
      ...businessLines,
    ].filter((line): line is string => Boolean(line));

    lines.push(
      '候选人主动要求改约面时间时：先用上面的「岗位ID」调 duliday_interview_precheck(requestedDate=候选人想改到的新日期) 校验新日期是否可约——只有返回 interview.requestedDate.status=available（nextAction 不是 date_unavailable）时，才用「工单号」调 duliday_modify_interview_time 自助改约；若 precheck 判该日期不可约，则把 precheck 返回的可约时段（scheduleRule / upcomingTimeOptions）抛给候选人继续协商重选，不要转人工。主动要求取消时调 duliday_cancel_work_order 自助取消。改约/取消工具自身提交失败时，再按 request_handoff(modify_appointment) 转人工。',
      '当该 case 出现无法推进的阻塞（找不到门店/到店无人接待/预约信息冲突/入职办理异常等）时，必须调用 request_handoff 工具触发人工介入。',
    );
    return `\n\n[当前预约信息]\n\n${lines.join('\n')}`;
  }

  private formatJobMemoryLine(job: RecommendedJobSummary, index?: number): string {
    const head = index ? `${index}. [jobId:${job.jobId}]` : `[jobId:${job.jobId}]`;
    const parts = [
      head,
      `品牌:${job.brandName ?? ''} - 岗位:${sanitizeJobDisplayText(job.jobName) ?? ''}`,
    ];

    if (job.storeName) parts.push(`门店:${job.storeName}`);
    if (job.storeAddress) parts.push(`地址:${job.storeAddress}`);
    if (job.cityName || job.regionName) {
      parts.push(`地区:${[job.cityName, job.regionName].filter(Boolean).join('')}`);
    }
    if (job.distanceKm != null) parts.push(`距离:${job.distanceKm.toFixed(1)}km`);
    const displayLaborForm = sanitizeLaborFormForDisplay(job.laborForm);
    if (displayLaborForm) parts.push(`用工:${displayLaborForm}`);
    if (job.salaryDesc) parts.push(`薪资:${job.salaryDesc}`);
    if (job.shiftSummary) parts.push(`班次:${job.shiftSummary}`);

    const bookingConstraint = this.formatBookingConstraint(job);
    if (bookingConstraint) parts.push(`约面要求:${bookingConstraint}`);

    return parts.join(' | ');
  }

  private formatBookingConstraint(job: RecommendedJobSummary): string | null {
    const constraints: string[] = [];

    if (job.ageRequirement && job.ageRequirement !== '不限') {
      constraints.push(`年龄${job.ageRequirement}`);
    }
    if (job.educationRequirement && job.educationRequirement !== '不限') {
      constraints.push(`学历${job.educationRequirement}`);
    }
    if (
      job.healthCertificateRequirement &&
      job.healthCertificateRequirement !== '未明确要求' &&
      job.healthCertificateRequirement !== '不限'
    ) {
      constraints.push(`健康证${job.healthCertificateRequirement}`);
    }
    if (job.studentRequirement) {
      constraints.push(`学生${job.studentRequirement}`);
    }

    if (constraints.length === 0) return null;
    return constraints.join('，');
  }

  /** 转成 AI SDK 的 ModelMessage，并兼容图片回退文本。 */
  private toModelMessages(messages: AgentInputMessage[], enableVision: boolean): ModelMessage[] {
    return messages.map((message) => {
      const textContent = this.extractTextFromContent(message.content);
      if (message.role === 'user' && message.imageUrls?.length) {
        if (enableVision) {
          const imageParts = this.buildImageParts(message.imageUrls, message.imageMessageIds);
          const textPart = textContent
            ? [{ type: 'text' as const, text: String(textContent) }]
            : [];
          return {
            role: 'user',
            content: [...imageParts, ...textPart],
          };
        }

        const fallbackText =
          message.imageUrls.length === 1
            ? '[图片消息]'
            : `[图片消息 ${message.imageUrls.length} 张]`;
        return {
          role: 'user',
          content: textContent ? `${fallbackText} ${textContent}` : fallbackText,
        };
      }

      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: textContent,
        };
      }

      if (message.role === 'system') {
        return {
          role: 'system',
          content: textContent,
        };
      }

      return {
        role: 'user',
        content: textContent,
      };
    });
  }

  /** 把顶层图片/表情参数挂到最后一条 user message。 */
  private injectImageParts(
    messages: ModelMessage[],
    imageUrls: string[],
    imageMessageIds?: string[],
    visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>,
  ): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const textContent = this.extractTextFromContent(messages[i].content);
        const imageParts = this.buildImageParts(imageUrls, imageMessageIds, visualMessageTypes);
        if (imageParts.length === 0) return;
        const textPart = textContent ? [{ type: 'text' as const, text: String(textContent) }] : [];
        messages[i] = {
          role: 'user',
          content: [...imageParts, ...textPart],
        };
        this.logger.log(`注入 ${imageUrls.length} 张图片/表情到 user message（多模态 vision）`);
        return;
      }
    }
  }

  /** 构建 image parts，并附带可选的图片/表情 messageId 标签。 */
  private buildImageParts(
    imageUrls: string[],
    imageMessageIds?: string[],
    visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>,
  ) {
    const validUrls = imageUrls
      .map((url) => {
        try {
          return new URL(url);
        } catch {
          this.logger.warn(`跳过无效的图片/表情 URL: ${url}`);
          return null;
        }
      })
      .filter((url): url is URL => url !== null);

    if (validUrls.length === 0) return [];
    if (imageMessageIds?.length && imageMessageIds.length !== validUrls.length) {
      this.logger.warn(
        `图片/表情 URL 数量(${validUrls.length})与 messageId 数量(${imageMessageIds.length})不一致，将按现有顺序尽力注入`,
      );
    }

    return validUrls.flatMap((url, index) => {
      const messageId = imageMessageIds?.[index];
      const kindName =
        messageId && visualMessageTypes?.[messageId] === MessageType.EMOTION ? '表情' : '图片';
      const label = messageId
        ? { type: 'text' as const, text: `[${kindName} messageId=${messageId}]` }
        : null;
      const image = { type: 'image' as const, image: url };
      return label ? [label, image] : [image];
    });
  }

  /**
   * 按字符预算裁剪消息窗口：总字符数超限时，从最早的消息开始丢弃，保留最新的若干条，
   * 直到剩余消息总字符数 ≤ sessionWindowMaxChars。
   */
  private truncateToCharBudget(messages: AgentInputMessage[]): AgentInputMessage[] {
    const maxChars = this.memoryConfig.sessionWindowMaxChars;
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    if (totalChars <= maxChars) return messages;

    this.logger.warn(`输入消息总长度 ${totalChars} 超过上限 ${maxChars}，将丢弃最早的消息`);

    const kept: { role: string; content: string }[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgLen = messages[i].content?.length ?? 0;
      if (charCount + msgLen > maxChars && kept.length > 0) break;
      kept.unshift(messages[i]);
      charCount += msgLen;
    }

    this.logger.warn(`保留最近 ${kept.length}/${messages.length} 条消息，共 ${charCount} 字符`);
    return kept;
  }
}
