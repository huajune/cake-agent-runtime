import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import type { CenterScopeService } from '@biz/center-dashboard/center-scope.service';
import { ConfigService } from '@nestjs/config';
import { FeishuPrivateChatChannel } from '@notification/channels/feishu-private-chat.channel';

describe('FeishuPrivateChatChannel', () => {
  const scopes = { getScope: jest.fn() };
  let channel: FeishuPrivateChatChannel;
  let webhookService: jest.Mocked<FeishuWebhookService>;

  beforeEach(() => {
    scopes.getScope.mockReset().mockResolvedValue({ botIds: ['center-bot'] });
    webhookService = {
      sendMessage: jest.fn(),
      sendMessageOrThrow: jest.fn(),
    } as unknown as jest.Mocked<FeishuWebhookService>;

    channel = new FeishuPrivateChatChannel(
      webhookService,
      new ConfigService({
        HENAN_PRIVATE_CHAT_MONITOR_WEBHOOK_URL: 'https://example.test/webhook',
      }),
      scopes as unknown as CenterScopeService,
    );
  });

  it('should send cards to the private chat monitor webhook channel', async () => {
    const card = { msg_type: 'interactive' };
    webhookService.sendMessage.mockResolvedValue(true);

    const result = await channel.send(card);

    expect(result).toBe(true);
    expect(webhookService.sendMessage).toHaveBeenCalledWith('PRIVATE_CHAT_MONITOR', card);
  });
  it('does not enter the legacy retry loop after an ambiguous webhook timeout', async () => {
    webhookService.sendMessageOrThrow.mockRejectedValue(new Error('timeout'));
    await expect(channel.sendOnce({ msg_type: 'interactive' })).rejects.toThrow('timeout');
    expect(webhookService.sendMessageOrThrow).toHaveBeenCalledTimes(1);
    expect(webhookService.sendMessage).not.toHaveBeenCalled();
  });

  it('routes only configured accounts to the external group in both dispatch modes', async () => {
    const card = { msg_type: 'interactive' };
    webhookService.sendMessage.mockResolvedValue(true);
    await channel.send(card, 'center-bot');
    await channel.sendOnce(card, 'center-bot');
    expect(webhookService.sendMessage).toHaveBeenCalledWith('HENAN_PRIVATE_CHAT_MONITOR', card);
    expect(webhookService.sendMessageOrThrow).toHaveBeenCalledWith(
      'HENAN_PRIVATE_CHAT_MONITOR',
      card,
    );
  });

  it.each([undefined, '', 'other-bot', 'prod-sync:center-bot'])(
    'keeps %s out of the external group',
    async (botId) => {
      await channel.send({}, botId);
      expect(webhookService.sendMessage).toHaveBeenCalledWith('PRIVATE_CHAT_MONITOR', {});
    },
  );

  it('does not reroute an external-group failure to the internal group', async () => {
    webhookService.sendMessage.mockResolvedValue(false);
    expect(await channel.send({}, 'center-bot')).toBe(false);
    webhookService.sendMessageOrThrow.mockRejectedValue(new Error('missing webhook'));
    await expect(channel.sendOnce({}, 'center-bot')).rejects.toThrow('missing webhook');
    expect(webhookService.sendMessage).toHaveBeenCalledTimes(1);
    expect(webhookService.sendMessageOrThrow).toHaveBeenCalledTimes(1);
  });

  it('retains the original destination when no account routing is configured', async () => {
    channel = new FeishuPrivateChatChannel(
      webhookService,
      new ConfigService(),
      scopes as unknown as CenterScopeService,
    );
    await channel.send({}, 'center-bot');
    expect(webhookService.sendMessage).toHaveBeenCalledWith('PRIVATE_CHAT_MONITOR', {});
  });

  it('follows changed group membership and does not send when membership cannot be read', async () => {
    scopes.getScope.mockResolvedValueOnce({ botIds: [] });
    await channel.send({}, 'center-bot');
    expect(webhookService.sendMessage).toHaveBeenCalledWith('PRIVATE_CHAT_MONITOR', {});
    webhookService.sendMessage.mockClear();
    scopes.getScope.mockRejectedValue(new Error('directory unavailable'));
    await expect(channel.send({}, 'center-bot')).rejects.toThrow('directory unavailable');
    expect(webhookService.sendMessage).not.toHaveBeenCalled();
  });
});
