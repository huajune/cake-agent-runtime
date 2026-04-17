import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelMessage, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole, supportsVision } from '@providers/types';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { RecruitmentStageResolverService } from '@biz/recruitment-case/services/recruitment-stage-resolver.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import { MemoryService } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import type { UserProfile } from '@memory/types/long-term.types';
import {
  FALLBACK_EXTRACTION,
  type EntityExtractionResult,
  type RecommendedJobSummary,
  type WeworkSessionState,
} from '@memory/types/session-facts.types';
import { CustomerService } from '@wecom/customer/customer.service';
import { ContextService } from './context/context.service';
import { InputGuardService } from './input-guard.service';
import {
  type AgentInputMessage,
  type AgentInvokeParams,
  type AgentMemorySnapshot,
} from './agent-run.types';

export interface PreparedAgentContext {
  finalPrompt: string;
  typedMessages: ModelMessage[];
  memoryLoadWarning?: string;
  chatModel: ReturnType<RouterService['resolveByRole']>;
  chatModelId: string;
  chatFallbacks?: string[];
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
    private readonly configService: ConfigService,
    private readonly router: RouterService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly recruitmentCaseService: RecruitmentCaseService,
    private readonly recruitmentStageResolver: RecruitmentStageResolverService,
    private readonly memoryService: MemoryService,
    private readonly memoryConfig: MemoryConfig,
    private readonly customerService: CustomerService,
    private readonly context: ContextService,
    private readonly inputGuard: InputGuardService,
  ) {}

  async prepare(
    params: AgentInvokeParams,
    mode: 'invoke' | 'stream',
  ): Promise<PreparedAgentContext> {
    const {
      messages: passedMessages,
      userMessage,
      userId,
      corpId,
      sessionId,
      scenario = 'candidate-consultation',
      maxSteps = 5,
      imageUrls,
      imageMessageIds,
      botUserId,
      externalUserId,
      botImId,
      token,
      imContactId,
      imRoomId,
      apiType,
      modelId: overrideModelId,
    } = params;

    this.logger.log(
      `Agent ${mode}: userId=${userId}, corpId=${corpId}, sessionId=${sessionId}, scenario=${scenario}`,
    );

    const trimmedPassedMessages =
      userMessage === undefined ? this.trimMessages(passedMessages ?? []) : undefined;
    const currentTurnMessages = this.pickCurrentTurnMessages(userMessage, trimmedPassedMessages);
    const shouldLoadShortTerm = userMessage !== undefined || trimmedPassedMessages === undefined;

    // 1. 读取本轮运行时记忆。
    const memory = await this.memoryService.onTurnStart(
      corpId,
      userId,
      sessionId,
      currentTurnMessages,
      {
        includeShortTerm: shouldLoadShortTerm,
      },
    );
    const memoryLoadWarning = memory._warnings?.join('; ') || undefined;

    if (scenario === 'candidate-consultation') {
      await this.supplementGenderFromCustomerDetailIfNeeded(memory, {
        corpId,
        userId,
        token,
        imBotId: botImId,
        imContactId,
        wecomUserId: botUserId,
        externalUserId,
      });
    }

    const activeRecruitmentCase = await this.recruitmentCaseService.getActiveOnboardFollowupCase({
      corpId,
      chatId: sessionId,
    });

    // 2. 决定本轮消息来源。
    //    当 userMessage 存在但短期记忆为空时（DB/缓存瞬时故障），用 userMessage 兜底，
    //    避免 messages 为空导致 AI SDK 抛出 "Invalid prompt: messages must not be empty"。
    let messages: AgentInputMessage[];
    if (userMessage !== undefined) {
      const shortTermMessages = memory.shortTerm.messageWindow;
      if (shortTermMessages.length > 0) {
        messages = shortTermMessages;
      } else {
        const trimmed = userMessage.trim();
        if (trimmed) {
          this.logger.warn(
            `短期记忆为空，使用 userMessage 兜底: sessionId=${sessionId}, len=${trimmed.length}`,
          );
          messages = [{ role: 'user', content: trimmed }];
        } else {
          messages = [];
        }
      }
    } else {
      messages = trimmedPassedMessages ?? [];
    }

    // 3. 安全检查，并统一转换成 ModelMessage。
    const guardResult = this.inputGuard.detectMessages(messages);
    const trimmedOverrideModelId = overrideModelId?.trim();
    const chatModel = trimmedOverrideModelId
      ? this.router.resolve(trimmedOverrideModelId)
      : this.router.resolveByRole(ModelRole.Chat);
    const chatModelId =
      trimmedOverrideModelId ?? this.configService.get<string>('AGENT_CHAT_MODEL') ?? '';
    const chatFallbacks = trimmedOverrideModelId
      ? undefined
      : this.router.getFallbacks(ModelRole.Chat);
    if (trimmedOverrideModelId) {
      this.logger.log(`使用用户指定模型: ${trimmedOverrideModelId}`);
    }
    const typedMessages = this.toModelMessages(messages, supportsVision(chatModelId));

    // 4. 先把长期记忆和会话记忆渲染成统一记忆块。
    //    本轮高置信 / 待确认线索的 partition + 渲染由 TurnHintsSection 负责，这里只传原始数据。
    const profileBlock = this.formatProfile(memory.longTerm.profile);
    const factsBlock = memory.sessionMemory ? this.formatSessionFacts(memory.sessionMemory) : '';
    const recruitmentCaseBlock = this.formatRecruitmentCase(activeRecruitmentCase);
    const memoryBlock = profileBlock + factsBlock + recruitmentCaseBlock;

    // 5. 读取当前阶段，并按场景组装 prompt。
    const resolvedStage =
      this.recruitmentStageResolver.resolve({
        proceduralStage: memory.procedural.currentStage ?? undefined,
        recruitmentCase: activeRecruitmentCase,
        currentMessageContent: this.pickLatestUserContent(messages) ?? userMessage ?? '',
      }) ?? undefined;
    const { systemPrompt, stageGoals, thresholds } = await this.context.compose({
      scenario,
      currentStage: resolvedStage,
      memoryBlock,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      highConfidenceFacts: memory.highConfidenceFacts,
      strategySource: params.strategySource,
    });
    const entryStage = resolvedStage ?? Object.keys(stageGoals)[0] ?? null;

    const turnState: PreparedAgentContext['turnState'] = {
      candidatePool: null,
    };

    // 6. 以 compose 的顺序结果作为最终 system prompt 基底。
    let finalPrompt = systemPrompt;

    // 7. 命中注入风险时，追加 guard suffix，并异步告警。
    if (!guardResult.safe) {
      finalPrompt += InputGuardService.GUARD_SUFFIX;
      const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
      this.inputGuard
        .alertInjection(userId, guardResult.reason!, lastUserMsg?.content ?? '')
        .catch(() => {});
    }

    // 8. Vision 模型下，把顶层图片参数挂到最后一条 user message。
    if (imageUrls?.length && supportsVision(chatModelId)) {
      this.injectImageParts(typedMessages, imageUrls, imageMessageIds);
    }

    // 9. 构建工具上下文，并暂存本轮候选池。
    //    这里同时把 entryStage 和合法阶段列表交给 advance_stage。
    //    工具层只负责“提交阶段变更”，真正的阶段来源仍然是本轮入口阶段 + 当前策略配置。
    const toolContext: ToolBuildContext = {
      userId,
      corpId,
      sessionId,
      messages: typedMessages,
      thresholds,
      imageMessageIds,
      currentStage: entryStage,
      availableStages: Object.keys(stageGoals),
      stageGoals,
      onJobsFetched: async (jobs) => {
        turnState.candidatePool = jobs as RecommendedJobSummary[];
      },
      botUserId,
      contactName: params.contactName,
      botImId,
      strategySource:
        params.strategySource ??
        (corpId === 'test' || corpId === 'debug' ? ('testing' as const) : undefined),
      profile: memory.longTerm.profile,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      currentFocusJob: memory.sessionMemory?.currentFocusJob ?? null,
      token,
      imContactId,
      imRoomId,
      chatId: sessionId,
      apiType,
    };

    // 10. 按场景挑出本轮允许使用的工具。
    const tools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;

    // 11. 记忆快照（供 observability 落入 message_processing_records.memory_snapshot）。
    const memorySnapshot = this.buildMemorySnapshot(memory, entryStage);

    return {
      finalPrompt,
      typedMessages,
      memoryLoadWarning,
      chatModel,
      chatModelId,
      chatFallbacks,
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

  /** 把顶层图片参数挂到最后一条 user message。 */
  private injectImageParts(
    messages: ModelMessage[],
    imageUrls: string[],
    imageMessageIds?: string[],
  ): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const textContent = this.extractTextFromContent(messages[i].content);
        const imageParts = this.buildImageParts(imageUrls, imageMessageIds);
        if (imageParts.length === 0) return;
        const textPart = textContent ? [{ type: 'text' as const, text: String(textContent) }] : [];
        messages[i] = {
          role: 'user',
          content: [...imageParts, ...textPart],
        };
        this.logger.log(`注入 ${imageUrls.length} 张图片到 user message（多模态 vision）`);
        return;
      }
    }
  }

  /** 构建 image parts，并附带可选的图片 messageId 标签。 */
  private buildImageParts(imageUrls: string[], imageMessageIds?: string[]) {
    const validUrls = imageUrls
      .map((url) => {
        try {
          return new URL(url);
        } catch {
          this.logger.warn(`跳过无效的图片 URL: ${url}`);
          return null;
        }
      })
      .filter((url): url is URL => url !== null);

    if (validUrls.length === 0) return [];
    if (imageMessageIds?.length && imageMessageIds.length !== validUrls.length) {
      this.logger.warn(
        `图片 URL 数量(${validUrls.length})与 messageId 数量(${imageMessageIds.length})不一致，将按现有顺序尽力注入`,
      );
    }

    return validUrls.flatMap((url, index) => {
      const messageId = imageMessageIds?.[index];
      const label = messageId
        ? { type: 'text' as const, text: `[图片 messageId=${messageId}]` }
        : null;
      const image = { type: 'image' as const, image: url };
      return label ? [label, image] : [image];
    });
  }

  /** 按字符上限裁剪外部传入的消息。 */
  private trimMessages(messages: AgentInputMessage[]): AgentInputMessage[] {
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

  /** 只取本轮最新的 user 输入，供前置高置信识别使用。 */
  private pickCurrentTurnMessages(
    userMessage?: string,
    messages?: AgentInputMessage[],
  ): AgentInputMessage[] | undefined {
    if (userMessage !== undefined) {
      const content = userMessage.trim();
      return content ? [{ role: 'user', content }] : undefined;
    }

    if (!messages?.length) return undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      const content = this.extractTextFromContent(messages[i].content).trim();
      return content ? [{ role: 'user', content }] : undefined;
    }

    return undefined;
  }

  private pickLatestUserContent(messages: AgentInputMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role !== 'user') continue;
      const content = this.extractTextFromContent(messages[i].content).trim();
      if (content) return content;
    }

    return null;
  }

  private async supplementGenderFromCustomerDetailIfNeeded(
    memory: Awaited<ReturnType<MemoryService['onTurnStart']>>,
    params: {
      corpId: string;
      userId: string;
      token?: string;
      imBotId?: string;
      imContactId?: string;
      wecomUserId?: string;
      externalUserId?: string;
    },
  ): Promise<void> {
    if (this.resolveKnownGender(memory)) {
      return;
    }

    const token = params.token?.trim();
    const imBotId = params.imBotId?.trim();
    const imContactId = params.imContactId?.trim();
    const wecomUserId = params.wecomUserId?.trim();
    const externalUserId = params.externalUserId?.trim();
    const hasSystemLocator = Boolean(imBotId && imContactId);
    const hasWecomLocator = Boolean(wecomUserId && externalUserId);

    if (!token || (!hasSystemLocator && !hasWecomLocator)) {
      return;
    }

    try {
      const detail = await this.customerService.getCustomerDetailV2({
        token,
        imBotId,
        imContactId,
        wecomUserId,
        externalUserId,
      });
      const gender = this.normalizeGenderValue(detail?.data?.gender);

      if (!gender) {
        return;
      }

      await this.memoryService.saveProfile(params.corpId, params.userId, { gender });
      memory.highConfidenceFacts = this.mergeSupplementalGenderFact(
        memory.highConfidenceFacts,
        gender,
      );

      this.logger.log(`客户详情补充性别成功: userId=${params.userId}, gender=${gender}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`客户详情补充性别失败: userId=${params.userId}, error=${errorMessage}`);
    }
  }

  private resolveKnownGender(
    memory: Awaited<ReturnType<MemoryService['onTurnStart']>>,
  ): string | null {
    return (
      this.normalizeGenderValue(memory.longTerm.profile?.gender) ??
      this.normalizeGenderValue(memory.sessionMemory?.facts?.interview_info.gender) ??
      this.normalizeGenderValue(memory.highConfidenceFacts?.interview_info.gender)
    );
  }

  private normalizeGenderValue(value: unknown): '男' | '女' | null {
    if (typeof value === 'number') {
      if (value === 1) return '男';
      if (value === 2) return '女';
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    if (!text) return null;
    if (text === '1') return '男';
    if (text === '2') return '女';
    if (/^(male|man)$/i.test(text)) return '男';
    if (/^(female|woman)$/i.test(text)) return '女';
    if (/(^|[^女])男/.test(text)) return '男';
    if (/女/.test(text)) return '女';
    return null;
  }

  private mergeSupplementalGenderFact(
    existing: EntityExtractionResult | null,
    gender: '男' | '女',
  ): EntityExtractionResult {
    const base: EntityExtractionResult = existing
      ? {
          ...existing,
          interview_info: { ...existing.interview_info },
          preferences: { ...existing.preferences },
        }
      : {
          ...FALLBACK_EXTRACTION,
          interview_info: { ...FALLBACK_EXTRACTION.interview_info },
          preferences: { ...FALLBACK_EXTRACTION.preferences },
        };

    base.interview_info.gender = gender;
    base.reasoning = [base.reasoning?.trim(), `客户详情接口补充性别：${gender}`]
      .filter(Boolean)
      .join('；');

    return base;
  }
}
