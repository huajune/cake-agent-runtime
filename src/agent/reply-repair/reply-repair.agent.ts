import { Injectable } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { buildDateTimeGroundingLines } from '@agent/generator/context/sections/working/datetime.section';
import type { GuardViolation } from '@shared-types/guardrail.contract';
import type { TurnLedger } from '@shared-types/turn.types';
import type {
  FinalizedVisualFactField,
  VisualFactFieldKey,
  VisualFactKind,
} from '@resolution/signal/visual';
import { RepairEvidenceBuilder } from './repair-evidence.builder';
import type {
  GroupInviteEvidence,
  RepairEvidencePacket,
  SentLocationEvidence,
  VisualFactsEvidence,
} from './repair-evidence.types';
import type { ReplyRepairContext } from './reply-repair-context.provider';

export interface ReplyRepairInput {
  userMessage?: string;
  originalReply: string;
  violations: GuardViolation[];
  feedbackToGenerator?: string;
  ruleIds: string[];
  toolCalls: AgentToolCall[];
  /** 首版回合账本；视觉事实以它为准，缺省时只剩 save_image_description 降级描述。 */
  turnLedger?: Pick<TurnLedger, 'visual'>;
  redLines?: string[];
  committedSideEffects?: string;
  repairContext?: ReplyRepairContext;
}

const VISUAL_KIND_LABELS: Record<VisualFactKind, string> = {
  job_posting: '岗位截图',
  map_location: '地图/定位截图',
  resume: '简历',
  chat_screenshot: '聊天截图',
  certificate: '证件',
  other: '图片',
};

const VISUAL_FIELD_LABELS: Record<VisualFactFieldKey, string> = {
  phone: '手机号',
  brand: '品牌',
  publisher: '发布方',
  store: '门店',
  city: '城市',
  address: '地址',
  candidate_address: '候选人地址',
  other: '其他',
};

// unknown 与 third_party 同组：归属判不了就按第三方，宁可让候选人重说也不把陌生人信息当自陈。
const VISUAL_OWNERSHIP_GROUPS: ReadonlyArray<{
  label: string;
  owners: ReadonlyArray<FinalizedVisualFactField['ownership']>;
}> = [
  { label: '候选人本人', owners: ['candidate'] },
  { label: '发布方', owners: ['publisher'] },
  { label: '第三方/归属不明', owners: ['third_party', 'unknown'] },
];

@Injectable()
export class ReplyRepairAgent {
  constructor(
    private readonly llm: LlmExecutorService,
    private readonly packetBuilder: RepairEvidenceBuilder,
  ) {}

