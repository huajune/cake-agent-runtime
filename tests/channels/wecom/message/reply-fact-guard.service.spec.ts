import { ReplyFactGuardService } from '@channels/wecom/message/application/reply-fact-guard.service';
import type { AgentToolCall } from '@/types/agent-telemetry.types';

describe('ReplyFactGuardService', () => {
  const opsNotifier = {
    sendReplyFactContradictionAlert: jest.fn(),
  };

  let service: ReplyFactGuardService;

  beforeEach(() => {
    jest.clearAllMocks();
    opsNotifier.sendReplyFactContradictionAlert.mockResolvedValue(true);
    service = new ReplyFactGuardService(opsNotifier as never);
  });

  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  const makeInviteCall = (overrides: Partial<AgentToolCall> = {}): AgentToolCall => ({
    toolName: 'invite_to_group',
    args: {},
    status: 'ok',
    result: { success: true },
    ...overrides,
  });

  it('returns hit=false when reply has no group-full-related keywords', async () => {
    const result = service.check({
      replyText: '好的，我帮你登记下面试时间。',
      toolCalls: [],
      chatId: 'chat-1',
    });

    expect(result).toEqual({ hit: false, contradictions: [] });
    expect(opsNotifier.sendReplyFactContradictionAlert).not.toHaveBeenCalled();
  });

  it('returns hit=false when reply claims group full AND invite_to_group succeeded this turn (legit)', async () => {
    // 即使有"群人数满"这种描述，只要本轮 invite_to_group 真正成功，可视为合理
    // —— 但 phase 1 规则故意更保守：成功调用即放行
    const result = service.check({
      replyText: '不好意思群已满',
      toolCalls: [makeInviteCall()],
      chatId: 'chat-1',
    });

    expect(result).toEqual({ hit: false, contradictions: [] });
    expect(opsNotifier.sendReplyFactContradictionAlert).not.toHaveBeenCalled();
  });

  it('flags contradiction when reply says 群已满 but no invite_to_group this turn', async () => {
    const result = service.check({
      replyText: '不好意思哈，刚确认了下目前群里人数满了，邀请暂时发不过去。',
      toolCalls: [],
      chatId: 'chat-1',
      userId: 'user-1',
      botImId: 'bot-1',
      botUserName: 'mgr-bob',
    });

    expect(result.hit).toBe(true);
    expect(result.contradictions).toEqual([
      expect.objectContaining({ ruleId: 'group_full_without_invite' }),
    ]);

    await flushAsync();
    expect(opsNotifier.sendReplyFactContradictionAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        botImId: 'bot-1',
        botUserName: 'mgr-bob',
        replyPreview: expect.stringContaining('群里人数满了'),
        contradictions: expect.arrayContaining([
          expect.objectContaining({ ruleId: 'group_full_without_invite' }),
        ]),
        toolNames: [],
      }),
    );
  });

  it('flags contradiction when reply promises 拉群/群里通知 but no invite_to_group success this turn (badcase gay6j94c 同类)', async () => {
    const result = service.check({
      replyText: '行，那我拉你进咱们餐饮兼职群，后面有合适的岗位我直接群里通知你。',
      toolCalls: [],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(true);
    expect(result.contradictions[0].ruleId).toBe('group_promise_without_invite');
  });

  it('does NOT flag promise when invite_to_group success backs it', async () => {
    const result = service.check({
      replyText: '我拉你进群了，后面有合适的群里通知你。',
      toolCalls: [makeInviteCall()],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(false);
  });

  it('flags contradiction when invite_to_group was called but failed this turn (no success)', async () => {
    // 真实场景：invite_to_group 返回 reason: 'no_group_in_city'，本轮文本不应再说"群已满"
    const result = service.check({
      replyText: '帮你看了下，群已解散了，下次有合适的再通知你。',
      toolCalls: [
        makeInviteCall({
          status: 'unknown',
          result: { success: false, reason: 'no_group_in_city' },
        }),
      ],
      chatId: 'chat-1',
    });

    expect(result.hit).toBe(true);
    expect(result.contradictions[0].ruleId).toBe('group_full_without_invite');
  });

  it('does not throw when reply is empty', async () => {
    const result = service.check({ replyText: '', toolCalls: [] });
    expect(result).toEqual({ hit: false, contradictions: [] });
  });

  it('does not throw if ops notifier alert rejects (fire-and-forget)', async () => {
    opsNotifier.sendReplyFactContradictionAlert.mockRejectedValue(new Error('feishu down'));

    const result = service.check({
      replyText: '群已满了',
      toolCalls: [],
      chatId: 'chat-1',
    });

    expect(result.hit).toBe(true);
    await flushAsync();
    // 不应抛
  });
});
