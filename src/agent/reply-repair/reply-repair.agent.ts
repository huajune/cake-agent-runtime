import { Injectable } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { GuardViolation } from '@shared-types/guardrail.contract';
import { GuardrailReviewPacketBuilder } from '../guardrail/output/llm/review-packet.builder';
import type { GuardrailReviewPacket } from '../guardrail/output/llm/review-packet.types';
import type { ReplyRepairContext } from './reply-repair-context.provider';

export interface ReplyRepairInput {
  userMessage?: string;
  originalReply: string;
  violations: GuardViolation[];
  feedbackToGenerator?: string;
  ruleIds: string[];
  toolCalls: AgentToolCall[];
  redLines?: string[];
  committedSideEffects?: string;
  repairContext?: ReplyRepairContext;
}

@Injectable()
export class ReplyRepairAgent {
  constructor(
    private readonly llm: LlmExecutorService,
    private readonly packetBuilder: GuardrailReviewPacketBuilder,
  ) {}

  async repair(input: ReplyRepairInput): Promise<string> {
    const packet = this.packetBuilder.build({
      reply: input.originalReply,
      toolCalls: input.toolCalls,
      userMessage: input.userMessage,
      redLines: input.redLines,
      outputRuleHits: input.ruleIds,
    });

    // 指令 + 待修草稿 + 接地材料全部进 system；真实对话历史走 messages（对齐 generator 的 AI SDK 用法）。
    const system = [
      '你是招聘对话里的文本修复助手：只对「已生成但被出站守卫拦下」的候选人可见回复做最小必要改写，让它合规、能直接发出。',
      '你没有任何工具，也不能规划或模拟工具调用。',
      '输出要求：只输出修订后的回复文本；最小改动；口语化、像真人招募经理；不要称呼昵称。',
      '禁止输出工具调用、JSON、Markdown 代码块、解释过程。',
      '不要承诺“稍后帮你查/我去确认/马上帮你看”等本轮无法兑现的动作。',
      '',
      '# 待修复的草稿回复（被出站守卫拦下，不能直接发送）',
      `"""${input.originalReply.trim()}"""`,
      '',
      '# 问题与修改要求',
      this.formatFeedback(input),
      '',
      '# 本轮工具事实',
      this.formatEvidence(packet.evidence),
      '',
      '# 修复上下文（记忆/画像/岗位/群）',
      this.formatRepairContext(input.repairContext),
      '',
      '# 出站策略',
      this.formatPolicies(packet.policies),
      '',
      '# 本轮已发生且不可撤销的动作',
      input.committedSideEffects?.trim() || '无',
      '',
      '以上「本轮工具事实」与「修复上下文」是你唯一可用的事实来源，只能据此改写，不得新增任何未列出的事实。',
      '结合下面的对话历史，直接输出修订后的候选人可见回复文本。',
    ].join('\n');

    const conversation = input.repairContext?.recentMessages ?? [];
    const messages =
      conversation.length > 0
        ? conversation.map((message) => ({ role: message.role, content: message.content }))
        : [
            {
              role: 'user' as const,
              content: input.userMessage?.trim() || '（候选人本轮消息缺失）',
            },
          ];

    const result = await this.llm.generate({ role: ModelRole.Repair, system, messages });

    return this.cleanOutput(result.text);
  }

