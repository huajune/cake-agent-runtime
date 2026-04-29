import { Injectable, Logger } from '@nestjs/common';
import { ModelMessage, ToolSet } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { RecruitmentStageResolverService } from '@biz/recruitment-case/services/recruitment-stage-resolver.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import { MemoryService, type CandidateIdentityHint } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import type { UserProfile } from '@memory/types/long-term.types';
import {
  type RecommendedJobSummary,
  type WeworkSessionState,
} from '@memory/types/session-facts.types';
import { ContextService } from './context/context.service';
import { InputGuardService } from './input-guard.service';
import {
  type AgentInputMessage,
  type AgentInvokeParams,
  type AgentMemorySnapshot,
} from './agent-run.types';

export interface PreparedAgentContext {
  finalPrompt: string;
  normalizedMessages: ModelMessage[];
  memoryLoadWarning?: string;
  tools: ToolSet;
  corpId: string;
  userId: string;
  sessionId: string;
  maxSteps: number;
  /** 本轮入口阶段；由 recruitmentCase + procedural currentStage 共同解析出的 effectiveStage。 */
  entryStage: string | null;
  /** 本轮临时状态；回合结束时统一交给 memory lifecycle。 */
  turnState: {
    candidatePool: RecommendedJobSummary[] | null;
  };
  /** 本轮触发时的记忆上下文快照（写入 message_processing_records.memory_snapshot 用于排障） */
  memorySnapshot?: AgentMemorySnapshot;
}

