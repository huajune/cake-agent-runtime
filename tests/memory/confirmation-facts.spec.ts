import {
  isPureAffirmation,
  resolveConfirmedCityFact,
} from '@memory/facts/confirmation-facts';

describe('confirmation-facts（确认问答裁决，候选人资料证据化 P1）', () => {
  describe('isPureAffirmation', () => {
    it.each(['好的', '好', '嗯嗯', '对', '是的', '可以', '行', 'ok', '好的好的', '嗯呢~'])(
      '肯定词「%s」判定为纯肯定应答',
      (text) => {
        expect(isPureAffirmation(text)).toBe(true);
      },
    );

    it.each(['在吗', '你好', '收到', '谢谢', '好的约明天', '对了我还想问', '不对', '不行'])(
      '非肯定/带附加信息「%s」不算纯肯定应答',
      (text) => {
        expect(isPureAffirmation(text)).toBe(false);
      },
    );
  });

  describe('resolveConfirmedCityFact', () => {
    it('识别「是在沈阳市对吧？」→「好的」（badcase 6a671722 沈阳案 T6）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'user', content: '日结的最好' },
        {
          role: 'assistant',
          content: '方便确认下你是在沈阳市对吧？确认后我拉你进兼职群，有合适的日结岗我第一时间@你',
        },
        { role: 'user', content: '好的' },
      ]);
      expect(fact).toMatchObject({ city: '沈阳', reply: '好的' });
      expect(fact?.question).toContain('沈阳市');
    });

    it('识别「你现在是在上海对吧？」→「嗯嗯」（badcase 6a618a6e 上海浦东案，白名单裸名城市）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '了解哈，方便确认下你现在是在上海对吧？确认后我拉你进当地的兼职群' },
        { role: 'user', content: '嗯嗯' },
      ]);
      expect(fact).toMatchObject({ city: '上海' });
    });

    it('剥离消息时间后缀后仍能识别（时间戳后缀击穿锚定识别器的历史坑）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '你是在武汉这边找工作对吧？[消息发送时间：2026-07-28 10:00]' },
        { role: 'user', content: '对 [消息发送时间：2026-07-28 10:01]' },
      ]);
      expect(fact).toMatchObject({ city: '武汉', reply: '对' });
    });

    it('尾部 user 块首条是肯定词、后续换话题不影响确认成立', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '你是在上海对吧？' },
        { role: 'user', content: '对的' },
        { role: 'user', content: '有日结的吗' },
      ]);
      expect(fact).toMatchObject({ city: '上海' });
    });

    it('应答不是纯肯定词 → 不产出（"好的约明天"携带其他语义）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '你是在上海对吧？' },
        { role: 'user', content: '好的约明天' },
      ]);
      expect(fact).toBeNull();
    });

    it('上一条 assistant 不是城市确认句 → 不产出（普通肯定应答不能凭空确认城市）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '上海这边这家必胜客薪资 2000-2300 元/月' },
        { role: 'user', content: '好的' },
      ]);
      expect(fact).toBeNull();
    });

    it('确认片段跨逗号提及两个城市时按最后分句关联（"之前在上海，现在是在武汉这边对吧"→武汉）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '你之前在上海，现在是在武汉这边对吧？' },
        { role: 'user', content: '对' },
      ]);
      expect(fact).toMatchObject({ city: '武汉' });
    });

    it('裸名"佛山"随区划库补录后可产出（原"宁可漏"边界，2026-07-28 数据补录反转为正例）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '你现在主要是在佛山这边找工作对吧？' },
        { role: 'user', content: '好' },
      ]);
      expect(fact).toMatchObject({ city: '佛山', reply: '好' });
    });

    it('词典外城市仍不产出（宁可漏原则保持，如"香格里拉"）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '你是在香格里拉这边找工作对吧？' },
        { role: 'user', content: '好' },
      ]);
      expect(fact).toBeNull();
    });

    it('引用块内的确认句不算（引用是转述不是本轮发问）', () => {
      const fact = resolveConfirmedCityFact([
        { role: 'assistant', content: '[引用 经理：你是在上海对吧？]收到，我帮你跟进' },
        { role: 'user', content: '好的' },
      ]);
      expect(fact).toBeNull();
    });

    it('无前置 assistant 消息 → 不产出', () => {
      expect(resolveConfirmedCityFact([{ role: 'user', content: '好的' }])).toBeNull();
    });
  });
});
