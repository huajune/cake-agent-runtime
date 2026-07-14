import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { MemoryService } from '@memory/memory.service';
import { z } from 'zod';
import type {
  AuthoritativeSessionState,
  CandidateFieldKey,
} from '@memory/types/authoritative-session-state.types';
import type { TurnOutcome } from '../runner/agent-runner.types';
import type { AgentStepDetail } from '@shared-types/agent-telemetry.types';
import type { FollowUpJob, FollowUpScenario } from './follow-up-scheduler.service';
import type { ReengagementBookingContext } from './booking-context';

// 复聊记忆用主动复聊专用 recall：结构化事实已过 formatExtractionFactLines（含陈旧告警），
// 短期消息直接复用 Generator 的窗口和时间格式，不再二次裁剪或改写。
export type ReengagementMemorySnapshot = Awaited<
  ReturnType<MemoryService['recallForProactiveFollowUp']>
>;

// 一次复聊的触发上下文：谁、哪个场景、什么状态、灰度/shadow 开关。
export interface ReengagementComposeContext {
  sessionRef: FollowUpJob['sessionRef'];
  scenario: FollowUpScenario;
  jobData: FollowUpJob;
  state: AuthoritativeSessionState;
  messageId?: string;
  rolloutEnabled?: boolean;
  shadow?: boolean;
  /** 本次触达前从海绵实时工单及其岗位详情解析，不允许任务快照兜底。 */
  bookingContext?: ReengagementBookingContext;
}

// 复聊 agent 一次执行的完整输入：用于整体落库观测。
// system prompt 只读取其中的场景字段、最小状态摘要和脱敏后的 memory 投影，绝不序列化整包输入。
export interface ReengagementAgentInput {
  // 触发溯源元数据（复用 compose 上下文）：仅写入 agentRequest 供排障 join。
  trigger: ReengagementComposeContext;
  // 原始记忆观测；进入 prompt 前会做字段最小化与姓名/联系方式脱敏。
  memory: ReengagementMemorySnapshot;
}

export interface ReengagementAgentExecution {
  outcome: TurnOutcome;
  agentRequest?: Record<string, unknown>;
  aiStartAt: number;
  aiEndAt: number;
  validationReason?: string;
}

const REENGAGEMENT_OUTPUT_SCHEMA = z.object({
  decision: z
    .enum(['send', 'skip'])
    .describe(
      '是否发送本次复聊。只有报名后场景中近期对话明确表明取消面试、去不了或不再考虑时选 skip；其余选 send',
    ),
  message: z.string().describe('候选人可见的复聊消息；不得用候选人的姓名、昵称或企微显示名作称呼'),
  reason: z.string().describe('只说明输入证据如何支持本条文案，不得补写“已读”“在忙”等未提供状态'),
});

const COLLECTED_FIELD_LABELS: Record<CandidateFieldKey, string> = {
  name: '姓名',
  phone: '手机号',
  age: '年龄',
  gender: '性别',
  education: '学历',
  healthCert: '健康证',
  householdProvince: '户籍',
  height: '身高',
  weight: '体重',
  supplementAnswers: '补充问题',
};

const NEVER_EXPOSED_REENGAGEMENT_FACT_LABELS = new Set([
  '姓名',
  '联系方式',
  '手机号',
  '意向品牌ID',
]);

@Injectable()
export class ReengagementAgent {
  private readonly logger = new Logger(ReengagementAgent.name);

  constructor(
    private readonly llm: LlmExecutorService,
    private readonly memory: MemoryService,
  ) {}

