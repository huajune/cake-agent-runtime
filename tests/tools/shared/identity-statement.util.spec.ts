import {
  classifyIdentityAnswerText,
  detectIdentityConfirmQuestion,
  detectStudentRejectionNotice,
  findLatestExplicitIdentity,
  isIdentityAskMessage,
  matchIdentityStatement,
  resolveIdentityFlipAfterRejection,
  stripMessageDecorations,
  summarizeIdentityAskRounds,
} from '@/tools/shared/identity-statement.util';

const TS = '[消息发送时间：2026-07-15 17:33 星期三]';

describe('stripMessageDecorations', () => {
  it('剥离短期记忆时间戳后缀（v10.13.0 整句锚定被其全量击穿的根因）', () => {
    expect(stripMessageDecorations(`社会人士\n${TS}`)).toBe('社会人士');
  });

  it('剥离 debounce 合并消息中的多个内嵌时间戳', () => {
    expect(stripMessageDecorations(`是的\n${TS}\n40分钟\n${TS}`)).toBe('是的\n\n40分钟');
  });

  it('剥离企微引用块', () => {
    expect(stripMessageDecorations('[引用 张三：你是学生吗]\n不是学生')).toBe('不是学生');
  });
});

describe('classifyIdentityAnswerText（宽松：仅用于已知是身份答案的上下文）', () => {
  it.each([
    ['false', '社会人士'],
    ['False', '社会人士'],
    ['否', '社会人士'],
    ['已毕业', '社会人士'],
    ['毕业了', '社会人士'],
    ['true', '学生'],
    ['是', '学生'],
    ['在读学生', '学生'],
    ['大三', '学生'],
  ])('%s → %s', (input, expected) => {
    expect(classifyIdentityAnswerText(input)).toBe(expected);
  });

  it('否定优先：不是学生 → 社会人士', () => {
    expect(classifyIdentityAnswerText('不是学生')).toBe('社会人士');
  });
});

describe('matchIdentityStatement（严格：自由消息中的身份自认）', () => {
  it.each([
    [`社会人士\n${TS}`, '社会人士'],
    ['男 已经工作了', '社会人士'],
    ['是社会人士', '社会人士'],
    ['确定社会人士', '社会人士'],
    ['女\n确定社会人士\n40分钟', '社会人士'],
    ['已经上班了', '社会人士'],
    ['身份（学生还是社会人士）：社会人士', '社会人士'],
    [`身份（学生还是社会人士）:已毕业\n${TS}`, '社会人士'],
    ['身份（学生/社会人士）：学生', '学生'],
    ['身份：在读学生', '学生'],
    ['我是大学生', '学生'],
    ['就是学生', '学生'],
    ['18岁 还在上学', '学生'],
  ])('识别 %s → %s', (input, expected) => {
    expect(matchIdentityStatement(input)).toBe(expected);
  });

  it.each([
    '那就社会人士的早班吧',
    '嘉裕太阳城呢 不是有招社会人士岗吗',
    '社会人士岗位会影响我后续读书吗',
    '那东方宝泰店我可以用社会人士身份入职是吗',
    '已经工作了吗',
    '是的',
    '学生价有优惠吗',
    '招学生吗',
  ])('不误判讨论/反问句：%s', (input) => {
    expect(matchIdentityStatement(input)).toBeNull();
  });
});

describe('detectIdentityConfirmQuestion（单值确认问句）', () => {
  it('识别确认式问句', () => {
    expect(
      detectIdentityConfirmQuestion('系统里还差个“身份”选项没勾，你确认下是选“社会人士”对吧'),
    ).toBe('社会人士');
  });

  it('二选一问句（含"还是"）返回 null', () => {
    expect(detectIdentityConfirmQuestion('你目前是学生还是已经工作了呀？')).toBeNull();
  });

  it('岗位要求陈述 + 间隔疑问不算确认问句', () => {
    expect(detectIdentityConfirmQuestion('这个岗位要求是社会人士，你看可以吗')).toBeNull();
  });
});

