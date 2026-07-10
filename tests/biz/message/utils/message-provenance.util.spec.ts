import { isHumanAgentTextMessage } from '@biz/message/utils/message-provenance.util';
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
});
