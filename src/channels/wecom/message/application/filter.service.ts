import { Injectable } from '@nestjs/common';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageType } from '@enums/message-callback.enum';
import { MessageParser } from '../utils/message-parser.util';
import { FilterResult } from '../types';
import {
  ContactTypeFilterRule,
  EmptyContentFilterRule,
  EnterpriseGroupFilterRule,
  GroupBlacklistFilterRule,
  MessageFilterRule,
  PausedUserFilterRule,
  RoomMessageFilterRule,
  SelfMessageFilterRule,
  SourceMessageFilterRule,
  SupportedMessageTypeFilterRule,
} from './filter-rules/message-filter.rules';

export { FilterReason } from '@enums/message-filter.enum';
export type { FilterResult } from '../types';

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
  private readonly rules: MessageFilterRule[];

  constructor(
    selfMessageFilterRule: SelfMessageFilterRule,
    sourceMessageFilterRule: SourceMessageFilterRule,
    contactTypeFilterRule: ContactTypeFilterRule,
    pausedUserFilterRule: PausedUserFilterRule,
    groupBlacklistFilterRule: GroupBlacklistFilterRule,
    enterpriseGroupFilterRule: EnterpriseGroupFilterRule,
    roomMessageFilterRule: RoomMessageFilterRule,
    supportedMessageTypeFilterRule: SupportedMessageTypeFilterRule,
    emptyContentFilterRule: EmptyContentFilterRule,
  ) {
    this.rules = [
      selfMessageFilterRule,
      sourceMessageFilterRule,
      contactTypeFilterRule,
      pausedUserFilterRule,
      groupBlacklistFilterRule,
      enterpriseGroupFilterRule,
      roomMessageFilterRule,
      supportedMessageTypeFilterRule,
      emptyContentFilterRule,
    ];
  }

  /**
   * 验证消息是否应该被处理
   * 返回过滤结果，包含是否通过和原因
   */
  async validate(messageData: EnterpriseMessageCallbackDto): Promise<FilterResult> {
    for (const rule of this.rules) {
      const result = await rule.evaluate(messageData);
      if (result) {
        return result;
      }
    }

    return {
      pass: true,
      content: MessageParser.extractContent(messageData),
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
