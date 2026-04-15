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
import { UserHostingService } from '@biz/user/services/user-hosting.service';
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
    const pauseCheckIds = [
      messageData.chatId,
      messageData.imContactId,
      messageData.externalUserId,
    ].filter(Boolean) as string[];

    for (const id of pauseCheckIds) {
      if (await this.userHostingService.isUserPaused(id)) {
        const content = MessageParser.extractContent(messageData);
        this.logger.log(
          `[过滤-暂停托管] 暂停托管用户消息仅记录历史 [${messageData.messageId}], matchedId=${id}`,
        );
        return {
          pass: true,
          content,
          historyOnly: true,
          reason: FilterReason.USER_PAUSED,
          details: {
            userId: id,
          },
        };
      }
    }

    return null;
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
export class EnterpriseGroupFilterRule implements MessageFilterRule {
  private readonly logger = new Logger(EnterpriseGroupFilterRule.name);
  private readonly blockedEnterpriseGroupId = '691d3b171535fed6bcc94f66';

  evaluate(messageData: EnterpriseMessageCallbackDto): FilterResult | null {
    const isEnterpriseMessage = messageData._apiType !== 'group';
    if (!isEnterpriseMessage || messageData.groupId !== this.blockedEnterpriseGroupId) {
      return null;
    }

    this.logger.log(
      `[过滤-企业级分组] 跳过特定企业级分组的消息 [${messageData.messageId}], groupId=${messageData.groupId}, orgId=${messageData.orgId}`,
    );
    return {
      pass: false,
      reason: FilterReason.BLOCKED_ENTERPRISE_GROUP,
      details: {
        groupId: messageData.groupId,
        orgId: messageData.orgId,
        apiType: messageData._apiType || 'enterprise',
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
