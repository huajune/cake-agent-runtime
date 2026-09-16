import {
  extractAutoGreetingName,
  hasStructuredNameSubmission,
  isCompoundEthnicName,
  isFromAutoGreeting,
  isLikelyRealChineseName,
  isStrictRealChineseName,
  normalizeNameSeparators,
  parseName,
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

describe('间隔号分段的少数民族全名', () => {
  it.each(['布海力其木·图拉江', '艾力·买买提', '热依来木·艾则孜', '阿不都热依木·阿不来提·买买提'])(
    '%s 宽松档与严格档同收',
    (name) => {
      expect(isCompoundEthnicName(name)).toBe(true);
      expect(isLikelyRealChineseName(name)).toBe(true);
      expect(isStrictRealChineseName(name)).toBe(true);
    },
  );

  it.each(['艾力•买买提', '艾力・买买提', '艾力‧买买提', '艾力･买买提'])(
    '分隔符变体 %s 折叠成 U+00B7 后同收',
    (name) => {
      expect(normalizeNameSeparators(name)).toBe('艾力·买买提');
      expect(isStrictRealChineseName(name)).toBe(true);
    },
  );

  it.each([
    ['艾力·138', '含数字'],
    ['艾力·买买提先生', '称谓后缀'],
    ['测试·买买提', '占位前缀'],
    ['艾·买买提', '单字段'],
    ['布海力其木图拉·买买提', '单段超 6 字'],
    ['艾力·买买提·图拉江·阿不都', '超过 3 段'],
    ['·买买提', '空首段'],
    ['艾力·', '空尾段'],
    ['艾力·mai', '非 CJK 段'],
  ])('反例 %s（%s）两档都拒', (name) => {
    expect(isCompoundEthnicName(name)).toBe(false);
    expect(isLikelyRealChineseName(name)).toBe(false);
    expect(isStrictRealChineseName(name)).toBe(false);
  });

  it('纯 CJK 5 字仍只过宽松档：5 字真名走转人工补录的裁定不变', () => {
    expect(isLikelyRealChineseName('布买日也木')).toBe(true);
    expect(isStrictRealChineseName('布买日也木')).toBe(false);
    expect(isStrictRealChineseName('布海力其木图拉江')).toBe(false);
  });

  it.each([
    ['姓名：布海力其木·图拉江', '布海力其木·图拉江'],
    ['我叫艾力•买买提，明天能面试', '艾力•买买提'],
    ['名字:热依来木·艾则孜\n[消息发送时间：2026-09-15 14:00 周二]', '热依来木·艾则孜'],
  ])('parseName(%s) 取到间隔号全名', (input, expected) => {
    expect(parseName(input)?.value).toBe(expected);
  });

  it('parseName 对带数字/称谓的间隔号写法仍判不出', () => {
    expect(parseName('姓名：艾力·138')).toBeNull();
    expect(parseName('我叫艾力·买买提先生')).toBeNull();
  });
});
