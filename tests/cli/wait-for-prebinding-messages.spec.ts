import { waitForPrebindingMessages } from '@/cli/wait-for-prebinding-messages';

it('waits for the old worker to acknowledge pre-binding messages while fresh messages continue arriving', async () => {
  const cutoff = Date.now();
  const scan = jest
    .fn()
    .mockResolvedValueOnce(['1', []])
    .mockResolvedValue(['0', ['pending:chat']]);
  const lrange = jest
    .fn()
    .mockResolvedValueOnce([JSON.stringify({ timestamp: cutoff - 10 })])
    .mockResolvedValue([{ timestamp: cutoff + 1 }]);
  await waitForPrebindingMessages(cutoff, { scan, lrange });
  expect(scan).toHaveBeenCalledWith(
    '1',
    expect.objectContaining({ match: 'wecom:message:pending:*' }),
  );
  expect(lrange).toHaveBeenCalledTimes(2);
});
it('blocks the switch if old pending cannot be read', async () => {
  const scan = jest.fn().mockRejectedValue(new Error('unavailable'));
  await expect(waitForPrebindingMessages(Date.now(), { scan, lrange: jest.fn() })).rejects.toThrow(
    '无法核对旧服务',
  );
});
it('leaves an overdue pending input with the old worker and refuses to switch', async () => {
  const cutoff = Date.now();
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValueOnce(cutoff)
    .mockReturnValue(cutoff + 120_001);
  try {
    const scan = jest.fn().mockResolvedValue(['0', ['pending:chat']]);
    const lrange = jest.fn().mockResolvedValue([{ timestamp: cutoff }]);
    await expect(waitForPrebindingMessages(cutoff, { scan, lrange })).rejects.toThrow(
      '旧服务仍有登记前的待回复消息',
    );
  } finally {
    now.mockRestore();
  }
});
