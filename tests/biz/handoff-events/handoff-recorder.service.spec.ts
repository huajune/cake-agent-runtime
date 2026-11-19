import { HandoffRecorderService } from '@biz/handoff-events/handoff-recorder.service';

describe('HandoffRecorderService', () => {
  const groups = { resolve: jest.fn().mockReturnValue({ managerName: '经理', groupName: '小组' }) };
  const repository = { insertHandoffEvent: jest.fn() };
  const service = new HandoffRecorderService(repository as never, groups as never);
  const input = {
    corpId: 'corp',
    chatId: 'chat',
    botImId: 'bot',
    idempotencyKey: 'key',
    reasonCode: 'modify_appointment',
    jobId: 12,
    occurredAt: new Date('2026-06-05T03:00:00Z'),
  };

  it.each(['inserted', 'duplicate', 'failed'])(
    'preserves the transaction outcome %s',
    async (outcome) => {
      repository.insertHandoffEvent.mockResolvedValueOnce(outcome);
      expect(await service.record(input)).toBe(outcome);
      expect(groups.resolve).toHaveBeenCalledWith('bot');
      expect(repository.insertHandoffEvent).toHaveBeenCalledWith(input, {
        managerName: '经理',
        groupName: '小组',
      });
    },
  );
  it('reports an unavailable transaction without issuing a second event', async () => {
    repository.insertHandoffEvent.mockRejectedValueOnce(new Error('store unavailable'));
    await expect(service.record(input)).resolves.toBe('failed');
  });
});
