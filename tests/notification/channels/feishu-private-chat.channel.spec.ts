import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuPrivateChatChannel } from '@notification/channels/feishu-private-chat.channel';

describe('FeishuPrivateChatChannel', () => {
  let channel: FeishuPrivateChatChannel;
  let webhookService: jest.Mocked<FeishuWebhookService>;

  beforeEach(() => {
    webhookService = {
      sendMessage: jest.fn(),
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
});
