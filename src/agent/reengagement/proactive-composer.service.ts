import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { LongTermService } from '@memory/services/long-term.service';
import { MemoryService } from '@memory/memory.service';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type {
  AuthoritativeSessionState,
  CandidateFieldKey,
} from '@memory/types/authoritative-session-state.types';
import type { ActiveBooking } from '@memory/types/long-term.types';
import { sanitizeBrandName } from '@tools/utils/sanitize-brand-name.util';
import { OutboundReplySanitizer } from '../guardrail/output/outbound-reply-sanitizer';
import { detectOutputLeak } from '../guardrail/output/rules/internal-info-leaks.rule';
import {
  detectCompletionSuccessClaimWithoutTool,
  FALSE_PROMISE_RULES,
} from '../guardrail/output/rules/false-promises.rule';
import type { TurnOutcome } from '../runner/agent-runner.types';
import type { FollowUpJob, FollowUpScenario } from './reengagement.types';
import { parseInterviewTimestamp } from './scenario-registry';

export interface ProactiveComposeExecution {
  outcome: TurnOutcome;
  agentRequest?: Record<string, unknown>;
  aiStartAt: number;
  aiEndAt: number;
  validationReason?: string;
}

interface ComposeContext {
  sessionRef: FollowUpJob['sessionRef'];
  scenario: FollowUpScenario;
  jobData: FollowUpJob;
  state: AuthoritativeSessionState;
  messageId?: string;
}

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

const SCENARIO_LIMITS: Partial<Record<FollowUpScenario['code'], number>> = {
  interview_reminder: 120,
  booking_incomplete: 100,
};

@Injectable()
export class ProactiveComposerService {
  private readonly logger = new Logger(ProactiveComposerService.name);

  constructor(
    private readonly llm: LlmExecutorService,
    private readonly memory: MemoryService,
    private readonly longTerm: LongTermService,
  ) {}

  async compose(ctx: ComposeContext): Promise<ProactiveComposeExecution> {
    if (ctx.scenario.code === 'interview_reminder') {
      return this.composeTemplate(ctx, await this.composeInterviewReminder(ctx));
    }
    return this.composeWithLlm(ctx);
  }

  private composeTemplate(ctx: ComposeContext, text: string): ProactiveComposeExecution {
    const aiStartAt = Date.now();
    const outcome = this.toOutcome(ctx, text, {
      request: {
        type: 'template',
        scenarioCode: ctx.scenario.code,
      },
    });
    const validationReason = this.validate(ctx.scenario, outcome.reply?.text ?? '');
    return validationReason
      ? this.skipped(ctx, aiStartAt, Date.now(), validationReason, text)
      : {
          outcome,
          agentRequest: {
            type: 'template',
            scenarioCode: ctx.scenario.code,
          },
          aiStartAt,
          aiEndAt: Date.now(),
        };
  }

