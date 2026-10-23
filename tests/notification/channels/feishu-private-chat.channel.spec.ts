import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuPrivateChatChannel } from '@notification/channels/feishu-private-chat.channel';

describe('FeishuPrivateChatChannel', () => {
  let channel: FeishuPrivateChatChannel;
  let webhookService: jest.Mocked<FeishuWebhookService>;

  beforeEach(() => {
    webhookService = {
      sendMessage: jest.fn(),
      sendMessageOrThrow: jest.fn(),
    } as unknown as jest.Mocked<FeishuWebhookService>;

    channel = new FeishuPrivateChatChannel(webhookService);
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
});
