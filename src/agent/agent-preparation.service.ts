import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelMessage, ToolSet } from 'ai';
import { RouterService } from '@providers/router.service';
import { ModelRole, supportsVision } from '@providers/types';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ToolBuildContext } from '@shared-types/tool.types';
import { MemoryService } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import type { UserProfile } from '@memory/types/long-term.types';
import type {
  EntityExtractionResult,
  InterviewInfo,
  Preferences,
  RecommendedJobSummary,
  WeworkSessionState,
} from '@memory/types/session-facts.types';
import { ContextService } from './context/context.service';
import { InputGuardService } from './input-guard.service';
import { type AgentInputMessage, type AgentInvokeParams } from './agent-run.types';

export interface PreparedAgentContext {
  finalPrompt: string;
  typedMessages: ModelMessage[];
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

    // 2. 决定本轮消息来源。
    const messages =
      userMessage !== undefined ? memory.shortTerm.messageWindow : (trimmedPassedMessages ?? []);

    // 3. 安全检查，并统一转换成 ModelMessage。
    const guardResult = this.inputGuard.detectMessages(messages);
    const chatModel = this.router.resolveByRole(ModelRole.Chat);
    const chatModelId = this.configService.get<string>('AGENT_CHAT_MODEL') || '';
    const typedMessages = this.toModelMessages(messages, supportsVision(chatModelId));

    // 4. 先把长期记忆和会话记忆渲染成统一记忆块。
    const profileBlock = this.formatProfile(memory.longTerm.profile);
    const factsBlock = memory.sessionMemory ? this.formatSessionFacts(memory.sessionMemory) : '';
    const { normalHints, pendingHints } = this.partitionHighConfidenceFacts(
      memory.sessionMemory?.facts ?? null,
      memory.highConfidenceFacts,
    );
    const highConfidenceBlock = normalHints ? this.formatHighConfidenceFacts(normalHints) : '';
    const pendingConfirmationBlock = pendingHints
      ? this.formatPendingConfirmationFacts(pendingHints)
      : '';
    const memoryBlock = profileBlock + factsBlock + highConfidenceBlock + pendingConfirmationBlock;

    // 5. 读取当前阶段，并按场景组装 prompt。
    const rawStage = memory.procedural.currentStage ?? undefined;
    const { systemPrompt, stageGoals, thresholds } = await this.context.compose({
      scenario,
      currentStage: rawStage,
      memoryBlock,
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
    };

    // 10. 按场景挑出本轮允许使用的工具。
    const tools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;

    return {
      finalPrompt,
      typedMessages,
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
      const factLines = this.formatExtractionFactLines(state.facts);

      if (factLines.length > 0) {
        sections.push(`## 候选人已知信息\n${factLines.join('\n')}`);
      }
    }

    if (state.lastCandidatePool?.length) {
      const jobLines = state.lastCandidatePool.map((j, i) => {
        const parts = [
          `${i + 1}. [jobId:${j.jobId}]`,
          `品牌:${j.brandName ?? ''} - 岗位:${j.jobName ?? ''}`,
        ];
        if (j.storeName) parts.push(`门店:${j.storeName}`);
        if (j.cityName || j.regionName) {
          parts.push(`地区:${[j.cityName, j.regionName].filter(Boolean).join('')}`);
        }
        if (j.laborForm) parts.push(`用工:${j.laborForm}`);
        if (j.salaryDesc) parts.push(`薪资:${j.salaryDesc}`);
        return parts.join(' | ');
      });
      sections.push(`## 上轮候选岗位池\n${jobLines.join('\n')}`);
    }

    if (state.presentedJobs?.length) {
      const jobLines = state.presentedJobs.map((j, i) => {
        const parts = [
          `${i + 1}. [jobId:${j.jobId}]`,
          `品牌:${j.brandName ?? ''} - 岗位:${j.jobName ?? ''}`,
        ];
        if (j.storeName) parts.push(`门店:${j.storeName}`);
        if (j.cityName || j.regionName) {
          parts.push(`地区:${[j.cityName, j.regionName].filter(Boolean).join('')}`);
        }
        if (j.laborForm) parts.push(`用工:${j.laborForm}`);
        if (j.salaryDesc) parts.push(`薪资:${j.salaryDesc}`);
        return parts.join(' | ');
      });
      sections.push(`## 最近已展示岗位\n${jobLines.join('\n')}`);
    }

    if (state.currentFocusJob) {
      const j = state.currentFocusJob;
      const parts = [`[jobId:${j.jobId}]`, `品牌:${j.brandName ?? ''} - 岗位:${j.jobName ?? ''}`];
      if (j.storeName) parts.push(`门店:${j.storeName}`);
      if (j.cityName || j.regionName) {
        parts.push(`地区:${[j.cityName, j.regionName].filter(Boolean).join('')}`);
      }
      if (j.laborForm) parts.push(`用工:${j.laborForm}`);
      if (j.salaryDesc) parts.push(`薪资:${j.salaryDesc}`);
      sections.push(`## 当前焦点岗位\n${parts.join(' | ')}`);
    }

    if (sections.length === 0) return '';
    return `\n\n[会话记忆]\n\n${sections.join('\n\n')}`;
  }