  private async composeWithLlm(ctx: ComposeContext): Promise<ProactiveComposeExecution> {
    const aiStartAt = Date.now();
    let agentRequest: Record<string, unknown> | undefined;
    const memory = await this.memory.recallForProactiveFollowUp(
      ctx.sessionRef.corpId,
      ctx.sessionRef.userId,
      ctx.sessionRef.sessionId,
      { recentLimit: 10 },
    );
    const userMessage = [
      `场景: ${ctx.scenario.displayName}`,
      `目标: ${ctx.scenario.objective}`,
      memory.factLines.length > 0
        ? `会话事实:\n${memory.factLines.join('\n')}`
        : '会话事实: 暂无明确事实',
      memory.recentMessages.length > 0
        ? `最近对话:\n${memory.recentMessages.map((m) => `${m.role === 'assistant' ? '助手' : '候选人'}: ${m.content}`).join('\n')}`
        : '最近对话: 暂无可用历史',
      this.buildStateHint(ctx),
    ].join('\n\n');

    try {
      const result = await this.llm.generate({
        role: ModelRole.Chat,
        system: this.buildSystemPrompt(ctx.scenario),
        messages: [{ role: 'user', content: userMessage }],
        maxOutputTokens: 160,
        temperature: 0.3,
        onPreparedRequest: (request) => {
          agentRequest = request;
        },
      });
      const aiEndAt = Date.now();
      const rawText = (result.text ?? '').trim();
      if (rawText === 'SKIP')
        return this.skipped(ctx, aiStartAt, aiEndAt, 'composer_skip', rawText);
      const outcome = this.toOutcome(ctx, rawText, {
        usage: this.normalizeUsage(result.usage),
        responseMessages: this.normalizeResponseMessages(result.response?.messages),
      });
      const validationReason = this.validate(ctx.scenario, outcome.reply?.text ?? '');
      if (validationReason) return this.skipped(ctx, aiStartAt, aiEndAt, validationReason, rawText);
      return { outcome, agentRequest, aiStartAt, aiEndAt };
    } catch (error) {
      this.logger.warn(
        `[reengagement] composer LLM 生成失败 scenario=${ctx.scenario.code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.skipped(
        ctx,
        aiStartAt,
        Date.now(),
        'composer_error',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async composeInterviewReminder(ctx: ComposeContext): Promise<string> {
    const booking = await this.findBooking(ctx);
    const interviewAt =
      ctx.jobData.expectedInterviewAt ??
      parseInterviewTimestamp(booking?.interview_time) ??
      (ctx.state as { interviewAt?: number }).interviewAt;
    const timeText = interviewAt ? this.formatShanghaiTime(interviewAt) : '约好的时间';
    const storeText = this.compact(booking?.store_name);
    const where = storeText ? `，地点是${storeText}` : '';
    return `提醒你一下，面试是${timeText}${where}，记得准时到场，身份证和健康证也带上哈。`;
  }

  private async findBooking(ctx: ComposeContext): Promise<ActiveBooking | undefined> {
    const bookings = await this.longTerm
      .getActiveBookings(ctx.sessionRef.corpId, ctx.sessionRef.userId)
      .catch(() => []);
    if (ctx.jobData.workOrderId != null) {
      const byWorkOrder = bookings.find(
        (booking) => booking.work_order_id === ctx.jobData.workOrderId,
      );
      if (byWorkOrder) return byWorkOrder;
    }
    return bookings[0];
  }

  private buildSystemPrompt(scenario: FollowUpScenario): string {
    const lines = [
      '你是独立客招聘顾问，正在给候选人发一条主动跟进消息。',
      '请根据上下文生成一条自然、简短、像真人发送的中文复聊话术，只输出消息正文。',
      '如果上下文不足以自然跟进，输出 SKIP。',
      `本次场景目标：${scenario.objective}`,
      `话术要求：${scenario.generationPolicy}`,
    ];
    return lines.join('\n');
  }

  private buildStateHint(ctx: ComposeContext): string {
    if (ctx.scenario.code !== 'booking_incomplete') return '';
    const providedFields = Object.keys(ctx.state.collectedFields)
      .map((key) => COLLECTED_FIELD_LABELS[key as CandidateFieldKey])
      .filter(Boolean);
    return providedFields.length > 0
      ? `当前已识别资料字段: ${providedFields.join('、')}`
      : '当前已识别资料字段: 暂无';
  }

  private toOutcome(
    ctx: ComposeContext,
    text: string,
    extras?: {
      usage?: TurnOutcome['usage'];
      responseMessages?: TurnOutcome['responseMessages'];
      request?: Record<string, unknown>;
    },
  ): TurnOutcome {
    const cleaned = OutboundReplySanitizer.sanitize(sanitizeBrandName(text ?? '')).trim();
    return {
      kind: 'reply',
      reply: { text: cleaned },
      generatedText: cleaned,
      toolCalls: [],
      scenarioCode: ctx.scenario.code,
      usage: extras?.usage,
      responseMessages: extras?.responseMessages,
      agentSteps: [],
    };
  }

  private skipped(
    ctx: ComposeContext,
    aiStartAt: number,
    aiEndAt: number,
    reason: string,
    generatedText?: string,
  ): ProactiveComposeExecution {
    return {
      outcome: {
        kind: 'skipped',
        generatedText,
        toolCalls: [],
        scenarioCode: ctx.scenario.code,
        agentSteps: [],
      },
      agentRequest: {
        type: 'proactive_composer',
        scenarioCode: ctx.scenario.code,
        validationReason: reason,
      },
      aiStartAt,
      aiEndAt,
      validationReason: reason,
    };
  }

  private validate(scenario: FollowUpScenario, text: string): string | undefined {
    const cleaned = text.trim();
    if (!cleaned) return 'composer_empty';
    if (cleaned === 'SKIP') return 'composer_skip';
    const limit = SCENARIO_LIMITS[scenario.code] ?? 80;
    if ([...cleaned].length > limit) return 'composer_too_long';
    if (detectOutputLeak(cleaned)) return 'composer_validation_failed';
    if (this.hasFalsePromise(cleaned)) return 'composer_false_promise';
    if (this.hasForbiddenJobDetail(cleaned)) return 'composer_forbidden_job_detail';
    if (
      scenario.code === 'address_missing' &&
      !/(位置|地址|定位|附近|就近|地铁|商圈)/.test(cleaned)
    ) {
      return 'composer_missing_expected_ask';
    }
    if (
      scenario.code === 'booking_incomplete' &&
      !/(补|填|资料|姓名|手机号|年龄|性别)/.test(cleaned)
    ) {
      return 'composer_missing_expected_ask';
    }
    return undefined;
  }

  private hasFalsePromise(text: string): boolean {
    const emptyToolCalls: AgentToolCall[] = [];
    if (detectCompletionSuccessClaimWithoutTool(text, emptyToolCalls)) return true;
    return FALSE_PROMISE_RULES.some((rule) => {
      if (rule.action === GUARDRAIL_ACTION.OBSERVE) return false;
      rule.keywords.lastIndex = 0;
      if (!rule.keywords.test(text)) return false;
      if (rule.ignorePredicate?.(text, emptyToolCalls)) return false;
      return !rule.requiredToolPredicate(emptyToolCalls);
    });
  }

  private hasForbiddenJobDetail(text: string): boolean {
    if (
      /(?:\d+(?:\.\d+)?\s*(?:元|块)(?:\/|每)?(?:小时|时|天|日|月)?|薪资|工资|时薪|日薪|月薪)/.test(
        text,
      )
    ) {
      return true;
    }
    if (/(?:早班|晚班|中班|夜班|白班|班次|排班|轮班|全职|兼职|小时工|日结|周结|月结)/.test(text)) {
      return true;
    }
    if (/(?:岗位[一二三四五六七八九十\d]|推荐\s*\d|[①②③④⑤⑥⑦⑧⑨]|^\s*[-*]\s*\S+)/m.test(text)) {
      return true;
    }
    return false;
  }

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

  private formatShanghaiTime(ts: number): string {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(ts)).map((part) => [part.type, part.value]),
    );
    return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
  }

  private compact(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }
}
