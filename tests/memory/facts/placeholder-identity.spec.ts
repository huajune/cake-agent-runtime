import {
  assertNoExtractionExampleEcho,
  isPlaceholderPhone,
  isPromptExampleName,
} from '@memory/facts/placeholder-identity';

describe('isPlaceholderPhone', () => {
  it.each(['13800138000', '13800000000', '13900139000', '12345678901'])(
    '已知占位号 %s 命中',
    (phone) => {
      expect(isPlaceholderPhone(phone)).toBe(true);
    },
  );

  it('后 10 位全同数字命中（11111111111 / 13333333333）', () => {
    expect(isPlaceholderPhone('11111111111')).toBe(true);
    expect(isPlaceholderPhone('13333333333')).toBe(true);
  });

  it('容忍空格/连字符等格式差异', () => {
    expect(isPlaceholderPhone('138-0013-8000')).toBe(true);
    expect(isPlaceholderPhone('138 0013 8000')).toBe(true);
  });

  it('真实形态手机号放行', () => {
    expect(isPlaceholderPhone('18271421690')).toBe(false);
    expect(isPlaceholderPhone('13912345678')).toBe(false);
  });

  it('空值 / 非 11 位不判占位', () => {
    expect(isPlaceholderPhone(null)).toBe(false);
    expect(isPlaceholderPhone(undefined)).toBe(false);
    expect(isPlaceholderPhone('')).toBe(false);
    expect(isPlaceholderPhone('1380013800')).toBe(false);
  });
});

describe('isPromptExampleName', () => {
  it('示例姓名命中（含首尾空白）', () => {
    expect(isPromptExampleName('张三')).toBe(true);
    expect(isPromptExampleName(' 张三 ')).toBe(true);
    expect(isPromptExampleName('李四')).toBe(true);
  });

  it('普通姓名放行', () => {
    expect(isPromptExampleName('赵堤')).toBe(false);
    expect(isPromptExampleName('张三丰')).toBe(false);
    expect(isPromptExampleName(null)).toBe(false);
  });
});

describe('assertNoExtractionExampleEcho', () => {
  const baseOutput = (interviewInfo: Record<string, unknown>) => ({
    interview_info: interviewInfo,
    preferences: {},
  });

  it('badcase 2026-07-22 整套示例回声：占位手机号直接抛错', () => {
    expect(() =>
      assertNoExtractionExampleEcho(
        baseOutput({ name: '张三', phone: '13800138000', experience: '肯德基服务员4个多月' }),
      ),
    ).toThrow(/占位手机号/);
  });

  it('无 phone 但姓名+经历同时命中示例原文时抛错', () => {
    expect(() =>
      assertNoExtractionExampleEcho(
        baseOutput({ name: '张三', phone: null, experience: '肯德基服务员4个多月' }),
      ),
    ).toThrow(/示例姓名与示例经历/);
  });

  it('真实候选人恰好叫张三（经历非示例原文）不误伤', () => {
    expect(() =>
      assertNoExtractionExampleEcho(
        baseOutput({ name: '张三', phone: '18271421690', experience: '奶茶店店员半年' }),
      ),
    ).not.toThrow();
  });

  it('正常提取输出放行', () => {
    expect(() =>
      assertNoExtractionExampleEcho(
        baseOutput({ name: '赵堤', phone: '18912345678', experience: null }),
      ),
    ).not.toThrow();
  });

  it('interview_info 缺失 / 非对象输出直接放行', () => {
    expect(() => assertNoExtractionExampleEcho(null)).not.toThrow();
    expect(() => assertNoExtractionExampleEcho({})).not.toThrow();
    expect(() => assertNoExtractionExampleEcho('oops')).not.toThrow();
  });
});