  /** 把结构化提取结果渲染成统一字段列表。 */
  private formatExtractionFactLines(facts: NonNullable<WeworkSessionState['facts']>): string[] {
    const { interview_info: info, preferences: pref } = facts;
    const lines: string[] = [];

    if (info.name) lines.push(`- 姓名: ${info.name}`);
    if (info.phone) lines.push(`- 联系方式: ${info.phone}`);
    if (info.gender) lines.push(`- 性别: ${info.gender}`);
    if (info.age) lines.push(`- 年龄: ${info.age}`);
    if (info.applied_store) lines.push(`- 应聘门店: ${info.applied_store}`);
    if (info.applied_position) lines.push(`- 应聘岗位: ${info.applied_position}`);
    if (info.interview_time) lines.push(`- 面试时间: ${info.interview_time}`);
    if (info.is_student != null) lines.push(`- 是否学生: ${info.is_student ? '是' : '否'}`);
    if (info.education) lines.push(`- 学历: ${info.education}`);
    if (info.has_health_certificate) lines.push(`- 健康证: ${info.has_health_certificate}`);

    if (pref.labor_form) lines.push(`- 用工形式: ${pref.labor_form}`);
    if (pref.brands?.length) lines.push(`- 意向品牌: ${pref.brands.join('、')}`);
    if (pref.salary) lines.push(`- 意向薪资: ${pref.salary}`);
    if (pref.position?.length) lines.push(`- 意向岗位: ${pref.position.join('、')}`);
    if (pref.schedule) lines.push(`- 意向班次: ${pref.schedule}`);
    if (pref.city) lines.push(`- 意向城市: ${pref.city}`);
    if (pref.district?.length) lines.push(`- 意向区域: ${pref.district.join('、')}`);
    if (pref.location?.length) lines.push(`- 意向地点: ${pref.location.join('、')}`);

    return lines;
  }