describe('findLatestExplicitIdentity', () => {
  it('确认问句 + 纯肯定应答构成自认（消息带时间戳后缀）', () => {
    const identity = findLatestExplicitIdentity([
      { role: 'assistant', content: `你确认下是选“社会人士”对吧\n${TS}` },
      { role: 'user', content: `是的\n${TS}` },
    ]);
    expect(identity).toBe('社会人士');
  });

  it('否定应答只撤销悬挂问句，不反推相反身份', () => {
    const identity = findLatestExplicitIdentity([
      { role: 'assistant', content: '你确认下是选“社会人士”对吧' },
      { role: 'user', content: '不对' },
    ]);
    expect(identity).toBeNull();
  });

  it('最新自认覆盖旧自认（改口方向双向可信）', () => {
    const identity = findLatestExplicitIdentity([
      { role: 'user', content: '我是学生' },
      { role: 'user', content: '我已经毕业了' },
    ]);
    expect(identity).toBe('社会人士');
  });
});

describe('summarizeIdentityAskRounds', () => {
  it('统计追问轮数与候选人是否已作答（带时间戳）', () => {
    const summary = summarizeIdentityAskRounds([
      { role: 'assistant', content: `另外目前是学生还是已经工作了？\n${TS}` },
      { role: 'user', content: '那个啥' },
      { role: 'assistant', content: `还有个身份要确认下哈\n${TS}` },
      { role: 'user', content: '嗯呐' },
    ]);
    expect(summary).toEqual({ askCount: 2, userRepliedAfterLatestAsk: true });
  });

  it('表单模板行不计入追问', () => {
    expect(isIdentityAskMessage('姓名：\n身份（学生/社会人士）：\n电话：')).toBe(false);
  });
});

describe('resolveIdentityFlipAfterRejection（拒后改口核实）', () => {
  const studentForm = { role: 'user', content: '身份（学生还是社会人士）：学生' };
  const rejection = { role: 'assistant', content: '亲，这个岗位暂时不要学生哈' };
  const flip = { role: 'user', content: '填顺手了，已毕业' };

  it('识别学生拒绝话术', () => {
    expect(detectStudentRejectionNotice('亲，这个暂时不要学生')).toBe(true);
    expect(detectStudentRejectionNotice('这个岗位仅限社会人士哈')).toBe(true);
    expect(detectStudentRejectionNotice('这个岗位周末要上班哈')).toBe(false);
  });

  it('学生自认 → 被拒 → 改口：首次改口待核实', () => {
    const result = resolveIdentityFlipAfterRejection([studentForm, rejection, flip]);
    expect(result.flipPendingVerification).toBe(true);
  });

  it('核实问句后候选人再次确认 → 改口生效', () => {
    const result = resolveIdentityFlipAfterRejection([
      studentForm,
      rejection,
      flip,
      {
        role: 'assistant',
        content: '身份跟你确认下哈，你已经毕业了对吧？还在读也没关系，如实说就行',
      },
      { role: 'user', content: '对，已经毕业了' },
    ]);
    expect(result.flipPendingVerification).toBe(false);
  });

  it('未经核实问句的重复自证不算确认', () => {
    const result = resolveIdentityFlipAfterRejection([
      studentForm,
      rejection,
      flip,
      { role: 'user', content: '真的已经毕业了' },
    ]);
    expect(result.flipPendingVerification).toBe(true);
  });

  it('没有被拒环节的正常改口不触发核实', () => {
    const result = resolveIdentityFlipAfterRejection([
      { role: 'user', content: '我是学生' },
      { role: 'user', content: '说错了，我已经毕业了' },
    ]);
    expect(result.flipPendingVerification).toBe(false);
  });

  it('改口后重新自认学生：链路重置，直接采信学生', () => {
    const result = resolveIdentityFlipAfterRejection([
      studentForm,
      rejection,
      flip,
      { role: 'user', content: '算了，我还是学生，不瞒你了' },
    ]);
    expect(result.flipPendingVerification).toBe(false);
  });
});
