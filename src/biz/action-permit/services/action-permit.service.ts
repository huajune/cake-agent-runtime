import { Inject, Injectable } from '@nestjs/common';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { CandidateBlacklistService } from '@biz/candidate-blacklist/services/candidate-blacklist.service';
import {
  BOT_ACCOUNT_PROVIDER,
  type BotAccountProvider,
} from '@biz/ops-events/providers/bot-account.provider';

export type PermittedAction = 'reply' | 'proactive' | 'tool';
export type ActionDenialReason =
  | 'global_disabled'
  | 'hosting_paused'
  | 'candidate_blacklisted'
  | 'group_blacklisted'
  | 'receiving_bot_not_hosted'
  | 'permit_unavailable';
export interface ActionPermitInput {
  chatId: string;
  action: PermittedAction;
  botImId?: string;
  groupId?: string;
  /** 人级黑名单身份；禁止将这些 ID 用来推导聊天暂停。 */
  candidateIds?: readonly (string | undefined | null)[];
}
export type ActionPermit =
  | { allowed: true; reason?: never; pauseExpiresAt?: never }
  | { allowed: false; reason: ActionDenialReason; pauseExpiresAt?: number | null };

@Injectable()
export class ActionPermitService {
  constructor(
    private readonly hosting: UserHostingService,
    private readonly systemConfig: SystemConfigService,
    private readonly groups: GroupBlacklistService,
    private readonly blacklist: CandidateBlacklistService,
    @Inject(BOT_ACCOUNT_PROVIDER) private readonly bots: BotAccountProvider,
  ) {}

  async evaluate(input: ActionPermitInput): Promise<ActionPermit> {
    try {
      const enabled =
        input.action === 'proactive'
          ? (await this.systemConfig.getAgentReplyConfig()).reengagementEnabled
          : await this.systemConfig.getAiReplyEnabled();
      if (!enabled) return { allowed: false, reason: 'global_disabled' };
      // 接管作用域是聊天，A bot 对话接管不得暂停同一候选人的 B bot 对话。
      const pause = await this.hosting.getChatPause(input.chatId);
      if (pause.paused)
        return { allowed: false, reason: 'hosting_paused', pauseExpiresAt: pause.expiresAt };
      if (await this.blacklist.matchBlacklisted([input.chatId, ...(input.candidateIds ?? [])])) {
        return { allowed: false, reason: 'candidate_blacklisted' };
      }
      if (!input.botImId?.trim()) return { allowed: false, reason: 'receiving_bot_not_hosted' };
      const botId = input.botImId.trim();
      const bots = await this.bots.getConfiguredBotList();
      const bot = bots.find((entry) =>
        [entry.wxid, entry.id, entry.weixin, entry.wecomUserId].some((id) => id?.trim() === botId),
      );
      if (!bot) return { allowed: false, reason: 'receiving_bot_not_hosted' };
      // 2026-10-15 业务裁定：小组关闭仅停被动 AI，面试提醒/回访继续。
      const groupId = input.groupId ?? bot.groupId;
      if (
        input.action !== 'proactive' &&
        groupId &&
        (await this.groups.isGroupBlacklisted(groupId))
      ) {
        return { allowed: false, reason: 'group_blacklisted' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'permit_unavailable' };
    }
  }
}