  /** 把本轮前置高置信识别渲染成单独的 runtime hints。 */
  private formatHighConfidenceFacts(facts: EntityExtractionResult): string {
    const lines = this.formatExtractionFactLines(facts);
    if (lines.length === 0) return '';

    return [
      '\n\n[本轮高置信线索]',
      '',
      '以下内容由当前消息前置识别得到，仅用于理解本轮意图，不视为跨轮已确认的会话记忆。',
      '若与[用户档案]、[会话记忆]或候选人当前明示信息冲突，以候选人当前明示信息为准。',
      '',
      '## 当前消息识别结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** 把与会话记忆冲突的当前轮识别结果渲染成待确认线索。 */
  private formatPendingConfirmationFacts(facts: EntityExtractionResult): string {
    const lines = this.formatExtractionFactLines(facts);
    if (lines.length === 0) return '';

    return [
      '\n\n[本轮待确认线索]',
      '',
      '以下内容由当前消息前置识别得到，但与[会话记忆]中的已知信息存在冲突。',
      '这些内容只用于帮助你判断是否需要澄清，不得直接覆盖已确认的会话记忆。',
      '若候选人本轮表达明确，可按当前表达继续；若表达仍有歧义，先做一次简短确认。',
      '',
      '## 当前消息待确认结果',
      lines.join('\n'),
    ].join('\n');
  }

  /** 把当前轮高置信识别拆成“普通线索”和“待确认线索”。 */
  private partitionHighConfidenceFacts(
    sessionFacts: EntityExtractionResult | null,
    highConfidenceFacts: EntityExtractionResult | null,
  ): {
    normalHints: EntityExtractionResult | null;
    pendingHints: EntityExtractionResult | null;
  } {
    if (!highConfidenceFacts) {
      return { normalHints: null, pendingHints: null };
    }

    if (!sessionFacts) {
      return { normalHints: highConfidenceFacts, pendingHints: null };
    }

    const normalHints = this.createEmptyExtractionResult();
    const pendingHints = this.createEmptyExtractionResult();

    this.partitionScalarField(
      sessionFacts.interview_info.name,
      highConfidenceFacts.interview_info.name,
      (value) => {
        normalHints.interview_info.name = value;
      },
      (value) => {
        pendingHints.interview_info.name = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.phone,
      highConfidenceFacts.interview_info.phone,
      (value) => {
        normalHints.interview_info.phone = value;
      },
      (value) => {
        pendingHints.interview_info.phone = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.gender,
      highConfidenceFacts.interview_info.gender,
      (value) => {
        normalHints.interview_info.gender = value;
      },
      (value) => {
        pendingHints.interview_info.gender = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.age,
      highConfidenceFacts.interview_info.age,
      (value) => {
        normalHints.interview_info.age = value;
      },
      (value) => {
        pendingHints.interview_info.age = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.applied_store,
      highConfidenceFacts.interview_info.applied_store,
      (value) => {
        normalHints.interview_info.applied_store = value;
      },
      (value) => {
        pendingHints.interview_info.applied_store = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.applied_position,
      highConfidenceFacts.interview_info.applied_position,
      (value) => {
        normalHints.interview_info.applied_position = value;
      },
      (value) => {
        pendingHints.interview_info.applied_position = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.interview_time,
      highConfidenceFacts.interview_info.interview_time,
      (value) => {
        normalHints.interview_info.interview_time = value;
      },
      (value) => {
        pendingHints.interview_info.interview_time = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.is_student,
      highConfidenceFacts.interview_info.is_student,
      (value) => {
        normalHints.interview_info.is_student = value;
      },
      (value) => {
        pendingHints.interview_info.is_student = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.education,
      highConfidenceFacts.interview_info.education,
      (value) => {
        normalHints.interview_info.education = value;
      },
      (value) => {
        pendingHints.interview_info.education = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.interview_info.has_health_certificate,
      highConfidenceFacts.interview_info.has_health_certificate,
      (value) => {
        normalHints.interview_info.has_health_certificate = value;
      },
      (value) => {
        pendingHints.interview_info.has_health_certificate = value;
      },
    );

    this.partitionArrayField(
      sessionFacts.preferences.brands,
      highConfidenceFacts.preferences.brands,
      (value) => {
        normalHints.preferences.brands = value;
      },
      (value) => {
        pendingHints.preferences.brands = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.salary,
      highConfidenceFacts.preferences.salary,
      (value) => {
        normalHints.preferences.salary = value;
      },
      (value) => {
        pendingHints.preferences.salary = value;
      },
    );
    this.partitionArrayField(
      sessionFacts.preferences.position,
      highConfidenceFacts.preferences.position,
      (value) => {
        normalHints.preferences.position = value;
      },
      (value) => {
        pendingHints.preferences.position = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.schedule,
      highConfidenceFacts.preferences.schedule,
      (value) => {
        normalHints.preferences.schedule = value;
      },
      (value) => {
        pendingHints.preferences.schedule = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.city,
      highConfidenceFacts.preferences.city,
      (value) => {
        normalHints.preferences.city = value;
      },
      (value) => {
        pendingHints.preferences.city = value;
      },
    );
    this.partitionArrayField(
      sessionFacts.preferences.district,
      highConfidenceFacts.preferences.district,
      (value) => {
        normalHints.preferences.district = value;
      },
      (value) => {
        pendingHints.preferences.district = value;
      },
    );
    this.partitionArrayField(
      sessionFacts.preferences.location,
      highConfidenceFacts.preferences.location,
      (value) => {
        normalHints.preferences.location = value;
      },
      (value) => {
        pendingHints.preferences.location = value;
      },
    );
    this.partitionScalarField(
      sessionFacts.preferences.labor_form,
      highConfidenceFacts.preferences.labor_form,
      (value) => {
        normalHints.preferences.labor_form = value;
      },
      (value) => {
        pendingHints.preferences.labor_form = value;
      },
    );

    return {
      normalHints: this.hasAnyFactLines(normalHints) ? normalHints : null,
      pendingHints: this.hasAnyFactLines(pendingHints) ? pendingHints : null,
    };
  }

  private partitionScalarField<T extends string | boolean | null>(
    previousValue: T,
    currentValue: T,
    onNormal: (value: Exclude<T, null>) => void,
    onPending: (value: Exclude<T, null>) => void,
  ): void {
    if (!this.hasScalarValue(currentValue)) return;
    if (!this.hasScalarValue(previousValue)) {
      onNormal(currentValue as Exclude<T, null>);
      return;
    }
    if (this.isSameScalarValue(previousValue, currentValue)) return;
    onPending(currentValue as Exclude<T, null>);
  }

  private partitionArrayField(
    previousValue: string[] | null,
    currentValue: string[] | null,
    onNormal: (value: string[]) => void,
    onPending: (value: string[]) => void,
  ): void {
    const normalizedCurrent = this.normalizeStringArray(currentValue);
    if (normalizedCurrent.length === 0) return;

    const normalizedPrevious = this.normalizeStringArray(previousValue);
    if (normalizedPrevious.length === 0) {
      onNormal(normalizedCurrent);
      return;
    }
    if (this.isSameStringArray(normalizedPrevious, normalizedCurrent)) return;
    onPending(normalizedCurrent);
  }

  private hasScalarValue(value: string | boolean | null): boolean {
    if (typeof value === 'boolean') return true;
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isSameScalarValue(
    previousValue: string | boolean | null,
    currentValue: string | boolean | null,
  ): boolean {
    if (typeof previousValue === 'boolean' || typeof currentValue === 'boolean') {
      return previousValue === currentValue;
    }
    return String(previousValue).trim() === String(currentValue).trim();
  }

  private normalizeStringArray(values: string[] | null): string[] {
    if (!values?.length) return [];
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
  }

  private isSameStringArray(previousValue: string[], currentValue: string[]): boolean {
    if (previousValue.length !== currentValue.length) return false;
    return previousValue.every((value, index) => value === currentValue[index]);
  }

  private hasAnyFactLines(facts: EntityExtractionResult): boolean {
    return this.formatExtractionFactLines(facts).length > 0;
  }

  private createEmptyExtractionResult(): EntityExtractionResult {
    return {
      interview_info: this.createEmptyInterviewInfo(),
      preferences: this.createEmptyPreferences(),
      reasoning: '',
    };
  }

  private createEmptyInterviewInfo(): InterviewInfo {
    return {
      name: null,
      phone: null,
      gender: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    };
  }

  private createEmptyPreferences(): Preferences {
    return {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
    };
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
