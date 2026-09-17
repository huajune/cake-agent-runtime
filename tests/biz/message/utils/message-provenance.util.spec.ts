import {
  isAgentReplyTextMessage,
  isHumanAgentTextMessage,
} from '@biz/message/utils/message-provenance.util';
import {
  StorageMessageSource,
  StorageMessageType,
  toStorageMessageSource,
} from '@enums/storage-message.enum';

describe('message-provenance.util', () => {
  const manualText = {
    role: 'assistant',
    isSelf: true,
    messageType: StorageMessageType.TEXT,
    source: StorageMessageSource.MOBILE_PUSH,
  };

  it.each([StorageMessageSource.MOBILE_PUSH, StorageMessageSource.AGGREGATED_CHAT_MANUAL])(
    'recognizes manual human-agent text from %s',
    (source) => {
      expect(isHumanAgentTextMessage({ ...manualText, source })).toBe(true);
    },
  );

  it.each([
    ['user role', { role: 'user' }],
    ['not self-sent', { isSelf: false }],
    ['missing self marker', { isSelf: undefined }],
    ['non-text message', { messageType: StorageMessageType.IMAGE }],
    ['missing message type', { messageType: undefined }],
    ['API send source', { source: StorageMessageSource.API_SEND }],
    ['AI reply source', { source: StorageMessageSource.AI_REPLY }],
    ['missing source', { source: undefined }],
    ['reengagement payload', { payloadSource: 'reengagement' }],
  ])('rejects %s', (_label, overrides) => {
    expect(isHumanAgentTextMessage({ ...manualText, ...overrides })).toBe(false);
  });

  it('keeps a missing persisted source untrusted after normalization', () => {
    const source = toStorageMessageSource(undefined);

    expect(source).toBe(StorageMessageSource.UNKNOWN);
    expect(isHumanAgentTextMessage({ ...manualText, source })).toBe(false);
  });

  describe('isAgentReplyTextMessage', () => {
    const agentText = {
      role: 'assistant',
      isSelf: true,
      messageType: StorageMessageType.TEXT,
      source: StorageMessageSource.API_SEND,
    };

    it.each([StorageMessageSource.API_SEND, StorageMessageSource.AI_REPLY])(
      'recognizes agent reply text from %s',
      (source) => {
        expect(isAgentReplyTextMessage({ ...agentText, source })).toBe(true);
      },
    );

    it.each([
      ['user role', { role: 'user' }],
      ['non-text message', { messageType: StorageMessageType.ROOM_INVITE }],
      ['missing message type', { messageType: undefined }],
      ['human manual source', { source: StorageMessageSource.MOBILE_PUSH }],
      ['missing source', { source: undefined }],
      ['reengagement proactive touch', { payloadSource: 'reengagement' }],
    ])('rejects %s', (_label, overrides) => {
      expect(isAgentReplyTextMessage({ ...agentText, ...overrides })).toBe(false);
    });

    it('is disjoint from human manual text', () => {
      const manual = { ...agentText, source: StorageMessageSource.MOBILE_PUSH };
      expect(isHumanAgentTextMessage(manual)).toBe(true);
      expect(isAgentReplyTextMessage(manual)).toBe(false);
    });
  });
});
