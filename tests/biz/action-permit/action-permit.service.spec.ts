import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';

describe('ActionPermitService', () => {
  const input = {
    chatId: 'chat-b',
    action: 'reply' as const,
    botImId: 'bot-b',
    groupId: 'group',
    candidateIds: ['candidate'],
  };
  const hosting = { getChatPause: jest.fn() };
  const config = { getAiReplyEnabled: jest.fn(), getAgentReplyConfig: jest.fn() };
  const groups = { isGroupBlacklisted: jest.fn() };
  const blacklist = { matchBlacklisted: jest.fn() };
  const bots = { getConfiguredBotList: jest.fn() };
  let service: ActionPermitService;
  const createService = () =>
    new ActionPermitService(
      hosting as never,
      config as never,
      groups as never,
      blacklist as never,
      bots as never,
    );
  beforeEach(() => {
    jest.resetAllMocks();
    service = createService();
    hosting.getChatPause.mockResolvedValue({ paused: false });
    config.getAiReplyEnabled.mockResolvedValue(true);
    config.getAgentReplyConfig.mockResolvedValue({ reengagementEnabled: true });
    groups.isGroupBlacklisted.mockResolvedValue(false);
    blacklist.matchBlacklisted.mockResolvedValue(null);
    bots.getConfiguredBotList.mockResolvedValue([{ id: 'bot-b' }]);
  });
  it('isolates handoff by chat while sharing the person blacklist', async () => {
    hosting.getChatPause.mockImplementation(async (chatId: string) => ({
      paused: chatId === 'chat-a',
    }));
    expect(await service.evaluate(input)).toEqual({ allowed: true });
    expect(hosting.getChatPause).toHaveBeenCalledWith('chat-b');
    expect(hosting.getChatPause).not.toHaveBeenCalledWith('candidate');
    blacklist.matchBlacklisted.mockResolvedValue({ target_id: 'candidate' });
    expect(await service.evaluate(input)).toMatchObject({
      allowed: false,
      reason: 'candidate_blacklisted',
    });
  });
  it('returns pause expiry and preserves permanent pause', async () => {
    hosting.getChatPause.mockResolvedValue({ paused: true, expiresAt: 123 });
    expect(await service.evaluate(input)).toEqual({
      allowed: false,
      reason: 'hosting_paused',
      pauseExpiresAt: 123,
    });
    hosting.getChatPause.mockResolvedValue({ paused: true, expiresAt: null });
    expect(await service.evaluate(input)).toMatchObject({ pauseExpiresAt: null });
  });
  it('keeps proactive reminders enabled for a blocked group', async () => {
    groups.isGroupBlacklisted.mockResolvedValue(true);
    expect(await service.evaluate(input)).toMatchObject({ reason: 'group_blacklisted' });
    expect(await service.evaluate({ ...input, action: 'tool' })).toMatchObject({
      reason: 'group_blacklisted',
    });
    expect(await service.evaluate({ ...input, action: 'proactive' })).toEqual({ allowed: true });
  });
  it('checks each action global switch without coupling proactive to reply switch', async () => {
    config.getAiReplyEnabled.mockResolvedValue(false);
    expect(await service.evaluate(input)).toMatchObject({ reason: 'global_disabled' });
    expect(await service.evaluate({ ...input, action: 'proactive' })).toEqual({ allowed: true });
    config.getAgentReplyConfig.mockResolvedValue({ reengagementEnabled: false });
    expect(await service.evaluate({ ...input, action: 'proactive' })).toMatchObject({
      reason: 'global_disabled',
    });
  });
  it('fails closed for removed accounts and unavailable permission sources', async () => {
    bots.getConfiguredBotList.mockResolvedValue([]);
    expect(await service.evaluate(input)).toMatchObject({ reason: 'receiving_bot_not_hosted' });
    service = createService();
    bots.getConfiguredBotList.mockRejectedValue(new Error('unavailable'));
    expect(await service.evaluate(input)).toMatchObject({ reason: 'permit_unavailable' });
  });
  it.each(['disabled', 'unavailable'])(
    'prioritizes blacklist when the switch is %s',
    async (state) => {
      blacklist.matchBlacklisted.mockResolvedValue({ target_id: 'candidate' });
      if (state === 'disabled') config.getAiReplyEnabled.mockResolvedValue(false);
      else config.getAiReplyEnabled.mockRejectedValue(new Error('offline'));
      expect(await service.evaluate(input)).toMatchObject({ reason: 'candidate_blacklisted' });
      expect(config.getAiReplyEnabled).not.toHaveBeenCalled();
    },
  );
  it('coalesces roster reads but rechecks other gates and refreshes after TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10000);
    try {
      await Promise.all([service.evaluate(input), service.evaluate(input)]);
      await service.evaluate(input);
      expect(bots.getConfiguredBotList).toHaveBeenCalledTimes(1);
      expect(blacklist.matchBlacklisted).toHaveBeenCalledTimes(3);
      now.mockReturnValue(15001);
      bots.getConfiguredBotList.mockRejectedValue(new Error('offline'));
      expect(await service.evaluate(input)).toMatchObject({ reason: 'permit_unavailable' });
      bots.getConfiguredBotList.mockResolvedValue([]);
      expect(await service.evaluate(input)).toMatchObject({ reason: 'receiving_bot_not_hosted' });
    } finally {
      now.mockRestore();
    }
  });
});
