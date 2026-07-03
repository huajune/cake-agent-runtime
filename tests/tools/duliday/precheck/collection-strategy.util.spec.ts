import {
  buildCollectionStrategy,
  detectCollectionResistance,
  detectRealNameInsistence,
  extractMessageText,
  getRecentUserMessages,
} from '@tools/duliday/precheck/collection-strategy.util';

describe('collection-strategy.util', () => {
  describe('extractMessageText', () => {
    it('returns string content directly', () => {
      expect(extractMessageText('hello')).toBe('hello');
    });

    it('flattens arrays of mixed content parts', () => {
      expect(
        extractMessageText([
          { type: 'text', text: 'hi' },
          { type: 'text', text: 'there' },
        ]),
      ).toBe('hi there');
    });

    it('extracts text/content properties on objects', () => {
      expect(extractMessageText({ text: '你好' })).toBe('你好');
      expect(extractMessageText({ content: '世界' })).toBe('世界');
    });

    it('returns empty string for other shapes', () => {
      expect(extractMessageText(42)).toBe('');
      expect(extractMessageText(null)).toBe('');
      expect(extractMessageText({ irrelevant: 1 })).toBe('');
    });
  });

  describe('getRecentUserMessages', () => {
    it('filters non-user roles and trims to last `limit`', () => {
      const messages = [
        { role: 'assistant', content: 'sys reply' },
        { role: 'user', content: '消息1' },
        { role: 'user', content: '消息2' },
        { role: 'user', content: '消息3' },
        { role: 'user', content: '消息4' },
      ];
      expect(getRecentUserMessages(messages, 3)).toEqual(['消息2', '消息3', '消息4']);
    });

    it('skips falsy/empty messages', () => {
      expect(
        getRecentUserMessages([
          { role: 'user', content: '' },
          { role: 'user', content: '   ' },
          { role: 'user', content: '有效' },
        ]),
      ).toEqual(['有效']);
    });

    it('returns [] when input is empty', () => {
      expect(getRecentUserMessages([])).toEqual([]);
    });
  });

  describe('detectRealNameInsistence (badcase slg3jqi9)', () => {
    it('fires on "这就是我的真名"', () => {
      expect(detectRealNameInsistence([{ role: 'user', content: '这就是我的真名' }])).toBe(true);
    });

    it('fires when minority-ethnic context appears', () => {
      expect(detectRealNameInsistence([{ role: 'user', content: '我是维吾尔族' }])).toBe(true);
    });

    it('fires on "身份证上就是这个"', () => {
      expect(detectRealNameInsistence([{ role: 'user', content: '身份证上就是这个' }])).toBe(true);
    });

    it('does not fire on unrelated content', () => {
      expect(detectRealNameInsistence([{ role: 'user', content: '帮我看下后厨岗位' }])).toBe(false);
    });

    it('ignores assistant messages even if they match patterns', () => {
      expect(detectRealNameInsistence([{ role: 'assistant', content: '这是真名吗？' }])).toBe(
        false,
      );
    });
  });

  describe('detectCollectionResistance', () => {
    it('detects resistance and reports matched signals', () => {
      const result = detectCollectionResistance([
        { role: 'user', content: '问这么多干嘛' },
        { role: 'user', content: '太麻烦了不想填' },
      ]);
      expect(result.detected).toBe(true);
      expect(result.latestUserMessage).toBe('太麻烦了不想填');
      expect(result.matchedSignals.length).toBeGreaterThan(0);
    });

    it('reports detected=false when no signals match', () => {
      const result = detectCollectionResistance([{ role: 'user', content: '我先看看后厨岗位' }]);
      expect(result.detected).toBe(false);
      expect(result.matchedSignals).toEqual([]);
      expect(result.latestUserMessage).toBe('我先看看后厨岗位');
    });

    it('returns latestUserMessage=null when there are no user messages at all', () => {
      const result = detectCollectionResistance([{ role: 'assistant', content: '请补充信息' }]);
      expect(result.detected).toBe(false);
      expect(result.latestUserMessage).toBeNull();
    });
  });

  describe('buildCollectionStrategy', () => {
    it('returns full_template when no resistance signals', () => {
      const result = buildCollectionStrategy({
        missingFields: ['姓名', '联系电话', '年龄'],
        resistanceSignals: [],
      });
      expect(result.candidateResistanceDetected).toBe(false);
      expect(result.recommendedMode).toBe('full_template');
      expect(result.starterFields.length).toBeGreaterThan(0);
    });

    it('switches to progressive when resistance signals exist, and explains why', () => {
      const result = buildCollectionStrategy({
        missingFields: ['姓名', '联系电话', '年龄', '学历'],
        resistanceSignals: ['太麻烦', '不想填'],
      });
      expect(result.candidateResistanceDetected).toBe(true);
      expect(result.recommendedMode).toBe('progressive');
      expect(result.reason).toContain('太麻烦');
      expect(result.reason).toContain('不想填');
    });

    it('uses core missing fields as starterFields when present', () => {
      const result = buildCollectionStrategy({
        missingFields: ['学历', '健康证情况', '姓名', '联系电话'],
        resistanceSignals: [],
      });
      // 姓名/联系电话 都是 API_BOOKING_USER_REQUIRED_FIELDS，应被优先 starter
      expect(result.starterFields).toEqual(expect.arrayContaining(['姓名', '联系电话']));
      // 非核心字段进 remainingFields
      expect(result.remainingFields).toEqual(expect.arrayContaining(['学历', '健康证情况']));
    });

    it('falls back to first 2 missing fields when no core fields are missing', () => {
      const result = buildCollectionStrategy({
        missingFields: ['学历', '健康证情况', '身高'],
        resistanceSignals: [],
      });
      expect(result.starterFields.length).toBeLessThanOrEqual(2);
      expect(result.starterFields.length).toBeGreaterThan(0);
    });

    it('handles empty missingFields gracefully', () => {
      const result = buildCollectionStrategy({
        missingFields: [],
        resistanceSignals: [],
      });
      expect(result.starterFields).toEqual([]);
      expect(result.remainingFields).toEqual([]);
    });
  });
});
