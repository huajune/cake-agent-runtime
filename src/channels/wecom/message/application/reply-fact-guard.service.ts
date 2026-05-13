import { Injectable, Logger } from '@nestjs/common';
import { AgentToolCall } from '@agent/agent-run.types';
import { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';

/**
 * 单条事实矛盾规则：reply 中出现 `keywords` 任一时，要求本轮 tool 调用满足
 * `requiredToolPredicate`；否则判定为"事实矛盾"。
 */
interface FactRule {
  ruleId: string;
  label: string;
  keywords: RegExp;
  requiredToolPredicate: (toolCalls: AgentToolCall[]) => boolean;
}

/**
 * Reply 后置事实对账（Phase 1：仅告警，不改写）。
 *
 * 设计目的：拦截 Agent 在确认轮 / 收尾轮"自由发挥"——即没有真正调任何工具
 * 却声称动态事实（群人数、库存、距离、薪资）。历史 badcase i41pab8n：
 * 上一轮 invite_to_group 已成功，本轮用户回"好的"，Agent 无 tool 调用
 * 编出"群里人数满了"。
 *
 * Phase 1：只 logger.warn + 飞书告警，不改写 reply（避免误杀真有信息的回复）。
 * 飞书数据积累 1-2 周后，再决定是否升级到 Phase 2（命中即静默 drop）。
 *
 * 规则维护：[reply-fact-guard.keywords.ts] 单独文件，独立可读。
 */
@Injectable()
export class ReplyFactGuardService {
  private readonly logger = new Logger(ReplyFactGuardService.name);

  /** 本轮 invite_to_group 真正成功了（用于规则 requiredToolPredicate）。 */
  private static inviteCalledSuccessfully(toolCalls: AgentToolCall[]): boolean {
    return toolCalls.some(
      (call) =>
        call.toolName === 'invite_to_group' &&
        (call.status === 'ok' ||
          (typeof call.result === 'object' &&
            call.result !== null &&
            (call.result as Record<string, unknown>).success === true)),
    );
  }

  private readonly rules: FactRule[] = [
    {
      ruleId: 'group_full_without_invite',
      label: '声称群满/群解散但本轮未成功调 invite_to_group（badcase i41pab8n）',
      keywords:
        /群已满|群里人数满|群人数已满|邀请暂时发不过去|拉不进群|拉群没成功|群已解散|群里满了/,
      requiredToolPredicate: (toolCalls) =>
        ReplyFactGuardService.inviteCalledSuccessfully(toolCalls),
    },
    {
      ruleId: 'group_promise_without_invite',
      label: '承诺"拉/邀请进群"但本轮未成功调 invite_to_group（badcase gay6j94c）',
      // 仅匹配"本轮要拉群"的强承诺，必须有 invite_to_group 成功兜底，否则就是空头承诺。
      // 不匹配"群里通知/群更新/关注群"等 future-tense 弱承诺——这些话术常出现在候选人
      // 已在群里的会话中（"后续合适的我在群里通知你"），未来 follow-up 不要求本轮拉群。
      // 弱承诺误报场景（false positive）：候选人此前已被拉过群，Agent 婉拒当前岗位时
      // 自然带出"群里通知你"，本轮无需也不该再调 invite_to_group。
      // 弱承诺真要监控，需要 invitedGroups 记忆豁免，留待 phase 2 升级时一起做。
      // [^。，,；！？\s]{0,15} 允许"拉你"与"群"之间夹任意修饰词（"拉你进咱们餐饮兼职群"），
      // 但禁止跨标点，避免误吃到下一句的"群里通知你"上。
      keywords:
        /拉(?:你|您)[^。，,；！？\s]{0,15}?群|进(?:咱们|我们|这个|这|这边)[^。，,；！？\s]{0,15}?群|加(?:你|您)[^。，,；！？\s]{0,15}?群|发(?:个|一个|条)?(?:入)?群邀请/,
      requiredToolPredicate: (toolCalls) =>
        ReplyFactGuardService.inviteCalledSuccessfully(toolCalls),
    },
  ];

  constructor(private readonly replyFactGuardNotifier: ReplyFactGuardNotifierService) {}

  /**
   * 检查 reply 是否与本轮 tool 调用矛盾。命中即日志告警，不改写文本。
   *
   * @returns 命中的规则；调用方可记 anomaly_flag、用于后续 phase 2 改写决策
   */
  check(params: {
    replyText: string;
    toolCalls: AgentToolCall[] | undefined;
    chatId?: string;
    userId?: string;
    botImId?: string;
    botUserName?: string;
  }): { hit: boolean; contradictions: Array<{ ruleId: string; label: string }> } {
    const text = params.replyText ?? '';
    if (!text.trim()) return { hit: false, contradictions: [] };

    const toolCalls = params.toolCalls ?? [];
    const contradictions: Array<{ ruleId: string; label: string }> = [];

    for (const rule of this.rules) {
      if (!rule.keywords.test(text)) continue;
      if (rule.requiredToolPredicate(toolCalls)) continue;
      contradictions.push({ ruleId: rule.ruleId, label: rule.label });
    }

    if (contradictions.length === 0) return { hit: false, contradictions: [] };

    this.logger.warn(
      `[ReplyFactGuard] 命中事实矛盾: chatId=${params.chatId ?? '-'}, userId=${params.userId ?? '-'}, rules=${contradictions
        .map((c) => c.ruleId)
        .join(',')}, replyPreview="${text.slice(0, 80)}"`,
    );

    // 飞书告警 fire-and-forget——不阻塞回复链路
    void this.replyFactGuardNotifier
      .notifyContradiction({
        chatId: params.chatId,
        userId: params.userId,
        botImId: params.botImId,
        botUserName: params.botUserName,
        replyPreview: text.slice(0, 400),
        contradictions,
        toolNames: toolCalls.map((c) => c.toolName),
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[ReplyFactGuard] 飞书告警发送失败: ${message}`);
      });

    return { hit: true, contradictions };
  }
}
