import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ROLE_MODEL_OVERRIDES, type RoleModelOverridesProvider } from '@/llm/role-model-overrides';
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

// 字段顺序即模型生成顺序：判定依据（reason）必须先于 decision 产出，
// 强制“先摆证据再下结论”。曾有判例：模型推理已识别到候选人放弃岗位，
// 但 decision 排在最前导致先写了 send，随后的分析未能修正结论。
const REENGAGEMENT_OUTPUT_SCHEMA = z.object({
  reason: z
    .string()
    .describe(
      '判定依据：引用近期对话里决定发送或跳过的关键证据（谁在何时说了什么）；只引用输入证据，不得补写“已读”“在忙”等未提供状态',
    ),
  blockReason: z
    .enum([
      'none',
      'candidate_declined_interview',
      'manager_cancelled_interview',
      'interview_result_known',
      'result_inquiry_already_sent',
      'interview_reminder_already_sent',
    ])
    .default('none')
    .describe('根据判定依据得出的发送前语义停止原因；未命中为 none'),
  decision: z
    .enum(['send', 'skip'])
    .describe('是否发送本次复聊。blockReason 命中任一停止原因时必须为 skip，否则为 send'),
  message: z.string().describe('候选人可见的复聊消息；不得用候选人的姓名、昵称或企微显示名作称呼'),
});

type ReengagementOutput = z.infer<typeof REENGAGEMENT_OUTPUT_SCHEMA>;

class ReengagementOutputContractError extends Error {
  constructor(readonly issue: string) {
    super(`Reengagement output contract violation: ${issue}`);
    this.name = 'ReengagementOutputContractError';
  }
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

const NEVER_EXPOSED_REENGAGEMENT_FACT_LABELS = new Set([
  '姓名',
  '联系方式',
  '手机号',
  '意向品牌ID',
]);

@Injectable()
export class ReengagementAgent {
  /** 归一化后短于该长度的文案不做复读判定，避免误伤“你看哪天方便”这类必然重叠的短句。 */
  private static readonly DUPLICATE_REPLY_MIN_LENGTH = 10;

  private readonly logger = new Logger(ReengagementAgent.name);

  /**
   * 复聊语义判定/生成专用模型（AGENT_REENGAGEMENT_MODEL，可选）。
   * 语义停止条件（放弃岗位识别、"已提醒过"口径）对模型能力敏感，与主链路 Chat
   * 角色解耦独立灰度；缺省时回退 Chat 角色路由，行为与历史一致。
   */
  private readonly reengagementModelId?: string;

  constructor(
    private readonly llm: LlmExecutorService,
    private readonly memory: MemoryService,
    config: ConfigService,
    @Optional()
    @Inject(ROLE_MODEL_OVERRIDES)
    private readonly roleModelOverrides?: RoleModelOverridesProvider,
  ) {
    this.reengagementModelId = config.get<string>('AGENT_REENGAGEMENT_MODEL')?.trim() || undefined;
  }

