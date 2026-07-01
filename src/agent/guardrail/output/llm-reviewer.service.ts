import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import type {
  GuardViolation,
  GuardrailRiskLevel,
  OutputDecision,
} from '@shared-types/guardrail.contract';

/**
 * 出站 LLM 守卫（OutputGuardrail 的 llm 档）。
 *
 * 设计铁律（§2.5 / §5.2）：模型层只判**规则表达不了的语义/语气/意图**，且输入必须带
 * grounding（reply + 本轮 toolCalls.result + memory + redLines）——只有接地才带来"新外生
 * 信号"，否则在决策论上被中心化决策者支配、堆多了准确率反而崩。
 *
 * 不变量：全程只读、无工具、无副作用；用与 generator 不同的模型角色（{@link ModelRole.Review}）
 * 隔离上下文；决策是 veto（pass | revise | block），不是建议。仅在高风险回复触发（控延迟成本）。
 */
@Injectable()
export class LlmReviewerService {
  private readonly logger = new Logger(LlmReviewerService.name);

  /** 单次审查的输出上限——裁决很短，给足违规列表即可。 */
  private static readonly MAX_OUTPUT_TOKENS = 1024;
  /** 单条 toolCalls.result 序列化长度上限，防 prompt 膨胀。 */
  private static readonly MAX_RESULT_CHARS = 1500;

  constructor(private readonly llm: LlmExecutorService) {}

  /**
   * 审查一条候选回复。输入必带 grounding；返回结构化裁决。
   *
   * 失败由调用方（OutputGuardrailService）按 §9 风险等级降级，不在此吞错。
   */
  async review(input: OutputReviewInput): Promise<OutputReviewVerdict> {
    const result = await this.llm.generateStructured({
      role: ModelRole.Review,
      disableFallbacks: false,
      maxOutputTokens: LlmReviewerService.MAX_OUTPUT_TOKENS,
      schema: VERDICT_SCHEMA,
      outputName: 'OutputGuardVerdict',
      system: REVIEWER_SYSTEM_PROMPT,
      prompt: this.buildPrompt(input),
    });

    const verdict = result.output;
    this.logger.log(
      `[LlmReviewer] decision=${verdict.decision}, risk=${verdict.riskLevel}, ` +
        `violations=${verdict.violations.map((v) => v.type).join(',') || '-'}`,
    );
    return {
      decision: verdict.decision,
      riskLevel: verdict.riskLevel,
      violations: verdict.violations.map((v) => ({
        type: v.type,
        evidence: v.evidence,
        suggestion: v.suggestion,
      })),
    };
  }

  /** 组装审查 prompt：回复 + 接地材料（工具结果 / 记忆 / 红线 / 候选人原话）。 */
  private buildPrompt(input: OutputReviewInput): string {
    const parts: string[] = [];
    parts.push('# 待审查的候选回复\n' + input.reply.trim());

    if (input.userMessage?.trim()) {
      parts.push('# 本轮候选人原话\n' + input.userMessage.trim());
    }

    parts.push('# 本轮工具调用结果（ground truth）\n' + this.summarizeToolCalls(input.toolCalls));

    if (input.memorySnapshot) {
      parts.push('# 记忆快照\n' + this.summarizeMemory(input.memorySnapshot));
    }

    if (input.redLines.length > 0) {
      parts.push('# 红线（不可触碰）\n' + input.redLines.map((r) => `- ${r}`).join('\n'));
    }

    return parts.join('\n\n');
  }

  /** 把工具调用压成"名称 / 状态 / 结果摘录"，截断超长 result 防 prompt 膨胀。 */
  private summarizeToolCalls(toolCalls: AgentToolCall[]): string {
    if (toolCalls.length === 0) return '（本轮无工具调用——回复中任何动态事实/承诺都缺接地）';
    return toolCalls
      .map((call) => {
        const status = call.status ?? 'unknown';
        let serialized: string;
        try {
          serialized = JSON.stringify(call.result ?? null);
        } catch {
          serialized = String(call.result);
        }
        if (serialized.length > LlmReviewerService.MAX_RESULT_CHARS) {
          serialized = serialized.slice(0, LlmReviewerService.MAX_RESULT_CHARS) + '…(截断)';
        }
        return `- ${call.toolName} [${status}]: ${serialized}`;
      })
      .join('\n');
  }

