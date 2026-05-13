import { ReplyFactGuardService } from '@channels/wecom/message/application/reply-fact-guard.service';
import type { AgentToolCall } from '@/types/agent-telemetry.types';

describe('ReplyFactGuardService', () => {
  const replyFactGuardNotifier = {
    notifyContradiction: jest.fn(),
  };

  let service: ReplyFactGuardService;

  beforeEach(() => {
    jest.clearAllMocks();
    replyFactGuardNotifier.notifyContradiction.mockResolvedValue(true);
    service = new ReplyFactGuardService(replyFactGuardNotifier as never);
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
    expect(replyFactGuardNotifier.notifyContradiction).not.toHaveBeenCalled();
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
    expect(replyFactGuardNotifier.notifyContradiction).not.toHaveBeenCalled();
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
    expect(replyFactGuardNotifier.notifyContradiction).toHaveBeenCalledWith(
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

  it('does NOT flag future-tense follow-up "群里通知" when candidate is presumed already in group', async () => {
    // false-positive 防回归：候选人已经在群里时，Agent 婉拒当前岗位自然带出
    // "后续合适的我在群里通知你"，本轮无需也不该再调 invite_to_group。
    // 强承诺（拉/加/进...群、发群邀请）才要求本轮拉群兜底。
    const result = service.check({
      replyText: '虹口区目前的岗位年龄都在20岁以上，暂时不匹配。后续有合适的我在群里通知你。',
      toolCalls: [],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(false);
  });

  it('does NOT flag "你看群里有人感兴趣吗" when Agent asks candidate to forward jobs to their own group', async () => {
    // false-positive 防回归：候选人想做差价中介，Agent 婉拒并改口让候选人在自己的群里
    // 转发岗位信息（"你有群的话我把岗位发你"），跟 invite_to_group 完全无关。
    const result = service.check({
      replyText:
        '这种赚差价的模式不太行哈，我们这边都是品牌直招。不过你有群的话，我把昌平的岗位发你，大家直接报名也挺方便。你看群里有人感兴趣吗？',
      toolCalls: [
        { toolName: 'duliday_job_list', args: {}, status: 'ok', result: { success: true } },
      ],
      chatId: 'chat-1',
    });
    expect(result.hit).toBe(false);
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
    replyFactGuardNotifier.notifyContradiction.mockRejectedValue(new Error('feishu down'));

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