  /** 复聊模型解析：Dashboard 运行时覆盖 > 环境变量 > Chat 角色路由；覆盖读取失败回退，不阻塞触达。 */
  private async resolveModelOverride(): Promise<string | undefined> {
    try {
      const dashboard = await this.roleModelOverrides?.getRoleModelOverride('reengagement');
      if (dashboard) return dashboard;
    } catch (error) {
      this.logger.warn(
        `[reengagement] 读取复聊模型运行时覆盖失败，回退环境变量路由: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return this.reengagementModelId;
  }

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
    const modelOverride = await this.resolveModelOverride();

    const aiStartAt = Date.now();
    let agentRequest: Record<string, unknown> | undefined;
    let outputCorrection:
      | { issue: string; firstOutput: ReengagementOutput; retryOutput?: ReengagementOutput }
      | undefined;

    try {
      const generate = (system: string) =>
        this.llm.generateStructured({
          role: ModelRole.Chat,
          ...(modelOverride ? { modelId: modelOverride } : {}),
          schema: REENGAGEMENT_OUTPUT_SCHEMA,
          outputName: 'ReengagementMessage',
          system,
          // 与 Generator 一致，直接传模型原生 user/assistant 历史；system 已包含本次主动
          // 复聊任务，不追加虚构的 user 指令，也不把历史重新文本化进 system。
          messages,
          temperature: 0.3,
          onPreparedRequest: (request) => {
            agentRequest = request;
          },
        });

      let result = await generate(systemPrompt);
      let contractIssue = this.getOutputContractIssue(ctx, result.output);
      if (contractIssue) {
        outputCorrection = { issue: contractIssue, firstOutput: result.output };
        this.logger.warn(
          `[reengagement] 结构化决策不一致，纠正重试 scenario=${ctx.scenario.code} issue=${contractIssue}`,
        );
        result = await generate(
          [
            systemPrompt,
            '',
            '# 上次输出纠正',
            `上次结构化输出违反协议（${contractIssue}），请重新决策。`,
            'decision=send 时 blockReason 必须为 none 且 message 非空；decision=skip 时必须命中明确的 blockReason 且 message 为空。',
            '不得以“正常对话流程”、“感觉不需要”等模糊判断跳过已到点且通过预检的复聊任务。',
          ].join('\n'),
        );
        outputCorrection.retryOutput = result.output;
        contractIssue = this.getOutputContractIssue(ctx, result.output);
        if (contractIssue) {
          throw new ReengagementOutputContractError(contractIssue);
        }
      }
      const aiEndAt = Date.now();
      const agentSteps = this.extractAgentSteps(result.steps);

      const output = result.output;
      const blockReason = output.blockReason ?? 'none';
      const temporalCorrection = this.correctInterviewTemporalFacts(
        ctx,
        output.message,
        composeNow,
      );
      const text = temporalCorrection.text;
      const usage = this.normalizeUsage(result.usage);
      const responseMessages = this.normalizeResponseMessages(result.response?.messages);

      const agentRequestWithInput = {
        ...(agentRequest ?? {}),
        reengagementInput: agentInput,
        reengagementOutput: { ...output, message: text },
        ...(outputCorrection ? { outputCorrection } : {}),
        ...(temporalCorrection.reason
          ? {
              temporalCorrection: {
                originalMessage: output.message,
                reason: temporalCorrection.reason,
              },
            }
          : {}),
      };

      if (output.decision === 'skip' || blockReason !== 'none') {
        const validationReason = this.resolveSkipValidationReason(ctx, memory, blockReason);
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

      if (this.isDuplicateOfRecentAssistantReply(text, memory)) {
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
            validationReason: 'duplicate_of_recent_assistant_reply',
          },
          aiStartAt,
          aiEndAt,
          validationReason: 'duplicate_of_recent_assistant_reply',
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
      const decisionContractInvalid = error instanceof ReengagementOutputContractError;
      const validationReason = decisionContractInvalid
        ? 'reengagement_decision_invalid'
        : 'reengagement_agent_error';
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        outcome: {
          kind: 'skipped',
          toolCalls: [],
          scenarioCode: ctx.scenario.code,
          agentSteps: [],
        },
        agentRequest: {
          ...(agentRequest ?? {}),
          type: 'reengagement_agent',
          scenarioCode: ctx.scenario.code,
          validationReason,
          ...(outputCorrection ? { outputCorrection } : {}),
          generationError: {
            name: errorName,
            message: errorMessage,
          },
        },
        aiStartAt,
        aiEndAt: Date.now(),
        validationReason,
      };
    }
  }

  private getOutputContractIssue(
    ctx: ReengagementComposeContext,
    output: ReengagementOutput,
  ): string | null {
    const blockReason = output.blockReason ?? 'none';
    const hasMessage = !!output.message?.trim();

    if (output.decision === 'send') {
      // 显式 blockReason 始终优先：即使 decision 误写成 send，也保持 fail-closed，
      // 由下方统一分支安全跳过，不为纠正格式而冒险发送。
      if (blockReason !== 'none') return null;
      if (!hasMessage) return 'send_without_message';
      return null;
    }

    if (output.decision === 'skip') {
      if (!this.isPostBookingScenario(ctx)) return 'pre_booking_skip_not_allowed';
      if (blockReason === 'none') return 'skip_without_block_reason';
      return null;
    }

    return 'missing_decision';
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
            '- 判定步骤：先定位候选人（user）关于本次面试的最新有效表态，再检查招募经理（assistant）是否已取消面试、已询问结果或已另行提醒，最后才得出结论；关键证据写入 reason。',
            '- 下列角色约定必须严格遵守：user 是候选人，assistant 是招募经理。只判断与当前工单、本次面试相关的表达，不要用其他岗位或更早一次面试的历史误判。',
            '- 候选人（user）最新明确表示取消面试、去不了/不去了、无法参加，或不再考虑这个岗位：blockReason=candidate_declined_interview。',
            '- 候选人得知岗位要求或条件后表示接受不了，例如“干不了”“做不了”“那算了”，即使语气委婉、没有出现“取消”字样，也属于放弃本岗位；若招募经理随后已转为邀请进群、改推其他岗位，候选人未再重新确认参加本次面试的，同样判 candidate_declined_interview。注意区分：招募经理为本次面试拉群（如群内接龙面试）不属于放弃信号。',
            '- 招募经理（assistant）明确表示不用参加本次面试，理由包括面试取消、已经招满、不合适等：blockReason=manager_cancelled_interview。',
            '- 对话已经给出面试通过、未通过、录用或淘汰等结果，或者“和店长吵架了”“店长让我走了”等语境已经能合理判断面试流程结束：blockReason=interview_result_known。不要把“等通知”“还不知道结果”误判成已有结果。',
            '- 招募经理（assistant）已经发出询问本次面试结果、是否完成或面试是否顺利的语句：blockReason=result_inquiry_already_sent。候选人自己询问结果不属于此项。',
            ...(ctx.scenario.code === 'interview_reminder'
              ? [
                  '- 本场景是面试提醒；若招募经理（assistant）已经发出提醒候选人参加本次面试的语句：blockReason=interview_reminder_already_sent。判断口径：预约成功当轮的告知与收尾叮嘱都不算已提醒，包括时间地点确认、“准时到哈”“记得提前到”“记得带证件”、发送面试码或二维码；只有预约回合之后另行发出的提醒参加消息（如“记得今天的面试哈”“明天来吗，面试可以来吗”）才算已提醒。可用状态摘要里的“报名完成时间”区分：与其紧邻的消息属于预约当轮。',
                  '- 状态摘要里的“面试时间”是当前工单的唯一权威时间。候选人可能同时有多个面试；近期对话中出现的其它面试时间属于其它工单，禁止用来生成本次提醒。',
                ]
              : [
                  '- 本场景是面试后回访；招募经理此前只发送过面试提醒不构成停止条件，仍可正常回访。',
                ]),
            '- 命中任一条件时 decision 必须为 skip 且 message 留空；即使实时工单仍显示预约有效也不能发送。未命中时 blockReason=none。',
            '- 未命中任何停止条件时必须 decision=send：不得以“对话流程正常”“候选人已确认过”“感觉没必要再发”等模糊理由跳过；候选人回复“好的/OK”只是确认收到，不构成停止条件。',
            '- 同一意图有前后变化时以最新有效表达为准：取消后又明确重新约好可以恢复；改约后的新面试不被旧时间对应的提醒阻止。',
            '- 仅仅询问面试时间地点、表达紧张或尚未确认结果，不构成以上停止条件。',
            '',
          ]
        : [
            '## 发送决策',
            '- 本任务已通过候选人未回复、场景仍成立等确定性预检；你只负责生成本场景的合规跟进文案，decision 必须为 send。',
            '- 不得以“正常对话流程”、“感觉不需要”或“上一条已经询问”为由跳过；应换一个更轻的角度跟进。',
            '',
          ]),
      '- 优先只写一句，最多两句；像微信里真人顾问随口发的话，不客套、不群发腔、不堆表情。',
      '- 只围绕本次目标提一个问题或一个行动点，不连环追问，不重复上一条消息。',
      '- 近期对话末尾若已经是你（assistant）发出的说明或追问，禁止原样或轻改后重发同样内容；候选人的提问只要历史里已经回答过，也不要再答一遍。换一个更轻的角度围绕本次任务轻推即可。',
      '- 可以在确有助于候选人识别上下文时，简短承接近期对话里已经出现的岗位、门店、薪资、班次或位置；不得新增、改写、拼接或夸大任何细节，也不要整段复制岗位介绍。',
      '',
      '# 输出协议',
      '按字段顺序返回结构化结果：先在 reason 里引用决定发送或跳过的关键对话证据（谁在何时说了什么，仅内部观测），再据此给出 blockReason（未命中必须为 none），然后才是 decision。只有明确命中上述语义停止条件时才允许 decision=skip，此时 message 必须为空；否则 decision=send 且 message 必须是候选人可见的最终文案。message 不得包含候选人的姓名或昵称，reason 不得添加输入中没有的状态。不要给多个方案或解释过程。',
    ].join('\n');
  }

  private isPostBookingScenario(ctx: ReengagementComposeContext): boolean {
    return (
      ctx.scenario.code === 'interview_reminder' || ctx.scenario.code === 'post_interview_followup'
    );
  }

  /**
   * 显式 blockReason 优先于 decision，确保模型即使误写 decision=send 也不会穿透安全停止条件。
   * 兼容存量模型没有返回 blockReason 的报名后输出：仅当最新候选人消息明确取消时，
   * 才追溯为取消原因；其余不明确的 skip 会在上游触发纠正重试。
   */
  private resolveSkipValidationReason(
    ctx: ReengagementComposeContext,
    memory: ReengagementMemorySnapshot,
    blockReason?:
      | 'none'
      | 'candidate_declined_interview'
      | 'manager_cancelled_interview'
      | 'interview_result_known'
      | 'result_inquiry_already_sent'
      | 'interview_reminder_already_sent',
  ): string {
    if (!this.isPostBookingScenario(ctx)) return 'reengagement_agent_skipped';
    if (blockReason && blockReason !== 'none') return blockReason;

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
      // 报名完成时间是区分“预约当轮告知”与“另行发出的提醒”的客观锚点，
      // 供 interview_reminder_already_sent 口径判定使用。
      if (Number.isFinite(ctx.jobData.anchorAt)) {
        lines.push(`- 报名完成时间：${this.formatShanghaiTime(ctx.jobData.anchorAt)}`);
      }
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

  /**
   * 模型可能把历史里自己已发的回答当成待回答问题原样复读（badcase：booking_incomplete
   * 触达逐字重发了 30 分钟前主链路的 4 段回复，仅分段和标点不同）。prompt 层的
   * “不重复上一条消息”拦不住，这里做确定性兜底：生成文案去掉空白标点后，若完整
   * 落在近期任意一条 assistant 消息、或任意一段连续 assistant 消息的拼接之内，判定为复读。
   */
  private isDuplicateOfRecentAssistantReply(
    text: string,
    memory: ReengagementMemorySnapshot,
  ): boolean {
    const normalized = this.normalizeForDuplicateCheck(text);
    if (Array.from(normalized).length < ReengagementAgent.DUPLICATE_REPLY_MIN_LENGTH) {
      return false;
    }
    const corpus: string[] = [];
    let assistantRun = '';
    for (const message of memory.recentMessages) {
      if (message.role !== 'assistant') {
        if (assistantRun) corpus.push(assistantRun);
        assistantRun = '';
        continue;
      }
      const content = this.normalizeForDuplicateCheck(message.content);
      if (!content) continue;
      corpus.push(content);
      assistantRun += content;
    }
    if (assistantRun) corpus.push(assistantRun);
    return corpus.some((entry) => entry.includes(normalized));
  }

  private normalizeForDuplicateCheck(text: string): string {
    return text
      .replace(/\[消息发送时间：[^\]]*\]/g, '')
      .replace(/[\p{P}\p{S}\s]+/gu, '')
      .toLowerCase();
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

  private correctInterviewTemporalFacts(
    ctx: ReengagementComposeContext,
    message: string,
    now: number,
  ): { text: string; reason?: string } {
    if (ctx.scenario.code !== 'interview_reminder') return { text: message };
    const interviewAt = ctx.bookingContext?.interviewAt;
    if (interviewAt == null || !Number.isFinite(interviewAt)) return { text: message };

    let corrected = message;
    let reason: string | undefined;
    const expectedClock = this.formatShanghaiClock(interviewAt);
    const clockPattern =
      /(?:(?:上午|下午|晚上|中午|早上|凌晨)\s*)?(?:[01]?\d|2[0-3])(?:(?:[:：][0-5]\d)|(?:点(?:半|[0-5]?\d分)?))/g;
    corrected = corrected.replace(clockPattern, expectedClock);
    if (corrected !== message) reason = 'interview_time_mismatch';

    if (this.shanghaiDayNumber(interviewAt) !== this.shanghaiDayNumber(now)) {
      return { text: corrected, ...(reason ? { reason } : {}) };
    }
    // 当天面试却写成“明天”是已知高频错误；确定性纠正，避免错误提醒直接触达候选人。
    const dayCorrected = corrected.replace(/明天/g, '今天');
    if (dayCorrected !== corrected && !reason) reason = 'interview_relative_day_mismatch';
    return { text: dayCorrected, ...(reason ? { reason } : {}) };
  }

  private formatShanghaiClock(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
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
