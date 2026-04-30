import {
  ContactTypeFilterRule,
  EmptyContentFilterRule,
  GroupBlacklistFilterRule,
  PausedUserFilterRule,
  RoomMessageFilterRule,
  SelfMessageFilterRule,
  SourceMessageFilterRule,
  SupportedMessageTypeFilterRule,
} from '@channels/wecom/message/application/filter-rules/message-filter.rules';
import { EnterpriseMessageCallbackDto } from '@channels/wecom/message/ingress/message-callback.dto';
import { FilterReason } from '@enums/message-filter.enum';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';

describe('MessageFilterRules', () => {
  it('SelfMessageFilterRule should reject self-authored messages', () => {
    const rule = new SelfMessageFilterRule();

    expect(rule.evaluate(createMessage({ isSelf: true }))).toEqual({
      pass: false,
      reason: FilterReason.SELF_MESSAGE,
    });
  });

  it('SourceMessageFilterRule should reject non-mobile-push messages', () => {
    const rule = new SourceMessageFilterRule();

    expect(rule.evaluate(createMessage({ source: MessageSource.API_SEND }))).toEqual(
      expect.objectContaining({
        pass: false,
        reason: FilterReason.INVALID_SOURCE,
      }),
    );
  });

  it('ContactTypeFilterRule should reject non-personal-wechat contacts', () => {
    const rule = new ContactTypeFilterRule();

    expect(rule.evaluate(createMessage({ contactType: ContactType.ENTERPRISE_WECHAT }))).toEqual(
      expect.objectContaining({
        pass: false,
        reason: FilterReason.NON_PERSONAL_WECHAT,
      }),
    );
  });

  it('PausedUserFilterRule should downgrade paused users to history-only handling', async () => {
    const userHostingService = {
      isAnyPaused: jest
        .fn()
        .mockResolvedValue({ paused: true, matchedId: 'external-user-1' }),
    };
    const rule = new PausedUserFilterRule(userHostingService as never);

    await expect(
      rule.evaluate(
        createMessage({
          externalUserId: 'external-user-1',
        }),
      ),
    ).resolves.toEqual({
      pass: true,
      content: '你好',
      historyOnly: true,
      reason: FilterReason.USER_PAUSED,
      details: {
        userId: 'external-user-1',
      },
    });
  });

  it('GroupBlacklistFilterRule should downgrade blacklisted groups to history-only handling', async () => {
    const groupBlacklistService = {
      isGroupBlacklisted: jest.fn().mockResolvedValue(true),
    };
    const rule = new GroupBlacklistFilterRule(groupBlacklistService as never);

    await expect(
      rule.evaluate(
        createMessage({
          groupId: 'group-1',
        }),
      ),
    ).resolves.toEqual({
      pass: true,
      content: '你好',
      historyOnly: true,
      reason: FilterReason.GROUP_BLACKLISTED,
      details: {
        groupId: 'group-1',
        orgId: 'corp-1',
      },
    });
  });

  it('RoomMessageFilterRule should reject room messages', () => {
    const rule = new RoomMessageFilterRule();

    expect(rule.evaluate(createMessage({ imRoomId: 'room-1', roomName: '候选人群' }))).toEqual({
      pass: false,
      reason: FilterReason.ROOM_MESSAGE,
      details: {
        roomId: 'room-1',
        roomName: '候选人群',
      },
    });
  });

  it('SupportedMessageTypeFilterRule should reject unsupported message types', () => {
    const rule = new SupportedMessageTypeFilterRule();

    expect(rule.evaluate(createMessage({ messageType: MessageType.FILE }))).toEqual(
      expect.objectContaining({
        pass: false,
        reason: FilterReason.UNSUPPORTED_MESSAGE_TYPE,
      }),
    );
  });

  it('EmptyContentFilterRule should reject blank content', () => {
    const rule = new EmptyContentFilterRule();

    expect(
      rule.evaluate(
        createMessage({
          payload: {
            text: '   ',
            pureText: '   ',
          },
        }),
      ),
    ).toEqual({
      pass: false,
      reason: FilterReason.EMPTY_CONTENT,
    });
  });
});

function createMessage(
  overrides: Partial<EnterpriseMessageCallbackDto> = {},
): EnterpriseMessageCallbackDto {
  return {
    orgId: 'corp-1',
    token: 'token-1',
    botId: 'bot-1',
    botUserId: 'manager-1',
    imBotId: 'im-bot-1',
    chatId: 'chat-1',
    imContactId: 'im-contact-1',
    messageType: MessageType.TEXT,
    messageId: 'msg-1',
    timestamp: '1713168000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: {
      text: '你好',
      pureText: '你好',
    },
    contactName: '张三',
    externalUserId: 'external-1',
    _apiType: 'enterprise',
    ...overrides,
  } as EnterpriseMessageCallbackDto;
}
