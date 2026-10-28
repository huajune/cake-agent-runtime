import { loadUserPages } from '../../web/src/api/services/scoped-user-pages';

describe('scoped users pagination', () => {
  it('loads users beyond 1000 and retains distinct bot pairs for the same chat', async () => {
    const rows = Array.from({ length: 1101 }, (_, i) => ({ chatId: `chat-${i}`, botId: 'own' }));
    rows.push({ chatId: 'chat-1100', botId: 'own-2' });
    let page = 0;
    const fetchPage = jest.fn(async () => {
      const users = rows.slice(page * 500, ++page * 500);
      return { users, nextCursor: page < 3 ? users[users.length - 1] : null };
    });
    expect(await loadUserPages(fetchPage)).toEqual(rows);
    expect(fetchPage).toHaveBeenNthCalledWith(2, rows[499]);
    expect(fetchPage).toHaveBeenNthCalledWith(3, rows[999]);
  });

  it('preserves the headquarters array response without extra requests', async () => {
    const fetchPage = jest.fn().mockResolvedValue([{ chatId: 'hq' }]);
    expect(await loadUserPages(fetchPage)).toEqual([{ chatId: 'hq' }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated cursors and page failures rather than returning a partial count', async () => {
    const repeated = jest.fn().mockResolvedValue({
      users: [{ chatId: 'first' }],
      nextCursor: { chatId: 'first', botId: 'own' },
    });
    await expect(loadUserPages(repeated)).rejects.toThrow('游标异常');
    const failed = jest
      .fn()
      .mockResolvedValueOnce({ users: ['first'], nextCursor: { chatId: 'first', botId: 'own' } })
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(loadUserPages(failed)).rejects.toThrow('timeout');
  });
});
