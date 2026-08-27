import {
  extractAutoGreetingName,
  hasStructuredNameSubmission,
  isFromAutoGreeting,
  isLikelyRealChineseName,
  isStrictRealChineseName,
} from '@resolution/candidate/name';

describe('name primitives', () => {
  it.each([
    ['我是兮兮', '兮兮'],
    ['你好，我是兮兮', '兮兮'],
    ['我是兮兮\n[消息发送时间：2026-08-20 10:00 周四]', '兮兮'],
    ['我叫兮兮', null],
    ['我是兮兮，想找工作', null],
  ])('extractAutoGreetingName(%s)', (input, expected) => {
    expect(extractAutoGreetingName(input)).toBe(expected);
  });

  it('识别昵称仅来自自动打招呼语', () => {
    expect(isFromAutoGreeting('兮兮', ['我是兮兮'])).toBe(true);
    expect(isFromAutoGreeting('兮兮', ['我叫兮兮'])).toBe(false);
  });

  it.each([
    ['姓名：兮兮', true],
    ['名字:兮兮', true],
    ['我叫兮兮', false],
  ])('hasStructuredNameSubmission(%s)', (input, expected) => {
    expect(hasStructuredNameSubmission('兮兮', [input])).toBe(expected);
  });

  it('真名形态原语保持独立，不承担跨轮确认', () => {
    expect(isLikelyRealChineseName('兮兮')).toBe(true);
    expect(isStrictRealChineseName('兮兮')).toBe(true);
    expect(isStrictRealChineseName('测试昵称昵称')).toBe(false);
    expect(isStrictRealChineseName('1234')).toBe(false);
  });
});
