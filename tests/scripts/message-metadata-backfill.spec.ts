import { buildPatch, sessionIds } from '../../scripts/backfill-agent-long-term-message-metadata';

describe('跨系统元信息回填', () => {
  const row = {
    user_id: 'candidate',
    bot_user_id: 'bot',
    consolidation_watermarks: { bySession: { chat: '2026-10-23' } },
    message_metadata: { contactName: '已有昵称', extension: 'keep' },
  };
  const message = {
    id: 'm',
    chat_id: 'chat',
    role: 'user',
    manager_name: 'bot',
    im_bot_id: 'wx-bot',
    im_contact_id: 'candidate',
    external_user_id: 'external',
    candidate_name: '新昵称',
    contact_type: 'PERSONAL_WECHAT',
    timestamp: '2026-10-23T00:00:00Z',
  };
  it('补齐已核实字段且不覆盖已有值或捏造 botId', () => {
    expect(buildPatch(row, [message])).toEqual({
      imBotId: 'wx-bot',
      imContactId: 'candidate',
      externalUserId: 'external',
      contactType: 1,
    });
    expect(row.message_metadata.extension).toBe('keep');
  });
  it.each([
    { manager_name: 'other' },
    { im_contact_id: 'other' },
    { chat_id: 'other' },
    { role: 'assistant' },
    { is_room: true },
    { is_self: true },
  ])('不混入错身份或消息方向：%j', (change) => {
    expect(buildPatch(row, [{ ...message, ...change }])).toBeNull();
  });
  it('拒绝多 bot 旧行和标识冲突', () => {
    expect(
      buildPatch({ ...row, bot_user_id: null }, [
        message,
        { ...message, manager_name: 'other', im_bot_id: 'wx-other' },
      ]),
    ).toBeNull();
    expect(buildPatch(row, [message, { ...message, external_user_id: 'other' }])).toBeNull();
    expect(buildPatch({ ...row, message_metadata: { imBotId: 'other' } }, [message])).toBeNull();
  });
  it('完整值重复回填无改动，合法零值不覆盖', () => {
    const patch = buildPatch(row, [message]);
    expect(
      buildPatch({ ...row, message_metadata: { ...row.message_metadata, ...patch } }, [message]),
    ).toBeNull();
    expect(
      buildPatch({ ...row, message_metadata: { contactType: 0 } }, [message]),
    ).not.toHaveProperty('contactType');
  });
  it('合并记忆来源，不能把 userId 猜成 chatId', () => {
    expect(sessionIds({ ...row, semantic_profile: { age: { originSessionId: 'chat' } } })).toEqual([
      'chat',
    ]);
    expect(sessionIds({ user_id: 'chat' })).toEqual([]);
  });
});