  private summarizeMemory(memory: AgentMemorySnapshot): string {
    const lines: string[] = [];
    if (memory.currentStage) lines.push(`当前阶段: ${memory.currentStage}`);
    if (memory.recommendedJobIds?.length) {
      lines.push(`上一轮候选岗位 id: ${memory.recommendedJobIds.join(', ')}`);
    }
    if (memory.presentedJobIds?.length) {
      lines.push(`已展示岗位 id: ${memory.presentedJobIds.join(', ')}`);
    }
    if (memory.sessionFacts && Object.keys(memory.sessionFacts).length > 0) {
      lines.push(`会话事实: ${JSON.stringify(memory.sessionFacts)}`);
    }
    return lines.length > 0 ? lines.join('\n') : '（无）';
  }
}

/** 审查输入：回复 + grounding。 */
export interface OutputReviewInput {
  reply: string;
  toolCalls: AgentToolCall[];
  memorySnapshot?: AgentMemorySnapshot;
  redLines: string[];
  userMessage?: string;
}

/** 审查裁决。 */
export interface OutputReviewVerdict {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  violations: GuardViolation[];
}

/** llm 档只判这些"规则表达不了"的语义类违规（对齐 GuardViolation.type 子集）。 */
const VIOLATION_TYPES = [
  'hallucinated_fact',
  'unsupported_commitment',
  'wrong_stage',
  'bad_tone',
  'intent_mismatch',
] as const;

const VERDICT_SCHEMA = z.object({
  decision: z
    .enum(['pass', 'revise', 'block'])
    .describe(
      'pass=无问题放行；revise=有可修正的语义/语气问题，需带意见重写；block=严重到必须丢弃',
    ),
  riskLevel: z.enum(['low', 'medium', 'high']).describe('本条回复的整体风险等级'),
  violations: z
    .array(
      z.object({
        type: z.enum(VIOLATION_TYPES),
        evidence: z.string().describe('回复中触发该违规的原文片段'),
        suggestion: z.string().describe('应如何修正（喂回模型做 revise）'),
      }),
    )
    .describe('命中的违规列表；无违规时为空数组'),
});

const REVIEWER_SYSTEM_PROMPT = `你是招聘对话的**出站质量审查员**，只读、有否决权。你的任务是判断一条「候选回复」是否与提供的 ground truth（工具结果/记忆/红线）矛盾，或存在规则无法机判的语义/语气/意图问题。

只判这五类违规，且**必须**有具体证据才标记，不要凭感觉：
- hallucinated_fact：回复陈述的班次/结算/工期/距离/薪资等，与本轮 toolCalls.result 语义矛盾（如工具说晚班、回复说早班；工具说月结、回复说日结）。
- unsupported_commitment：回复声称"已帮你约好/名额留着/已拉群"等既成承诺，但本轮工具结果/记忆里没有对应的成功证据。
- wrong_stage：未收齐资料就确认报名；候选人没问却硬推别的门店。
- bad_tone：话术僵硬、机械重复发问、像机器人。
- intent_mismatch：误解候选人意图（候选人说不要 A 品牌却继续推 A；把寒暄当成定位请求）。

判定原则：
1. 只有当回复与提供的 ground truth **确有矛盾或确有上述语义问题**时才标记；信息不足时倾向 pass，不要无中生有。
2. decision 取所有违规里最严重的：能改写修正→revise；严重到不可发出（如编造既成事实误导候选人）→block；否则 pass。
3. 你只输出结构化裁决，不改写回复本身。`;
