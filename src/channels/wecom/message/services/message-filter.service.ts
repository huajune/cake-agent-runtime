import { Injectable, Logger } from '@nestjs/common';
import {
  EnterpriseMessageCallbackDto,
  MessageSource,
  MessageType,
  ContactType,
  getMessageSourceDescription,
} from '../dto/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

/**
 * 消息过滤原因枚举
 * 用于标识消息被过滤的具体原因
 */
export enum FilterReason {
  /** 机器人自己发送的消息 */
  SELF_MESSAGE = 'self-message',
  /** 非手机推送来源（非真实用户发送） */
  INVALID_SOURCE = 'invalid-source',
  /** 非个微用户（企微、公众号等） */
  NON_PERSONAL_WECHAT = 'non-personal-wechat',
  /** 用户已暂停托管 */
  USER_PAUSED = 'user-paused',
  /** 小组在黑名单中（仅记录历史） */
  GROUP_BLACKLISTED = 'group-blacklisted',
  /** 企业级特定分组被屏蔽 */
  BLOCKED_ENTERPRISE_GROUP = 'blocked-enterprise-group',
  /** 群聊消息（暂不处理） */
  ROOM_MESSAGE = 'room-message',
  /** 不支持的消息类型 */
  UNSUPPORTED_MESSAGE_TYPE = 'unsupported-message-type',
  /** 消息内容为空 */
  EMPTY_CONTENT = 'empty-content',
}

/**
 * 消息过滤结果
 */
export interface FilterResult {
  pass: boolean; // 是否通过过滤
  reason?: FilterReason; // 过滤原因（未通过时）
  content?: string; // 提取的消息内容（通过时）
  details?: any; // 额外的详细信息
  historyOnly?: boolean; // 是否仅记录历史（不触发AI回复）
}

/**
 * 消息过滤服务
 * 负责对接收到的消息进行各种过滤检查
 * 只处理：私聊、用户发送、手机推送、文本消息、非空内容
 *
 * 黑名单规则：
 * - 企业级消息：排除特定 groupId (691d3b171535fed6bcc94f66)
 * - 小组级消息：不应用 groupId 黑名单，允许通过
 */
@Injectable()
export class MessageFilterService {
  private readonly logger = new Logger(MessageFilterService.name);

  constructor(
    private readonly userHostingService: UserHostingService,
    private readonly groupBlacklistService: GroupBlacklistService,
  ) {}

  /**
   * 验证消息是否应该被处理
   * 返回过滤结果，包含是否通过和原因
   */
  async validate(messageData: EnterpriseMessageCallbackDto): Promise<FilterResult> {
    // 1. 拦截机器人自己发送的消息
    if (messageData.isSelf === true) {
      this.logger.log(`[过滤-自己发送] 跳过机器人自己发送的消息 [${messageData.messageId}]`);
      return {
        pass: false,
        reason: FilterReason.SELF_MESSAGE,
      };
    }

    // 2. 只处理手机推送的消息（真实用户发送）
    const sourceDescription = getMessageSourceDescription(messageData.source);
    if (messageData.source !== MessageSource.MOBILE_PUSH) {
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

    // 2.5 只处理个微用户的消息（企微、公众号消息不触发 AI 回复）
    if (messageData.contactType !== ContactType.PERSONAL_WECHAT) {
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

    // 2.6 检查用户是否被暂停托管
    // 使用 imContactId 作为用户标识（私聊场景）
    const userId = messageData.imContactId || messageData.externalUserId;
    if (userId && (await this.userHostingService.isUserPaused(userId))) {
      this.logger.log(
        `[过滤-暂停托管] 跳过暂停托管用户的消息 [${messageData.messageId}], userId=${userId}`,
      );
      return {
        pass: false,
        reason: FilterReason.USER_PAUSED,
        details: {
          userId,
        },
      };
    }

    // 2.7 检查小组是否在黑名单中（仅记录历史，不触发AI回复）
    if (
      messageData.groupId &&
      (await this.groupBlacklistService.isGroupBlacklisted(messageData.groupId))
    ) {
      const content = MessageParser.extractContent(messageData);
      this.logger.log(
        `[过滤-小组黑名单] 小组在黑名单中，仅记录历史 [${messageData.messageId}], groupId=${messageData.groupId}`,
      );
      return {
        pass: true, // 标记为通过，但设置 historyOnly 标志
        content,
        historyOnly: true,
        reason: FilterReason.GROUP_BLACKLISTED,
        details: {
          groupId: messageData.groupId,
          orgId: messageData.orgId,
        },
      };
    }

    // 3. 过滤企业级特定 groupId 的消息（仅对企业级消息生效，不影响小组级消息）
    const isEnterpriseMessage = messageData._apiType !== 'group';
    if (isEnterpriseMessage && messageData.groupId === '691d3b171535fed6bcc94f66') {
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

    // 4. 暂时跳过群聊消息
    const isRoom = !!messageData.imRoomId;
    if (isRoom) {
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

    // 5. 只处理文本消息和位置消息
    const supportedMessageTypes = [MessageType.TEXT, MessageType.LOCATION];
    if (!supportedMessageTypes.includes(messageData.messageType)) {
      this.logger.log(
        `[过滤-非支持类型] 跳过不支持的消息类型 [${messageData.messageId}], messageType=${messageData.messageType}`,
      );
      return {
        pass: false,
        reason: FilterReason.UNSUPPORTED_MESSAGE_TYPE,
        details: {
          messageType: messageData.messageType,
          supportedTypes: supportedMessageTypes,
        },
      };
    }

    // 6. 检查消息内容是否为空
    const content = MessageParser.extractContent(messageData);
    if (!content || content.trim().length === 0) {
      this.logger.log(`[过滤-空内容] 跳过空内容消息 [${messageData.messageId}]`);
      return {
        pass: false,
        reason: FilterReason.EMPTY_CONTENT,
      };
    }

    // 全部通过，返回提取的内容
    return {
      pass: true,
      content,
    };
  }

  /**
   * 检查消息是否 @ 了机器人
   * 注意：此方法为未来群聊 @ 触发功能预留，当实现群聊场景时会用到
   */
  checkMentioned(messageData: EnterpriseMessageCallbackDto, botWxid: string): boolean {
    // 只有文本消息才支持 @（位置消息不支持）
    if (messageData.messageType !== MessageType.TEXT) {
      return false;
    }

    const payload = messageData.payload as any;

    // 检查 payload 中是否有 mention 字段
    if (!payload.mention || !Array.isArray(payload.mention)) {
      return false;
    }

    // 检查 mention 列表中是否包含机器人的 wxid 或者是否 @all
    return payload.mention.includes(botWxid) || payload.mention.includes('@all');
  }
}
