import { buildSessionFactsHashKey } from '@memory/services/session-key';

describe('buildSessionFactsHashKey', () => {
  // 这是 Redis 唯一事实源（facts / terminal / brand_state）的寻址口径：
  // 前缀或分隔符一改，线上会话状态整体"失联"（读到空态而非报错）。
  it('builds the factsv2 hash key from corp / user / session', () => {
    expect(buildSessionFactsHashKey('corp1', 'user1', 'session1')).toBe(
      'factsv2:corp1:user1:session1',
    );
  });

  it('keeps segments positional and distinct（三段不可互换）', () => {
    expect(buildSessionFactsHashKey('a', 'b', 'c')).not.toBe(buildSessionFactsHashKey('b', 'a', 'c'));
  });
});
