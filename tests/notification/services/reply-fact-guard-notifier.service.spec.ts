import { Logger } from '@nestjs/common';
import { BOT_TO_RECEIVER, FeishuReceiver } from '@infra/feishu/constants/receivers';
import { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';
import type { OpsCardRenderer } from '@notification/renderers/ops-card.renderer';

/**
 * 设计意图：本 spec 不写死任何具体 receiver 身份（GAO_YAQI / AI_JIANG …），也不
 * 写死任何具体 bot imId。BOT_TO_RECEIVER 随接客 bot 持续更新，fallback receiver
 * 也可能调整——测试只应校验 notifier 的「逻辑」而非「映射数据」，否则映射一动
 * 测试就脆裂。
 *
 * 做法：先观测 botImId=undefined 时的 atUsers（即 service 当前的默认 fallback
 * 集合），以此为基线推导其他 case 的预期。这样 BOT_TO_RECEIVER 增减、fallback
 * receiver 换人都不需要手动维护本 spec。
 */
describe('ReplyFactGuardNotifierService', () => {
  const mockPrivateChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockRenderer = {
    buildReplyFactContradictionAlertCard: jest.fn(),
  } as unknown as jest.Mocked<OpsCardRenderer>;

  let service: ReplyFactGuardNotifierService;
  let errorSpy: jest.SpyInstance;

  const buildParams = (overrides: Record<string, unknown> = {}) => ({
    chatId: 'chat-1',
    userId: 'user-1',
    traceId: 'trace-1',
    contactName: '候选人A',
    botImId: undefined as string | undefined,
    botUserName: 'mgr-bob',
    replyPreview: '群已满了',
    contradictions: [{ ruleId: 'group_full_without_invite', label: '声称群满但未拉群' }],
    toolNames: [],
    ...overrides,
  });

  const lastBuiltCardArg = () =>
    (mockRenderer.buildReplyFactContradictionAlertCard as jest.Mock).mock.calls.at(-1)?.[0] as {
      atUsers: FeishuReceiver[];
      [key: string]: unknown;
    };

  /** 探测当前实现下 botImId 缺失时的默认 fallback atUsers 集合，供后续断言用。 */
  const probeDefaultAtUsers = async (): Promise<FeishuReceiver[]> => {
    await service.notifyContradiction(buildParams({ botImId: undefined }));
    return lastBuiltCardArg().atUsers;
  };

  const resetMocks = () => {
    jest.clearAllMocks();
    mockPrivateChannel.send.mockResolvedValue(true);
    (mockRenderer.buildReplyFactContradictionAlertCard as jest.Mock).mockReturnValue({
      kind: 'card',
    });
  };

  beforeEach(() => {
    resetMocks();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new ReplyFactGuardNotifierService(mockPrivateChannel as never, mockRenderer);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns true and dispatches the card via private chat channel on success', async () => {
    const result = await service.notifyContradiction(buildParams());

    expect(result).toBe(true);
    expect(mockPrivateChannel.send).toHaveBeenCalledWith({ kind: 'card' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns false and logs error with chatId when private chat channel send fails', async () => {
    mockPrivateChannel.send.mockResolvedValue(false);

    const result = await service.notifyContradiction(buildParams({ chatId: 'chat-fail' }));

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('chatId=chat-fail');
  });

  it('falls back to a non-empty default atUsers when botImId is not provided', async () => {
    const fallback = await probeDefaultAtUsers();

    // 不校验 fallback 具体是谁——只要求至少 @ 一个 receiver 兜底，避免出现
    // 「没人收到告警」的静默失败。
    expect(fallback.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps atUsers identical to the fallback when botImId is unknown to BOT_TO_RECEIVER', async () => {
    const fallback = await probeDefaultAtUsers();

    resetMocks();
    await service.notifyContradiction(buildParams({ botImId: 'not-a-real-bot-im-id' }));

    expect(lastBuiltCardArg().atUsers).toEqual(fallback);
  });

  it('adds the mapped receiver to atUsers when botImId hits BOT_TO_RECEIVER', async () => {
    const fallback = await probeDefaultAtUsers();
    const fallbackOpenIds = new Set(fallback.map((r) => r.openId));

    // 从 BOT_TO_RECEIVER 动态挑一个 receiver 不在 fallback 中的 bot——这样断言
    // 「新增 1 位 receiver」才有意义。BOT_TO_RECEIVER 后续可任意增删，只要还
    // 存在至少一个这样的 bot 本 case 就能覆盖；若所有 bot 都映射到 fallback 内
    // （极端），跳过该断言而不是误报失败。
    const nonFallbackEntry = Object.entries(BOT_TO_RECEIVER).find(
      ([, receiver]) => !fallbackOpenIds.has(receiver.openId),
    );
    if (!nonFallbackEntry) return;
    const [knownBotImId, expectedReceiver] = nonFallbackEntry;

    resetMocks();
    await service.notifyContradiction(buildParams({ botImId: knownBotImId }));

    const atUsers = lastBuiltCardArg().atUsers;
    expect(atUsers).toEqual(expect.arrayContaining([...fallback, expectedReceiver]));
    expect(atUsers).toHaveLength(fallback.length + 1);
  });

  it('de-duplicates atUsers when the mapped receiver is already in the fallback', async () => {
    const fallback = await probeDefaultAtUsers();
    const fallbackOpenIds = new Set(fallback.map((r) => r.openId));

    // 对应场景：某 bot 的归属人本身就是 fallback 中的人。Set 去重应保证
    // atUsers 不出现重复 receiver。
    const overlappingEntry = Object.entries(BOT_TO_RECEIVER).find(([, receiver]) =>
      fallbackOpenIds.has(receiver.openId),
    );
    if (!overlappingEntry) return;
    const [overlappingBotImId] = overlappingEntry;

    resetMocks();
    await service.notifyContradiction(buildParams({ botImId: overlappingBotImId }));

    expect(lastBuiltCardArg().atUsers).toHaveLength(fallback.length);
  });
});