  async compose(ctx: ReengagementComposeContext): Promise<ReengagementAgentExecution> {
    // 走主动复聊专用 recall：拿到已渲染的 factLines（含陈旧告警）和 Generator 同源的
    // 短期消息窗口，而不是裸记忆快照。
    const memory = await this.memory.recallForProactiveFollowUp(
      ctx.sessionRef.corpId,
      ctx.sessionRef.userId,
      ctx.sessionRef.sessionId,
    );
    const agentInput: ReengagementAgentInput = { trigger: ctx, memory };

    // 只投影场景字段、最小状态和脱敏记忆，不把 trigger / memory 整包序列化进 prompt。
    const composeNow = Date.now();
    const systemPrompt = this.buildSystemPrompt(ctx, memory, composeNow);
    const messages = this.buildConversationMessages(ctx, memory);

    const aiStartAt = Date.now();
    let agentRequest: Record<string, unknown> | undefined;

    try {
      const result = await this.llm.generateStructured({
        role: ModelRole.Chat,
        schema: REENGAGEMENT_OUTPUT_SCHEMA,
        outputName: 'ReengagementMessage',
        system: systemPrompt,
        // 与 Generator 一致，直接传模型原生 user/assistant 历史；system 已包含本次主动
        // 复聊任务，不追加虚构的 user 指令，也不把历史重新文本化进 system。
        messages,
        maxOutputTokens: 160,
        temperature: 0.3,
        onPreparedRequest: (request) => {
          agentRequest = request;
        },
      });
      const aiEndAt = Date.now();
      const agentSteps = this.extractAgentSteps(result.steps);

      const output = result.output;
      const text = this.correctInterviewRelativeDay(ctx, output.message, composeNow);
      const usage = this.normalizeUsage(result.usage);
      const responseMessages = this.normalizeResponseMessages(result.response?.messages);

      const agentRequestWithInput = {
        ...(agentRequest ?? {}),
        reengagementInput: agentInput,
        reengagementOutput: { ...output, message: text },
        ...(text !== output.message
          ? {
              temporalCorrection: {
                originalMessage: output.message,
                reason: 'interview_relative_day_mismatch',
              },
            }
          : {}),
      };

      if (output.decision === 'skip') {
        const validationReason = this.resolveSkipValidationReason(ctx, memory);
        return {
          outcome: {
            kind: 'skipped',
            generatedText: text || undefined,
            scenarioCode: ctx.scenario.code,
            usage,
            responseMessages,
            toolCalls: [],
            agentSteps,
          },
          agentRequest: {
            ...agentRequestWithInput,
            validationReason,
          },
          aiStartAt,
          aiEndAt,
          validationReason,
        };
      }

      const addressedCandidateName = this.collectCandidateNames(ctx, memory)
        .filter((name) => Array.from(name).length >= 2)
        .find((name) => text.includes(name));
      if (addressedCandidateName) {
        return {
          outcome: {
            kind: 'skipped',
            generatedText: text,
            scenarioCode: ctx.scenario.code,
            usage,
            responseMessages,
            toolCalls: [],
            agentSteps,
          },
          agentRequest: {
            ...agentRequestWithInput,
            validationReason: 'candidate_name_in_reply',
          },
          aiStartAt,
          aiEndAt,
          validationReason: 'candidate_name_in_reply',
        };
      }

      const outcome: TurnOutcome = {
        kind: 'reply',
        reply: { text },
        generatedText: text,
        scenarioCode: ctx.scenario.code,
        usage,
        responseMessages,
        toolCalls: [],
        agentSteps,
      };

      return {
        outcome,
        agentRequest: agentRequestWithInput,
        aiStartAt,
        aiEndAt,
      };
    } catch (error) {
      this.logger.warn(
        `[reengagement] reengagement agent LLM 生成失败 scenario=${ctx.scenario.code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const generatedText = error instanceof Error ? error.message : String(error);
      return {
        outcome: {
          kind: 'skipped',
          generatedText,
          toolCalls: [],
          scenarioCode: ctx.scenario.code,
          agentSteps: [],
        },
        agentRequest: {
          type: 'reengagement_agent',
          scenarioCode: ctx.scenario.code,
          validationReason: 'reengagement_agent_error',
        },
        aiStartAt,
        aiEndAt: Date.now(),
        validationReason: 'reengagement_agent_error',
      };
    }
  }

  private buildSystemPrompt(
    ctx: ReengagementComposeContext,
    memory: ReengagementMemorySnapshot,
    now: number,
  ): string {
    return [
      '你是「独立客」的招聘顾问，正在企业微信上为大型企业开展招聘，帮候选人对接合适的岗位，覆盖蓝领和白领岗位。此刻候选人已经沉默或到了某个关键节点，你要主动发一条简短、自然的消息，把 TA 往前推进一步。',
      '',
      '# 不可违反的红线',
      '- 绝对禁止用候选人的姓名、昵称、企微显示名或其它个性化称呼来打招呼或称呼候选人；即使上下文里出现，也不要复述。直接说事情，必要时只使用“你”。',
      '- 只使用下方证据。未回复不等于已读，不得声称候选人“已读未回”；也不得猜测候选人在忙、已完成面试、已接受岗位或有其它未提供状态。',
      '- 不催促、不责备、不命令，不使用“怎么没回”“现在就”“赶紧”“别迟到”等表达。',
      '- 不编造岗位事实、名额、录用结果、回电安排或任何已完成动作。',
      '- 不能报名、不能拉群、不能发消息、不能创建或修改工单；本 Agent 不开放任何工具。',
      '- 不要提及系统、模型、工具、JSON、任务代码、灰度发布、内部观测或隐私占位符。',
      '',
      '# 本次需要完成的任务',
      `任务名称：${ctx.scenario.displayName}`,
      `任务目标：${ctx.scenario.objective}`,
      `本场景生成规范：${ctx.scenario.generationPolicy}`,
      '本场景生成规范决定“这次具体说什么”，但不能覆盖上面的红线。',
      '',
      '# 已核验的最小上下文',
      '下面是本次复聊唯一可用的上下文。缺失的信息不要补全或猜测。',
      '',
      '## 时间基准',
      `- 当前时间：${this.formatShanghaiTime(now)}`,
      `- 今天：${this.formatShanghaiDateWithWeekday(now, 0)}`,
      `- 明天：${this.formatShanghaiDateWithWeekday(now, 1)}`,
      `- 后天：${this.formatShanghaiDateWithWeekday(now, 2)}`,
      '- “今天”“明天”等相对日期必须严格以上述日期映射为基准；状态摘要已经给出相对日期口径时必须原样遵守，不得自行换算。',
      '- 近期对话里的“今天”“明天”等历史表达，必须以该条消息标注的发送时间为基准理解，不能按本次触达时间重新解释。',
      '',
      '## 状态摘要',
      this.formatStateSummary(ctx, now),
      '',
      '## 已知事实',
      this.formatFactLines(ctx, memory.factLines),
      ...(memory.warnings?.length
        ? ['', '## 时效提醒', ...memory.warnings.map((warning) => `- ${warning}`)]
        : []),
      '',
      '# 写作要求',
      ...(this.isPostBookingScenario(ctx)
        ? [
            '## 发送前语义停止条件',
            '- 近期对话中，只要候选人最新明确表达已经取消面试、面试去不了/不去了、无法参加，或不再考虑这个岗位，decision 必须为 skip，message 留空；即使工单状态仍显示预约有效也必须放弃面试提醒和面试后回访。',
            '- 候选人先答应、后又说去不了时，以更晚的取消表达为准；若取消后又明确重新约好新的面试，则以最新重新预约为准。',
            '- 仅仅询问时间地点、表达紧张或尚未确认结果，不等于取消，decision 应为 send。',
            '',
          ]
        : []),
      '- 优先只写一句，最多两句；像微信里真人顾问随口发的话，不客套、不群发腔、不堆表情。',
      '- 只围绕本次目标提一个问题或一个行动点，不连环追问，不重复上一条消息。',
      '- 可以在确有助于候选人识别上下文时，简短承接近期对话里已经出现的岗位、门店、薪资、班次或位置；不得新增、改写、拼接或夸大任何细节，也不要整段复制岗位介绍。',
      '',
      '# 输出协议',
      '返回结构化结果：decision 决定是否发送；decision=send 时 message 是候选人可见的最终文案，decision=skip 时 message 必须为空；reason 用一句话指出所依据的输入证据（仅内部观测）。message 不得包含候选人的姓名或昵称，reason 不得添加输入中没有的状态。不要给多个方案或解释过程。',
    ].join('\n');
  }

  private isPostBookingScenario(ctx: ReengagementComposeContext): boolean {
    return (
      ctx.scenario.code === 'interview_reminder' || ctx.scenario.code === 'post_interview_followup'
    );
  }

  /**
   * 模型可以因为证据不足、时机不合适等原因选择 skip，不能把所有 skip 都记成
   * “候选人取消面试”。只有报名后场景且近期候选人最后一个相关信号明确取消时，
   * 才使用取消原因；其余统一记为 Agent 主动跳过，详细理由保留在 reengagementOutput。
   */
  private resolveSkipValidationReason(
    ctx: ReengagementComposeContext,
    memory: ReengagementMemorySnapshot,
  ): string {
    if (!this.isPostBookingScenario(ctx)) return 'reengagement_agent_skipped';

    const cancellation =
      /(?:取消(?:面试)?|不(?:去|参加|面试)了?|去不了|无法参加|不再考虑|不想去|找到.{0,8}工作.{0,8}(?:不面试|不用|不考虑))/;
    const rebooked =
      /(?:重新.{0,8}(?:约|面试)|改到|改成|确定.{0,6}(?:去|参加)|还是(?:按|去|参加)|(?:可以|能够|能).{0,6}(?:参加|去面试))/;

    for (let index = memory.recentMessages.length - 1; index >= 0; index -= 1) {
      const message = memory.recentMessages[index];
      if (message.role !== 'user') continue;
      if (rebooked.test(message.content)) return 'reengagement_agent_skipped';
      if (cancellation.test(message.content)) return 'candidate_cancelled_interview_in_chat';
    }
    return 'reengagement_agent_skipped';
  }

  private formatStateSummary(ctx: ReengagementComposeContext, now: number): string {
    const lines: string[] = [];
    if (ctx.scenario.code === 'store_presented_no_reply') {
      lines.push('- 已推荐过岗位或门店：是');
    }
    if (ctx.scenario.code === 'booking_incomplete') {
      const collected = Object.keys(ctx.state.collectedFields)
        .map((key) => COLLECTED_FIELD_LABELS[key as CandidateFieldKey])
        .filter(Boolean);
      lines.push('- 收资状态：已开始但未完成');
      lines.push(`- 已收集资料项：${collected.length > 0 ? collected.join('、') : '暂无'}`);
      lines.push('- 提醒原则：只提醒继续补充，不猜测具体缺少哪些字段');
    }
    if (
      ctx.scenario.code === 'interview_reminder' ||
      ctx.scenario.code === 'post_interview_followup'
    ) {
      const booking = ctx.bookingContext;
      lines.push('- 当前预约：已在本次触达前查询海绵实时工单并通过状态核验');
      lines.push(`- 面试形式：${booking?.interviewType ?? '工单未提供，不得猜测'}`);
      if (booking?.brandName) lines.push(`- 品牌：${booking.brandName}`);
      if (booking?.companyName) lines.push(`- 企业：${booking.companyName}`);
      if (booking?.projectName) lines.push(`- 项目/门店：${booking.projectName}`);
      else if (booking?.storeName) lines.push(`- 门店：${booking.storeName}`);
      if (booking?.jobName) lines.push(`- 岗位：${booking.jobName}`);
      if (booking?.currentStatus) lines.push(`- 工单当前状态：${booking.currentStatus}`);
      if (booking?.interviewAddress) lines.push(`- 面试地址：${booking.interviewAddress}`);
      if (booking?.interviewRequirement) lines.push(`- 面试要求：${booking.interviewRequirement}`);
      if (booking?.interviewAt != null && Number.isFinite(booking.interviewAt)) {
        lines.push(`- 面试时间：${this.formatShanghaiTime(booking.interviewAt)}`);
        lines.push(
          `- 面试日期相对当前：${this.formatRelativeShanghaiDate(booking.interviewAt, now)}`,
        );
      }
    }
    return lines.length > 0 ? lines.join('\n') : '（无额外状态信息）';
  }

  private buildConversationMessages(
    ctx: ReengagementComposeContext,
    memory: ReengagementMemorySnapshot,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const candidateNames = this.collectCandidateNames(ctx, memory);
    return memory.recentMessages.map((message) => ({
      role: message.role,
      content: this.redactPersonalIdentifiers(message.content, candidateNames),
    }));
  }

  private formatFactLines(
    ctx: ReengagementComposeContext,
    factLines: ReengagementMemorySnapshot['factLines'],
  ): string {
    const relevantLabels = new Set(ctx.scenario.relevantFactLabels);
    const safeLines = factLines
      .filter((line) => {
        const label = this.extractFactLabel(line);
        return (
          label !== undefined &&
          !NEVER_EXPOSED_REENGAGEMENT_FACT_LABELS.has(label) &&
          relevantLabels.has(label)
        );
      })
      .map((line) => line.replace(/（置信度:[^）]*，来源:[^）]*）/g, ''));
    return safeLines.length ? safeLines.join('\n') : '（本场景无需额外结构化事实）';
  }

  private extractFactLabel(line: string): string | undefined {
    return /^-\s*([^:：]+)[:：]/u.exec(line.trim())?.[1]?.trim();
  }

  private collectCandidateNames(
    ctx: ReengagementComposeContext,
    memory: ReengagementMemorySnapshot,
  ): string[] {
    const names = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== 'string') return;
      const normalized = value.trim();
      if (normalized) names.add(normalized);
    };
    add(ctx.jobData.channelIdentity?.candidateName);
    add(ctx.state.collectedFields.name?.value);
    for (const line of memory.factLines) {
      const matched = /^- 姓名:\s*([^（]+?)(?:（|$)/.exec(line.trim());
      add(matched?.[1]);
    }
    return [...names].sort((a, b) => b.length - a.length);
  }

  private redactPersonalIdentifiers(text: string, candidateNames: string[]): string {
    let redacted = text;
    for (const name of candidateNames) {
      redacted = redacted.split(name).join('（姓名已省略）');
    }
    return redacted.replace(/\b1[3-9]\d{9}\b/g, '（手机号已省略）');
  }

  private formatShanghaiTime(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  }

  private formatRelativeShanghaiDate(timestamp: number, now: number): string {
    const targetDay = this.shanghaiDayNumber(timestamp);
    const currentDay = this.shanghaiDayNumber(now);
    if (targetDay === currentDay) return '今天（只能说“今天”，不得说“明天”）';
    if (targetDay === currentDay + 1) return '明天（只能说“明天”，不得说“今天”）';
    return `${this.formatShanghaiDate(timestamp)}（使用具体日期，不要说“今天”或“明天”）`;
  }

  private correctInterviewRelativeDay(
    ctx: ReengagementComposeContext,
    message: string,
    now: number,
  ): string {
    if (ctx.scenario.code !== 'interview_reminder') return message;
    const interviewAt = ctx.bookingContext?.interviewAt;
    if (interviewAt == null || !Number.isFinite(interviewAt)) return message;
    if (this.shanghaiDayNumber(interviewAt) !== this.shanghaiDayNumber(now)) return message;
    // 当天面试却写成“明天”是已知高频错误；确定性纠正，避免错误提醒直接触达候选人。
    return message.replace(/明天/g, '今天');
  }

  private shanghaiDayNumber(timestamp: number): number {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return Math.floor(Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000);
  }

  private formatShanghaiDate(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).format(new Date(timestamp));
  }

  private formatShanghaiDateWithWeekday(timestamp: number, offsetDays: number): string {
    const target = timestamp + offsetDays * 86_400_000;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(target));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    const weekday = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      weekday: 'long',
    }).format(new Date(target));
    return `${value('year')}-${value('month')}-${value('day')} ${weekday}`;
  }

  // 以下方法只是把 AI SDK 返回值投影成现有观测字段，不承载复聊业务逻辑。
  private normalizeUsage(usage: unknown): TurnOutcome['usage'] {
    if (!usage || typeof usage !== 'object') return undefined;
    const record = usage as Record<string, unknown>;
    const inputTokens = Number(record.inputTokens ?? record.promptTokens ?? 0);
    const outputTokens = Number(record.outputTokens ?? record.completionTokens ?? 0);
    const totalTokens = Number(record.totalTokens ?? inputTokens + outputTokens);
    return { inputTokens, outputTokens, totalTokens };
  }

  private normalizeResponseMessages(value: unknown): TurnOutcome['responseMessages'] {
    return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : undefined;
  }

  private extractAgentSteps(steps: unknown): AgentStepDetail[] {
    if (!Array.isArray(steps)) return [];
    return (
      steps as Array<{
        text?: string;
        reasoningText?: string;
        finishReason?: string;
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        toolCalls?: Array<{ toolName: string; toolCallId?: string; input?: unknown }>;
        toolResults?: Array<{ toolCallId?: string; output?: unknown }>;
      }>
    ).map((step, stepIndex) => {
      return {
        stepIndex,
        text: step.text || undefined,
        reasoning: step.reasoningText || undefined,
        toolCalls: [],
        usage:
          step.usage && step.usage.totalTokens !== undefined
            ? {
                inputTokens: step.usage.inputTokens ?? 0,
                outputTokens: step.usage.outputTokens ?? 0,
                totalTokens: step.usage.totalTokens,
              }
            : undefined,
        finishReason: step.finishReason,
      };
    });
  }
}
