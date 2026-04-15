import { Injectable, Logger } from '@nestjs/common';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { SessionService } from '@memory/services/session.service';
import { OnboardFollowupNotifierService } from '@notification/services/onboard-followup-notifier.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { MessageParser } from '@wecom/message/utils/message-parser.util';
import { RecruitmentCaseService } from './recruitment-case.service';
import { RecruitmentStageResolverService } from './recruitment-stage-resolver.service';

const ALERT_WINDOW_MS = 5 * 60 * 1000;

const HANDOFF_RULES: Array<{ label: string; reason: string; patterns: RegExp[] }> = [
  {
    label: '找不到门店',
    reason: '候选人反馈找不到门店或定位异常，需要人工协助到店对接',
    patterns: [/找不到.*门店/, /找不到.*店/, /门店.*找不到/, /定位.*不对/, /导航.*不到/],
  },
  {
    label: '到店无人接待',
    reason: '候选人到店后无人接待或联系不上负责人，需要人工介入协调',
    patterns: [/到店.*没人/, /没人接待/, /没人理/, /店长.*不在/, /联系不上/, /电话.*打不通/],
  },
  {
    label: '预约信息冲突',
    reason: '候选人反馈门店查不到预约或现场信息冲突，需要人工核实',
    patterns: [/没有.*预约/, /查不到.*预约/, /门店.*没有.*预约/, /店里说.*没有.*预约/],
  },
  {
    label: '入职办理异常',
    reason: '候选人进入办理入职或上岗对接异常场景，需要人工协助处理',
    patterns: [/办理.*入职/, /入职.*办理/, /入职手续/, /上岗.*对接/, /报到.*怎么办/],
  },
];

@Injectable()
export class OnboardFollowupMonitorService {
  private readonly logger = new Logger(OnboardFollowupMonitorService.name);
  private readonly alertWindows = new Map<string, number>();

  constructor(
    private readonly recruitmentCaseService: RecruitmentCaseService,
    private readonly stageResolver: RecruitmentStageResolverService,
    private readonly userHostingService: UserHostingService,
    private readonly chatSessionService: ChatSessionService,
    private readonly sessionService: SessionService,
    private readonly notifierService: OnboardFollowupNotifierService,
  ) {}

  async checkAndHandle(params: {
    messageData: EnterpriseMessageCallbackDto;
    content: string;
  }): Promise<{ hit: boolean; paused: boolean; alerted: boolean; reason?: string }> {
    const parsed = MessageParser.parse(params.messageData);
    const chatId = parsed.chatId;
    const corpId = parsed.orgId || 'default';
    const userId = parsed.imContactId || parsed.externalUserId || chatId;
    const pauseTargetId = chatId || userId;
    const content = params.content?.trim() ?? '';

    if (!chatId || !userId || !content) {
      return { hit: false, paused: false, alerted: false };
    }

    const activeCase = await this.recruitmentCaseService.getActiveOnboardFollowupCase({
      corpId,
      chatId,
    });
    if (!activeCase) {
      return { hit: false, paused: false, alerted: false };
    }

    if (!this.stageResolver.isRelevantToOnboardFollowup(content, activeCase)) {
      return { hit: false, paused: false, alerted: false };
    }

    const matchedRule = HANDOFF_RULES.find((rule) =>
      rule.patterns.some((pattern) => pattern.test(this.normalize(content))),
    );
    if (!matchedRule) {
      return { hit: false, paused: false, alerted: false };
    }

    const alreadyPaused = await this.userHostingService.isUserPaused(pauseTargetId);
    if (alreadyPaused) {
      return { hit: true, paused: false, alerted: false, reason: 'already-paused' };
    }

    await this.userHostingService.pauseUser(pauseTargetId);
    await this.recruitmentCaseService.markHandoff(activeCase.id);

    if (!this.reserveAlertSlot(pauseTargetId)) {
      return { hit: true, paused: true, alerted: false, reason: matchedRule.reason };
    }

    const [recentMessages, sessionState] = await Promise.all([
      this.chatSessionService.getChatHistory(chatId, 10),
      this.sessionService.getSessionState(corpId, userId, chatId),
    ]);

    const alerted = await this.notifierService.notify({
      botImId: parsed.imBotId,
      alertLabel: matchedRule.label,
      reason: matchedRule.reason,
      chatId,
      pausedUserId: pauseTargetId,
      contactName: parsed.contactName,
      botUserName: parsed.managerName,
      currentMessageContent: content,
      recentMessages: recentMessages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      })),
      sessionState,
      recruitmentCase: activeCase,
    });

    if (!alerted) {
      this.alertWindows.delete(pauseTargetId);
    }

    this.logger.warn(
      `[OnboardFollowup] 命中人工介入: chatId=${chatId}, caseId=${activeCase.id}, label=${matchedRule.label}`,
    );

    return { hit: true, paused: true, alerted, reason: matchedRule.reason };
  }

  private reserveAlertSlot(key: string): boolean {
    const now = Date.now();
    const lastSentAt = this.alertWindows.get(key);
    if (lastSentAt && now - lastSentAt < ALERT_WINDOW_MS) {
      return false;
    }
    this.alertWindows.set(key, now);
    return true;
  }

  private normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, '');
  }
}
