import { Injectable } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { GuardViolation } from '@shared-types/guardrail.contract';
import { GuardrailReviewPacketBuilder } from '../guardrail/output/llm/review-packet.builder';

export interface ReplyRewriteInput {
  userMessage?: string;
  originalReply: string;
  violations: GuardViolation[];
  feedbackToGenerator?: string;
  ruleIds: string[];
  toolCalls: AgentToolCall[];
  redLines?: string[];
  committedSideEffects?: string;
}

@Injectable()
export class ReplyRewriteService {
  constructor(
    private readonly llm: LlmExecutorService,
    private readonly packetBuilder: GuardrailReviewPacketBuilder,
  ) {}

  async rewrite(input: ReplyRewriteInput): Promise<string> {
    const packet = this.packetBuilder.build({
      reply: input.originalReply,
      toolCalls: input.toolCalls,
      userMessage: input.userMessage,
      redLines: input.redLines,
      outputRuleHits: input.ruleIds,
    });

    const result = await this.llm.generateSimple({
      role: ModelRole.Repair,
      systemPrompt: [
        '你是招聘对话的回复修订员，只做候选人可见回复的文本修订。',
        '你没有任何工具，也不能规划或模拟工具调用。',
        '只基于用户本轮消息、原回复、问题与修改要求、已知事实改写，不得新增事实。',
        '输出要求：只输出修订后的回复文本；最小改动；口语化、像真人招募经理；不要称呼昵称。',
        '禁止输出工具调用、JSON、Markdown 代码块、解释过程。',
        '不要承诺“稍后帮你查/我去确认/马上帮你看”等本轮无法兑现的动作。',
      ].join('\n'),
      userMessage: [
        `候选人刚说：\n${input.userMessage?.trim() || '（未提供）'}`,
        `原回复（有问题，不能直接发送）：\n"""${input.originalReply.trim()}"""`,
        `问题与修改要求：\n${this.formatFeedback(input)}`,
        `本轮已知事实（只能用这些，不得新增）：\n${JSON.stringify(packet.evidence)}`,
        input.committedSideEffects
          ? `本轮已发生且不可撤销的动作：\n${input.committedSideEffects}`
          : '本轮已发生且不可撤销的动作：无',
        '请直接给出修订后的候选人可见回复文本。',
      ].join('\n\n'),
    });

    return this.cleanOutput(result);
  }

  private formatFeedback(input: ReplyRewriteInput): string {
    const parts: string[] = [];
    if (input.feedbackToGenerator?.trim()) {
      parts.push(input.feedbackToGenerator.trim());
    }
    for (const violation of input.violations) {
      parts.push(
        [
          `- 类型：${violation.type}`,
          `证据：${violation.evidence}`,
          `修改建议：${violation.suggestion}`,
        ].join('\n  '),
      );
    }
    return parts.length > 0 ? parts.join('\n') : '按出站守卫意见修订原回复。';
  }

  private cleanOutput(text: string): string {
    return text
      .trim()
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
}
