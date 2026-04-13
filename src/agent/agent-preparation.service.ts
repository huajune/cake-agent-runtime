import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelMessage, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole, supportsVision } from '@providers/types';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import { MemoryService } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import type { UserProfile } from '@memory/types/long-term.types';
import type { RecommendedJobSummary, WeworkSessionState } from '@memory/types/session-facts.types';
import { ContextService } from './context/context.service';
import { InputGuardService } from './input-guard.service';
import { type AgentInputMessage, type AgentInvokeParams } from './agent-run.types';

export interface PreparedAgentContext {
  finalPrompt: string;
  typedMessages: ModelMessage[];
  memoryLoadWarning?: string;
  chatModel: ReturnType<RouterService['resolveByRole']>;
  tools: ToolSet;
  corpId: string;
  userId: string;
  sessionId: string;
  maxSteps: number;
  /** 本轮入口阶段；来自程序记忆中的持久化 currentStage。 */
  entryStage: string | null;
  /** 本轮临时状态；回合结束时统一交给 memory lifecycle。 */
  turnState: {
    candidatePool: RecommendedJobSummary[] | null;
  };
}

@Injectable()
export class AgentPreparationService {
  private readonly logger = new Logger(AgentPreparationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly router: RouterService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly memoryService: MemoryService,
    private readonly memoryConfig: MemoryConfig,
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
      botImId,
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
    if (trimmedOverrideModelId) {
      this.logger.log(`使用用户指定模型: ${trimmedOverrideModelId}`);
    }
    const typedMessages = this.toModelMessages(messages, supportsVision(chatModelId));

    // 4. 先把长期记忆和会话记忆渲染成统一记忆块。
    //    本轮高置信 / 待确认线索的 partition + 渲染由 TurnHintsSection 负责，这里只传原始数据。
    const profileBlock = this.formatProfile(memory.longTerm.profile);
    const factsBlock = memory.sessionMemory ? this.formatSessionFacts(memory.sessionMemory) : '';
    const memoryBlock = profileBlock + factsBlock;

    // 5. 读取当前阶段，并按场景组装 prompt。
    const rawStage = memory.procedural.currentStage ?? undefined;
    const { systemPrompt, stageGoals, thresholds } = await this.context.compose({
      scenario,
      currentStage: rawStage,
      memoryBlock,
      sessionFacts: memory.sessionMemory?.facts ?? null,
      highConfidenceFacts: memory.highConfidenceFacts,
      strategySource: params.strategySource,
    });
    const entryStage = rawStage ?? Object.keys(stageGoals)[0] ?? null;

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
      botImId,
      strategySource:
        params.strategySource ??
        (corpId === 'test' || corpId === 'debug' ? ('testing' as const) : undefined),
      profile: memory.longTerm.profile,
      sessionFacts: memory.sessionMemory?.facts ?? null,
    };

    // 10. 按场景挑出本轮允许使用的工具。
    const tools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;

    return {
      finalPrompt,
      typedMessages,
      memoryLoadWarning,
      chatModel,
      tools,
      corpId,
      userId,
      sessionId,
      maxSteps,
      entryStage,
      turnState,
    };
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
}