@Injectable()
export class AgentPreparationService {
  private readonly logger = new Logger(AgentPreparationService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly recruitmentCaseService: RecruitmentCaseService,
    private readonly recruitmentStageResolver: RecruitmentStageResolverService,
    private readonly memoryService: MemoryService,
    private readonly memoryConfig: MemoryConfig,
    private readonly context: ContextService,
    private readonly inputGuard: InputGuardService,
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

    // 并行拉取本轮依赖：四类记忆快照 + 仍在跟进的招聘 case。
    const [memory, activeRecruitmentCase] = await Promise.all([
      this.memoryService.onTurnStart(corpId, userId, sessionId, currentUserMessage, {
        includeShortTerm: callerKind === CallerKind.WECOM,
        shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
        enrichmentIdentity: this.buildEnrichmentIdentity(params),
      }),
      this.recruitmentCaseService.getActiveOnboardFollowupCase({
        corpId,
        chatId: sessionId,
      }),
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

    // Compose 的输入：memoryBlock 渲染 + 当前阶段推导（procedural > case > 当前用户输入）
    const memoryBlock = this.buildMemoryBlock(memory, activeRecruitmentCase);
    const stageFromResolver = this.recruitmentStageResolver.resolve({
      proceduralStage: memory.procedural.currentStage ?? undefined,
      recruitmentCase: activeRecruitmentCase,
      currentMessageContent: currentUserMessage ?? '',
    });

    // System prompt 组装（委托 ContextService.compose）
    const { systemPrompt, stageGoals, thresholds } = await this.context.compose({
      scenario,
      currentStage: stageFromResolver ?? undefined,
      memoryBlock,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      highConfidenceFacts: memory.highConfidenceFacts,
      strategySource: params.strategySource,
    });

    // 本轮入口阶段：resolver 能给值就用，否则兜底到策略里第一个 stage（对应"新会话的起点"）
    const entryStage = stageFromResolver ?? Object.keys(stageGoals)[0] ?? null;

    // 工具上下文 + 观测快照（都消费 entryStage）。
    const turnState: PreparedAgentContext['turnState'] = { candidatePool: null };
    const toolContext = this.buildToolContext({
      params,
      memory,
      normalizedMessages,
      entryStage,
      stageGoals,
      thresholds,
      turnState,
    });
    const tools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const memorySnapshot = this.buildMemorySnapshot(memory, entryStage);

    const criticalTurnGuard = this.buildCriticalTurnGuard(currentUserMessage, truncatedMessages);

    return {
      finalPrompt: systemPrompt + guardSuffix + criticalTurnGuard,
      normalizedMessages,
      memoryLoadWarning: memory._warnings?.join('; '),
      tools,
      corpId,
      userId,
      sessionId,
      maxSteps,
      entryStage,
      turnState,
      memorySnapshot,
    };
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
    activeRecruitmentCase: RecruitmentCaseRecord | null,
  ): string {
    return (
      this.formatProfile(memory.longTerm.profile) +
      (memory.sessionMemory ? this.formatSessionFacts(memory.sessionMemory) : '') +
      this.formatRecruitmentCase(activeRecruitmentCase)
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
  }): ToolBuildContext {
    const { params, memory, normalizedMessages, entryStage, stageGoals, thresholds, turnState } =
      input;
    return {
      userId: params.userId,
      corpId: params.corpId,
      sessionId: params.sessionId,
      messages: normalizedMessages,
      thresholds,
      imageMessageIds: params.imageMessageIds,
      visualMessageTypes: params.visualMessageTypes,
      currentStage: entryStage,
      availableStages: Object.keys(stageGoals),
      stageGoals,
      onJobsFetched: async (jobs) => {
        turnState.candidatePool = jobs as RecommendedJobSummary[];
      },
      botUserId: params.botUserId,
      contactName: params.contactName,
      botImId: params.botImId,
      strategySource: params.strategySource,
      profile: memory.longTerm.profile,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      currentFocusJob: memory.sessionMemory?.currentFocusJob ?? null,
      token: params.token,
      imContactId: params.imContactId,
      imRoomId: params.imRoomId,
      chatId: params.sessionId,
      apiType: params.apiType,
    };
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
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
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

  /** 把长期档案渲染成 prompt 片段。 */
  private formatProfile(profile: UserProfile | null): string {
    if (!profile) return '';

    const lines: string[] = [];
    if (profile.name) lines.push(`- 姓名: ${profile.name}`);
    if (profile.phone) lines.push(`- 联系方式: ${profile.phone}`);
    if (profile.gender) lines.push(`- 性别: ${profile.gender}`);
    if (profile.age) lines.push(`- 年龄: ${profile.age}`);
    if (profile.is_student != null) lines.push(`- 是否学生: ${profile.is_student ? '是' : '否'}`);
    if (profile.education) lines.push(`- 学历: ${profile.education}`);
    if (profile.has_health_certificate) lines.push(`- 健康证: ${profile.has_health_certificate}`);

    if (lines.length === 0) return '';
    return `\n\n[用户档案]\n\n${lines.join('\n')}`;
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
      const jobLines = state.lastCandidatePool.map((j, i) => this.formatJobMemoryLine(j, i + 1));
      sections.push(`## 上轮候选岗位池\n${jobLines.join('\n')}`);
    }

    if (state.presentedJobs?.length) {
      const jobLines = state.presentedJobs.map((j, i) => this.formatJobMemoryLine(j, i + 1));
      sections.push(`## 最近已展示岗位\n${jobLines.join('\n')}`);
    }

    if (state.currentFocusJob) {
      sections.push(`## 当前焦点岗位\n${this.formatJobMemoryLine(state.currentFocusJob)}`);
    }

    if (sections.length === 0) return '';
    return `\n\n[会话记忆]\n\n${sections.join('\n\n')}`;
  }

  private formatRecruitmentCase(recruitmentCase: RecruitmentCaseRecord | null): string {
    if (!recruitmentCase) return '';

    const lines = [
      '当前存在一个仍在进行中的面试/上岗跟进 case。',
      recruitmentCase.brand_name ? `品牌: ${recruitmentCase.brand_name}` : null,
      recruitmentCase.store_name ? `门店: ${recruitmentCase.store_name}` : null,
      recruitmentCase.job_name ? `岗位: ${recruitmentCase.job_name}` : null,
      recruitmentCase.interview_time ? `面试时间: ${recruitmentCase.interview_time}` : null,
      recruitmentCase.booking_id ? `预约编号: ${recruitmentCase.booking_id}` : null,
    ].filter((line): line is string => Boolean(line));

    if (lines.length === 0) return '';
    lines.push(
      '当该 case 出现无法推进的阻塞（找不到门店/到店无人接待/预约信息冲突/入职办理异常等）时，必须调用 request_handoff 工具触发人工介入。',
    );
    return `\n\n[当前预约信息]\n\n${lines.join('\n')}`;
  }

  private formatJobMemoryLine(job: RecommendedJobSummary, index?: number): string {
    const head = index ? `${index}. [jobId:${job.jobId}]` : `[jobId:${job.jobId}]`;
    const parts = [head, `品牌:${job.brandName ?? ''} - 岗位:${job.jobName ?? ''}`];

    if (job.storeName) parts.push(`门店:${job.storeName}`);
    if (job.storeAddress) parts.push(`地址:${job.storeAddress}`);
    if (job.cityName || job.regionName) {
      parts.push(`地区:${[job.cityName, job.regionName].filter(Boolean).join('')}`);
    }
    if (job.distanceKm != null) parts.push(`距离:${job.distanceKm.toFixed(1)}km`);
    if (job.laborForm) parts.push(`用工:${job.laborForm}`);
    if (job.salaryDesc) parts.push(`薪资:${job.salaryDesc}`);

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
