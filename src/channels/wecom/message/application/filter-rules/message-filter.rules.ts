import { Injectable, Logger } from '@nestjs/common';
import { EnterpriseMessageCallbackDto } from '../../ingress/message-callback.dto';
import {
  MessageSource,
  MessageType,
  ContactType,
  getMessageSourceDescription,
} from '@enums/message-callback.enum';
import { MessageParser } from '../../utils/message-parser.util';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { CandidateBlacklistService } from '@biz/hosting-config/services/candidate-blacklist.service';
import { CandidateBlacklistItem } from '@biz/hosting-config/entities/candidate-blacklist.entity';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { AlertLevel } from '@enums/alert.enum';
import { FilterReason } from '@enums/message-filter.enum';
import { FilterResult } from '../../types';

export interface MessageFilterRule {
  evaluate(
    messageData: EnterpriseMessageCallbackDto,
  ): Promise<FilterResult | null> | FilterResult | null;
}

@Injectable()
export class SelfMessageFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(SelfMessageFilterRule.name);

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    if (messageData.isSelf !== true) {
      return null;
    }

    this.logger.log(`[过滤-自己发送] 跳过机器人自己发送的消息 [${messageData.messageId}]`);
    return {
      pass: false,
      reason: FilterReason.SELF_MESSAGE,
    };
  }
}

@Injectable()
export class SourceMessageFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(SourceMessageFilterRule.name);

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    if (messageData.source === MessageSource.MOBILE_PUSH) {
      return null;
    }

    const sourceDescription = getMessageSourceDescription(messageData.source);
    this.logger.log(
      `[过滤-消息来源] 跳过非目标来源的消息 [${messageData.messageId}], source=${messageData.source}(${sourceDescription}), 期望=${MessageSource.MOBILE_PUSH}(${getMessageSourceDescription(MessageSource.MOBILE_PUSH)})`,
    );
    return {
      pass: false,
      reason: FilterReason.INVALID_SOURCE,
      details: {
        actual: messageData.source,
        actualDescription: sourceDescription,
        expected: MessageSource.MOBILE_PUSH,
        expectedDescription: getMessageSourceDescription(MessageSource.MOBILE_PUSH),
      },
    };
  }
}

@Injectable()
export class ContactTypeFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(ContactTypeFilterRule.name);

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    if (messageData.contactType === ContactType.PERSONAL_WECHAT) {
      return null;
    }

    this.logger.log(
      `[过滤-客户类型] 跳过非个微用户的消息 [${messageData.messageId}], contactType=${messageData.contactType}, 期望=${ContactType.PERSONAL_WECHAT}(个微)`,
    );
    return {
      pass: false,
      reason: FilterReason.NON_PERSONAL_WECHAT,
      details: {
        actual: messageData.contactType,
        expected: ContactType.PERSONAL_WECHAT,
      },
    };
  }
}

@Injectable()
export class PausedUserFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(PausedUserFilterRule.name);

  constructor(private readonly userHostingService: UserHostingService) {}

  async evaluate(messageData: EnterpriseMessageCallbackDto): Promise<FilterResult | null> {
    const hit = await this.userHostingService.isAnyPaused([
      messageData.chatId,
      messageData.imContactId,
      messageData.externalUserId,
    ]);
    if (!hit.paused) return null;

    const content = MessageParser.extractContent(messageData);
    this.logger.log(
      `[过滤-暂停托管] 暂停托管用户消息仅记录历史 [${messageData.messageId}], matchedId=${hit.matchedId}`,
    );
    return {
      pass: true,
      content,
      historyOnly: true,
      reason: FilterReason.USER_PAUSED,
      details: {
        userId: hit.matchedId!,
      },
    };
  }
}

/**
 * 候选人黑名单过滤规则
 *
 * 运营拉黑候选人后，任一托管账号再次收到该候选人消息时：
 * 1. 飞书告警（附拉黑理由）；
 * 2. 对该会话永久暂停托管（取消托管，不自动解禁）；
 * 3. 消息仅记录历史，不触发 AI 回复。
 *
 * 本规则排在 PausedUserFilterRule 之后：命中后会话被永久暂停，
 * 后续消息由暂停规则短路，保证同一会话只告警一次。
 */
