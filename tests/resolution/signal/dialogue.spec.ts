import { isAffirmativeAnswer, normalizeShortAnswer } from '@resolution/signal/dialogue';

const single = (text: string) => isAffirmativeAnswer(normalizeShortAnswer(text));

describe('isAffirmativeAnswer（仅针对性字段问句的短答作证）', () => {
  it.each(['对', '对的', '没问题', '好的', '确认', '嗯嗯'])(
    '教科书短答仍可为目标字段作证：%s',
    (text) => {
      expect(single(text)).toBe(true);
    },
  );

  it.each([
    '可以',
    '对的，没问题',
    '没问题，麻烦老师了',
    '嗯嗯可以',
    '对的，但是电话错了',
    '不对',
    '确认一下时间',
    '',
  ])('组合句、开放表达或否定不进入字段短答词表：%s', (text) => {
    expect(single(text)).toBe(false);
  });

  it('时间后缀、引用块和标点仍先归一化，再做字段级整句匹配', () => {
    expect(single('好的。')).toBe(true);
  });
});
