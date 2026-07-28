import {
  assertExtractionIdentityProvenance,
  assertNoExtractionExampleEcho,
  hasIsStudentTopicEvidence,
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

describe('assertExtractionIdentityProvenance', () => {
  const baseOutput = (info: Record<string, unknown>) => ({ interview_info: info });

  const PROMPT = [
    '[已确认事实（此前轮次提取，沿用即可）]',
    '- 姓名: 李梅（置信度: high）',
    '- 联系方式: 15887265838（置信度: high）',
    '[历史对话]',
    '用户: 哈根达斯招人吗',
    '用户: 我电话 158 8726 5838',
    '[当前消息]',
    '周一到周五晚上我也可以去',
  ].join('\n');

  it('badcase 2026-07-24 chat 6a4f520a：新造姓名+手机号在上下文无出处即抛错', () => {
    expect(() =>
      assertExtractionIdentityProvenance(baseOutput({ name: '赵堤', phone: null }), PROMPT),
    ).toThrow(/姓名在提取上下文中无出处/);
    expect(() =>
      assertExtractionIdentityProvenance(baseOutput({ name: null, phone: '18833669895' }), PROMPT),
    ).toThrow(/手机号在提取上下文中无出处/);
  });

  it('[已确认事实] 携带的旧值（沿用）放行', () => {
    expect(() =>
      assertExtractionIdentityProvenance(
        baseOutput({ name: '李梅', phone: '15887265838' }),
        PROMPT,
      ),
    ).not.toThrow();
  });

  it('候选人原话里带分隔符的手机号放行（纯数字流匹配）', () => {
    expect(() =>
      assertExtractionIdentityProvenance(
        baseOutput({ name: null, phone: '158-8726-5838' }),
        PROMPT,
      ),
    ).not.toThrow();
  });

  it('空身份字段 / interview_info 缺失放行', () => {
    expect(() =>
      assertExtractionIdentityProvenance(baseOutput({ name: null, phone: null }), PROMPT),
    ).not.toThrow();
    expect(() => assertExtractionIdentityProvenance(null, PROMPT)).not.toThrow();
    expect(() => assertExtractionIdentityProvenance({}, PROMPT)).not.toThrow();
  });
});

describe('hasIsStudentTopicEvidence（is_student 首写证据门，badcase 6a673402）', () => {
  it('生产复现：候选人只说过"川沙"、助手只发过岗位卡片 → 无证据（该轮臆造 false 应被丢弃）', () => {
    expect(
      hasIsStudentTopicEvidence(
        ['我通过了你的联系人验证请求，现在我们可以开始聊天了', '川沙'],
        [
          '你好呀～我们这边对接的门店全国连锁，就近给你分配比较方便。问下你现在主要在哪个区域呀？',
          '川沙这边查到 4 个岗位：前厅服务员，班次 11:00-14:00，基础 24 元/小时，20-50 岁，需食品健康证',
        ],
      ),
    ).toBe(false);
  });

  it.each([
    '不是学生',
    '我还在读书',
    '已经工作了',
    '身份（学生/社会人士）：社会',
    '请问能接受学生吗',
    '我刚高考完想找暑期工作',
  ])('候选人消息含身份词汇即有证据：%s', (text) => {
    expect(hasIsStudentTopicEvidence([text], [])).toBe(true);
  });

  it('助手身份追问在场即有证据（覆盖"是社会人士对吧？→ 是的"确认式作答）', () => {
    expect(hasIsStudentTopicEvidence(['是的'], ['你是社会人士对吧？'])).toBe(true);
    expect(hasIsStudentTopicEvidence(['社会'], ['目前是学生还是社会人士？'])).toBe(true);
  });

  it('助手仅发过收资表单模板不算证据（模板在场≠候选人谈过身份）', () => {
    expect(
      hasIsStudentTopicEvidence(
        ['好的，我明天下午有空'],
        ['报名需要你发我这些资料：\n姓名：\n身份（学生/社会人士）：\n过往公司+岗位+年限：'],
      ),
    ).toBe(false);
  });

  it('候选人引用块里的身份词剥离后不算证据', () => {
    expect(hasIsStudentTopicEvidence(['[引用 辛瑜琦：这家目前只招社会人士]\n好的'], [])).toBe(
      false,
    );
  });

  it('时间戳后缀不干扰词汇识别', () => {
    expect(hasIsStudentTopicEvidence(['不是学生\n[消息发送时间：2026-07-27 18:49 星期一]'], [])).toBe(
      true,
    );
  });
});