  private formatFeedback(input: ReplyRepairInput): string {
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

  // 纯 section 布局：各行块已由 provider 渲染好，这里只套标题、拼版。
  private formatRepairContext(context: ReplyRepairContext | undefined): string {
    if (!context) return '（未提供）';
    const sections: string[] = [];
    const add = (title: string, body: string[]): void => {
      if (body.length > 0) sections.push(`${title}\n${body.join('\n')}`);
    };

    // 近期对话不在这里渲染：它作为真实对话历史走 messages 槽。
    add('## 已知事实', context.factLines);
    add('## 候选人画像', context.profileLines);
    add(
      '## 历史求职意向（快照，仅供参考；与本次会话不一致时以本次为准）',
      context.longTermPreferenceLines,
    );
    add('## 相关岗位', context.jobLines);
    add('## 已邀请入群', context.invitedGroupLines);
    if (context.groupInventory) {
      add(`## 可用群库（${context.groupInventory.city}）`, context.groupInventory.lines);
    }
    if (context.warnings?.length) {
      add(
        '## ⚠️ 时效提醒',
        context.warnings.map((warning) => `- ${warning}`),
      );
    }
    if (context.currentStage) {
      add('## 当前阶段', [`- ${context.currentStage}`]);
    }

    return sections.length > 0 ? sections.join('\n\n') : '（无可用上下文）';
  }

  private formatEvidence(evidence: GuardrailReviewPacket['evidence']): string {
    const blocks: string[] = [];
    const { jobList, precheck, booking, geocode } = evidence;

    if (jobList) {
      const lines = [
        `- 查询意图：${this.compactKv(jobList.args)}`,
        `- 结果：${jobList.resultCount ?? '未知'} 条（status=${jobList.status ?? '未知'}）`,
      ];
      for (const job of jobList.jobs) {
        const name =
          [job.brandName, job.storeName].filter(Boolean).join('-') || `岗位#${job.jobId ?? ''}`;
        const meta = [
          job.jobSalary,
          job.scheduleText,
          job.address,
          job.distanceKm != null ? `${job.distanceKm}km` : null,
        ]
          .filter(Boolean)
          .join(' / ');
        lines.push(`  · ${name}${meta ? `（${meta}）` : ''}`);
      }
      if (jobList.markdownExcerpt) lines.push(`- 岗位卡片摘录：\n${jobList.markdownExcerpt}`);
      blocks.push(`【岗位查询】\n${lines.join('\n')}`);
    }

    if (booking) {
      const lines = [
        `- 报名：${booking.success ? '成功' : '未成功'}${booking.errorType ? `（${booking.errorType}）` : ''}`,
        booking.confirmedInterviewTimeHuman
          ? `- 确认面试时间：${booking.confirmedInterviewTimeHuman}`
          : null,
        booking.interviewAddress ? `- 面试地址：${booking.interviewAddress}` : null,
        booking.interviewMode ? `- 面试形式：${booking.interviewMode}` : null,
        booking.onSiteScript ? `- 到场话术：${booking.onSiteScript}` : null,
      ].filter(Boolean);
      blocks.push(`【报名】\n${lines.join('\n')}`);
    }

    if (precheck) {
      const lines = [
        precheck.nextAction ? `- 下一步：${precheck.nextAction}` : null,
        precheck.missingFields.length ? `- 待补字段：${precheck.missingFields.join('、')}` : null,
        precheck.requiredFieldsToCollectNow.length
          ? `- 现在要收：${precheck.requiredFieldsToCollectNow.join('、')}`
          : null,
        precheck.interviewTimeMode ? `- 面试时间模式：${precheck.interviewTimeMode}` : null,
        precheck.blockedReason ? `- 拦截原因：${precheck.blockedReason}` : null,
      ].filter(Boolean);
      if (lines.length > 0) blocks.push(`【约面预检】\n${lines.join('\n')}`);
    }

    if (geocode) {
      const lines = [
        geocode.formattedAddress ? `- 解析地址：${geocode.formattedAddress}` : null,
        `- 是否解析出坐标：${geocode.hasResolvedCoordinate ? '是' : '否'}`,
        geocode.candidates.length ? `- 候选地址：${geocode.candidates.join('；')}` : null,
        geocode.errorType ? `- 错误：${geocode.errorType}` : null,
      ].filter(Boolean);
      blocks.push(`【地址解析】\n${lines.join('\n')}`);
    }

    return blocks.length > 0 ? blocks.join('\n\n') : '（本轮无工具事实）';
  }

  private formatPolicies(policies: GuardrailReviewPacket['policies']): string {
    const blocks: string[] = [];
    if (policies.redLines.length > 0) {
      blocks.push(`红线：\n${policies.redLines.map((line) => `- ${line}`).join('\n')}`);
    }
    if (policies.outputRuleHits.length > 0) {
      blocks.push(
        `命中的出站规则：\n${policies.outputRuleHits.map((line) => `- ${line}`).join('\n')}`,
      );
    }
    return blocks.length > 0 ? blocks.join('\n\n') : '（无）';
  }

  private compactKv(obj: Record<string, unknown>): string {
    const parts = Object.entries(obj).map(
      ([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : String(value)}`,
    );
    return parts.length > 0 ? parts.join('，') : '（无）';
  }

  private cleanOutput(text: string): string {
    return text
      .trim()
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
}