@Injectable()
export class CandidateBlacklistFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(CandidateBlacklistFilterRule.name);

  constructor(
    private readonly candidateBlacklistService: CandidateBlacklistService,
    private readonly userHostingService: UserHostingService,
    private readonly alertNotifier: AlertNotifierService,
  ) {}

  async evaluate(messageData: EnterpriseMessageCallbackDto): Promise<FilterResult | null> {
    const hit = await this.candidateBlacklistService.matchBlacklisted([
      messageData.chatId,
      messageData.imContactId,
      messageData.externalUserId,
    ]);
    if (!hit) return null;

    const content = MessageParser.extractContent(messageData);
    this.logger.warn(
      `[过滤-候选人黑名单] 候选人已被拉黑，告警并取消托管 [${messageData.messageId}], ` +
        `chatId=${messageData.chatId}, targetId=${hit.target_id}, 理由=${hit.reason}`,
    );

    await this.enforceBlacklist(messageData, hit);

    return {
      pass: true,
      content,
      historyOnly: true,
      reason: FilterReason.CANDIDATE_BLACKLISTED,
      details: {
        targetId: hit.target_id,
        blacklistReason: hit.reason,
        chatId: messageData.chatId,
      },
    };
  }

  /**
   * 命中黑名单的处置：永久暂停该会话托管 + 飞书告警（附拉黑理由）
   *
   * 两步互不阻塞过滤主流程：失败仅记日志，消息仍按 historyOnly 处理。
   */
  private async enforceBlacklist(
    messageData: EnterpriseMessageCallbackDto,
    hit: CandidateBlacklistItem,
  ): Promise<void> {
    try {
      await this.userHostingService.pauseUser(messageData.chatId, {
        permanent: true,
        reason: `候选人黑名单：${hit.reason}`,
      });
    } catch (error) {
      this.logger.error(`候选人黑名单命中后暂停托管失败 chatId=${messageData.chatId}`, error);
    }

    try {
      await this.alertNotifier.sendAlert({
        code: 'hosting.candidate-blacklist.hit',
        severity: AlertLevel.WARNING,
        summary: `候选人黑名单命中：已取消该会话托管（拉黑理由：${hit.reason}）`,
        source: {
          subsystem: 'wecom',
          component: 'CandidateBlacklistFilterRule',
          action: 'evaluate',
          trigger: 'queue',
        },
        scope: {
          chatId: messageData.chatId,
          contactName: messageData.contactName,
          userId: hit.target_id,
        },
        impact: {
          userVisible: false,
          requiresHumanIntervention: true,
        },
        diagnostics: {
          payload: {
            targetId: hit.target_id,
            blacklistReason: hit.reason,
            operator: hit.operator,
            imBotId: messageData.imBotId,
            messageId: messageData.messageId,
          },
        },
        dedupe: { key: `candidate-blacklist:${messageData.chatId}` },
      });
    } catch (error) {
      this.logger.error(`候选人黑名单命中告警发送失败 chatId=${messageData.chatId}`, error);
    }
  }
}

@Injectable()
export class GroupBlacklistFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(GroupBlacklistFilterRule.name);

  constructor(private readonly groupBlacklistService: GroupBlacklistService) {}

  async evaluate(messageData: EnterpriseMessageCallbackDto): Promise<FilterResult | null> {
    if (
      !messageData.groupId ||
      !(await this.groupBlacklistService.isGroupBlacklisted(messageData.groupId))
    ) {
      return null;
    }

    const content = MessageParser.extractContent(messageData);
    this.logger.log(
      `[过滤-小组黑名单] 小组在黑名单中，仅记录历史 [${messageData.messageId}], groupId=${messageData.groupId}`,
    );
    return {
      pass: true,
      content,
      historyOnly: true,
      reason: FilterReason.GROUP_BLACKLISTED,
      details: {
        groupId: messageData.groupId,
        orgId: messageData.orgId,
      },
    };
  }
}

@Injectable()
export class RoomMessageFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(RoomMessageFilterRule.name);

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    if (!messageData.imRoomId) {
      return null;
    }

    this.logger.log(
      `[过滤-群聊] 暂时跳过群聊消息 [${messageData.messageId}], roomId=${messageData.imRoomId}`,
    );
    return {
      pass: false,
      reason: FilterReason.ROOM_MESSAGE,
      details: {
        roomId: messageData.imRoomId,
        roomName: messageData.roomName,
      },
    };
  }
}

@Injectable()
export class SupportedMessageTypeFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(SupportedMessageTypeFilterRule.name);
  private readonly supportedMessageTypes = [
    MessageType.FILE,
    MessageType.TEXT,
    MessageType.LOCATION,
    MessageType.VOICE,
    MessageType.EMOTION,
    MessageType.IMAGE,
    MessageType.MINI_PROGRAM,
  ];

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    if (this.supportedMessageTypes.includes(messageData.messageType)) {
      return null;
    }

    this.logger.log(
      `[过滤-非支持类型] 跳过不支持的消息类型 [${messageData.messageId}], messageType=${messageData.messageType}`,
    );
    return {
      pass: false,
      reason: FilterReason.UNSUPPORTED_MESSAGE_TYPE,
      details: {
        messageType: messageData.messageType,
        supportedTypes: this.supportedMessageTypes,
      },
    };
  }
}

@Injectable()
export class EmptyContentFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(EmptyContentFilterRule.name);

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    const content = MessageParser.extractContent(messageData);
    if (content && content.trim().length > 0) {
      return null;
    }

    this.logger.log(`[过滤-空内容] 跳过空内容消息 [${messageData.messageId}]`);
    return {
      pass: false,
      reason: FilterReason.EMPTY_CONTENT,
    };
  }
}
