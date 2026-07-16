import {
  classifyIdentityAnswerText,
  detectIdentityCorrectionNotice,
  detectIdentityConfirmQuestion,
  detectStudentRejectionNotice,
  findLatestExplicitIdentity,
  findLatestExplicitIdentityEvidence,
  isIdentityChoiceQuestion,
  isIdentityAskMessage,
  matchIdentityStatement,
  matchIdentityEvidence,
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
    ['社会', '社会人士'],
    ['工作', '社会人士'],
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

  it.each(['学生/社会人士', '学生 / 社会人士', '社会人士或学生'])(
    '未填写的选项模板不能成为身份答案：%s',
    (input) => {
      expect(classifyIdentityAnswerText(input)).toBeNull();
    },
  );

  it('选项模板后另有回填值时只解释回填值', () => {
    expect(classifyIdentityAnswerText('学生/社会人士 社会人士')).toBe('社会人士');
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
    ['是否是学信网在籍学生：否', '社会人士'],
    ['是否学生：是', '学生'],
    ['目前是学生还是社会人士？（这家只招社会人士哈）社会', '社会人士'],
    ['我是大学生', '学生'],
    ['算是学生吧', '学生'],
    ['学生在实习期还没毕业的', '学生'],
    ['大专已毕业', '社会人士'],
    ['我已经本科毕业了', '社会人士'],
    ['我专科毕业了可以吗', '社会人士'],
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
    '身份：学生 / 社会人士',
    '学历：高中毕业',
    '高中毕业了，在等大学通知书',
  ])('不误判讨论/反问句：%s', (input) => {
    expect(matchIdentityStatement(input)).toBeNull();
  });

  it('教育经历与当前在读冲突时，以当前在读为学生身份', () => {
    expect(matchIdentityStatement('学历：高中毕业，目前大学本科')).toBe('学生');
  });
});

describe('IdentityEvidence（结构化、可追溯）', () => {
  it('直接自述保留清洗后的候选人原话', () => {
    expect(matchIdentityEvidence(`我已经工作了\n${TS}`)).toEqual({
      identity: '社会人士',
      source: 'direct',
      evidence: '我已经工作了',
    });
  });

  it('二选一表单简写答案标记为 form_answer', () => {
    expect(matchIdentityEvidence('目前是学生还是社会人士？（这家只招社会人士哈）社会')).toEqual({
      identity: '社会人士',
      source: 'form_answer',
      evidence: '目前是学生还是社会人士？（这家只招社会人士哈）社会',
    });
  });

  it('识别省略冒号的生产表单字段，但不把候选人的二选一提问当答案', () => {
    expect(matchIdentityEvidence('18岁，学历高中，身份学生')).toEqual({
      identity: '学生',
      source: 'form_answer',
      evidence: '18岁，学历高中，身份学生',
    });
    expect(matchIdentityEvidence('身份学生还是社会人士')).toBeNull();
    expect(matchIdentityEvidence('是学生还是社会人士')).toBeNull();
  });

  it('会话确认答案保留来源与消息位置', () => {
    expect(
      findLatestExplicitIdentityEvidence([
        { role: 'assistant', content: '你确认下是选“社会人士”对吧' },
        { role: 'user', content: `是的\n${TS}` },
      ]),
    ).toEqual({
      identity: '社会人士',
      source: 'confirmation',
      evidence: '是的',
      messageIndex: 1,
    });
  });

  it('旧值 API 与证据 API 保持一致', () => {
    const messages = [{ role: 'user', content: '我是学生' }];
    expect(findLatestExplicitIdentity(messages)).toBe(
      findLatestExplicitIdentityEvidence(messages)?.identity,
    );
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

describe('isIdentityChoiceQuestion（二选一身份问句）', () => {
  it.each(['目前是学生还是社会人士？', '你是学生还是已经工作了呀？'])('识别 %s', (input) => {
    expect(isIdentityChoiceQuestion(input)).toBe(true);
  });

  it('岗位要求陈述不是二选一身份问句', () => {
    expect(isIdentityChoiceQuestion('这个岗位只招社会人士，可以吗')).toBe(false);
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

  it.each([
    ['社会', '社会人士'],
    ['社会人士呢', '社会人士'],
    ['工作', '社会人士'],
    ['学生', '学生'],
  ])('二选一问题后的短答案 %s → %s', (answer, expected) => {
    expect(
      findLatestExplicitIdentityEvidence([
        { role: 'assistant', content: '目前是学生还是社会人士？' },
        { role: 'user', content: answer },
      ]),
    ).toEqual({
      identity: expected,
      source: 'choice_answer',
      evidence: answer,
      messageIndex: 1,
    });
  });

  it.each(['好的', '是的', '我是暑假工', '在实习期'])(
    '二选一问题后的含糊回答仍保持 unknown：%s',
    (answer) => {
      expect(
        findLatestExplicitIdentityEvidence([
          { role: 'assistant', content: '目前是学生还是社会人士？' },
          { role: 'user', content: answer },
        ]),
      ).toBeNull();
    },
  );
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
  const flip = { role: 'user', content: '我已毕业，是社会人士' };

  it('识别学生拒绝话术', () => {
    expect(detectStudentRejectionNotice('亲，这个暂时不要学生')).toBe(true);
    expect(detectStudentRejectionNotice('这个岗位仅限社会人士哈')).toBe(true);
    expect(detectStudentRejectionNotice('这个岗位周末要上班哈')).toBe(false);
  });

  it('识别身份误填纠错话术，但不把策略性改写当纠错', () => {
    expect(detectIdentityCorrectionNotice('填顺手了')).toBe(true);
    expect(detectIdentityCorrectionNotice('刚才选错了，我已毕业')).toBe(true);
    expect(detectIdentityCorrectionNotice('那我改成社会人士')).toBe(false);
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

  it('同一条消息明确误填并说明已毕业：直接按纠错生效', () => {
    const result = resolveIdentityFlipAfterRejection([
      studentForm,
      rejection,
      { role: 'user', content: '填顺手了，已毕业' },
    ]);
    expect(result.flipPendingVerification).toBe(false);
  });

  it('纠错提示与已毕业分开发送且中间有图片：仍直接按纠错生效', () => {
    const result = resolveIdentityFlipAfterRejection([
      studentForm,
      rejection,
      { role: 'user', content: '填顺手了' },
      { role: 'user', content: '[图片]' },
      { role: 'user', content: '已毕业' },
    ]);
    expect(result.flipPendingVerification).toBe(false);
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