  async repair(input: ReplyRepairInput): Promise<string> {
    const packet = this.packetBuilder.build({
      reply: input.originalReply,
      toolCalls: input.toolCalls,
      turnLedger: input.turnLedger,
      userMessage: input.userMessage,
      redLines: input.redLines,
      outputRuleHits: input.ruleIds,
    });

    // 指令 + 待修草稿 + 接地材料全部进 system；真实对话历史走 messages（对齐 generator 的 AI SDK 用法）。
    const system = [
      '你是招聘对话里的文本修复助手：只对「已生成但被出站守卫拦下」的候选人可见回复做最小必要改写，让它合规、能直接发出。',
      '你没有任何工具，也不能规划或模拟工具调用。',
      '输出要求：只输出修订后的回复文本；最小改动；口语化、像真人招募经理；不要称呼昵称。',
      '最小改动的含义：只动「问题与修改要求」点名的部分；未被点名的句子逐字保留——' +
        '尤其是逐项列出的报名表字段、岗位详情、时间选项等结构化内容，保持原有分行格式，禁止合并压缩成一句话。',
      '禁止输出工具调用、JSON、Markdown 代码块、解释过程。',
      '不要承诺本轮无法兑现的查询、核实或其他后续动作。',
      '',
      // 时间锚：repair 必然晚于历史消息发生，无锚时相对日期只能从历史里猜
      //（把当天 15:00 的真实约面复述成"明天…不是今天"）。
      '# 当前时间（相对日期以此为准）',
      ...buildDateTimeGroundingLines(),
      '对话历史与草稿可能产生于更早的时刻，里面的相对日期以其原发送时间为基准，可能已过时；' +
        '改写涉及日期时间时一律按上方当前时间重新表述，不得照抄历史消息里的相对日期。',
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

  private formatEvidence(evidence: RepairEvidencePacket['evidence']): string {
    const blocks: string[] = [];
    const { jobList, precheck, booking, geocode, sentLocation, groupInvite, visualFacts } =
      evidence;

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
        booking.alreadyBooked
          ? '- 报名：该岗位已有在途预约，预约已经存在，本轮未重复提交——这不是失败，不得说没提交成功/系统问题/稍后再提交'
          : `- 报名：${booking.success ? '成功' : '未成功'}${booking.errorType ? `（${booking.errorType}）` : ''}`,
        !booking.alreadyBooked && !booking.success && booking.outcome
          ? `- 本轮结果：${booking.outcome}`
          : null,
        booking.alreadyBooked && booking.existingInterviewTimeHuman
          ? `- 工单登记的面试时间：${booking.existingInterviewTimeHuman}`
          : null,
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

    // 本轮发生的副作用只在这里有明细：committedSideEffects 只列工具名，且把
    // locationNotRequired（success 但没发定位）也算成已执行；报名后的运行时拉群不经 invite_to_group。
    if (groupInvite) blocks.push(`【群邀请】\n${this.formatGroupInvite(groupInvite)}`);
    if (sentLocation) {
      blocks.push(`【定位发送】\n${this.formatSentLocation(sentLocation).join('\n')}`);
    }
    if (visualFacts) {
      blocks.push(`【本轮图片事实】\n${this.formatVisualFacts(visualFacts).join('\n')}`);
    }

    return blocks.length > 0 ? blocks.join('\n\n') : '（本轮无工具事实）';
  }

  private formatGroupInvite(invite: GroupInviteEvidence): string {
    const group = invite.groupName ? `「${invite.groupName}」` : '';
    if (invite.success && invite.alreadyInGroup) {
      return `- 候选人本来就在群${group}里，本轮没有新拉群或新发邀请`;
    }
    if (invite.success && invite.delivery === 'direct_add') {
      return `- 已把候选人直接拉进群${group}`;
    }
    if (invite.success) {
      return invite.delivery === 'invite_card'
        ? `- 已发送群${group}的入群邀请卡片，候选人点卡片后才入群`
        : `- 已发送群${group}的入群邀请`;
    }
    return `- 本轮没有拉群或发出邀请${invite.errorType ? `（${invite.errorType}）` : ''}，不得说本轮已拉群或已发邀请`;
  }

  private formatSentLocation(location: SentLocationEvidence): string[] {
    const target = location.destination === 'interview' ? '面试地点' : '工作门店';
    const status = location.locationNotRequired
      ? `- 未发送定位：${location.interviewMethod ? `面试形式为${location.interviewMethod}，` : ''}不需要到店`
      : location.success
        ? `- 已发送${target}定位${location.sentAddress ? `：${location.sentAddress}` : ''}`
        : `- 定位未发送${location.errorType ? `（${location.errorType}）` : ''}，不得说位置已发`;
    const store = [location.storeName, location.storeAddress].filter(Boolean).join('，');
    return [
      status,
      store ? `- 工作门店：${store}` : null,
      location.interviewAddress ? `- 面试地址：${location.interviewAddress}` : null,
      location.addressConflict ? '- 面试地点与工作门店不是同一处，两个地址不得混用' : null,
    ].filter((line): line is string => Boolean(line));
  }

  private formatVisualFacts(visualFacts: VisualFactsEvidence): string[] {
    const lines = [
      '- 归属规则：只有「候选人本人」的字段能当作候选人自己的信息；其余字段和图片描述只能按"图片上显示的内容"引用',
    ];
    for (const sheet of visualFacts.sheets) {
      const label = VISUAL_KIND_LABELS[sheet.kind];
      lines.push(`- ${label}${sheet.description ? `：${sheet.description}` : ''}`);
      for (const group of VISUAL_OWNERSHIP_GROUPS) {
        const fields = sheet.fields.filter((field) => group.owners.includes(field.ownership));
        if (fields.length === 0) continue;
        const values = fields
          .map((field) => `${VISUAL_FIELD_LABELS[field.key]}=${field.value}`)
          .join('；');
        lines.push(`  · ${group.label}：${values}`);
      }
    }
    return lines;
  }

  private formatPolicies(policies: RepairEvidencePacket['policies']): string {
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
