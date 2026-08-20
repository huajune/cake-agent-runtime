import {
  createForm,
  emptySlotIds,
  filledSlotIds,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection/form.types';
import {
  applyErrorList,
  applyRecapResult,
  detectSuspectedMultiPerson,
  escalate,
  isTerminal,
  markAsked,
  markRecapSent,
  markSubmitted,
  MAX_ASKS_PER_SLOT,
  proposeValue,
  PROPOSAL_IGNORE_REASONS,
  PROPOSAL_REJECTION_REASONS,
  recordConfigDebt,
  type ValueProposal,
} from '@resolution/collection/form-writes';
import {
  AGE_FIELD,
  AGE_FIELD_18_40,
  HEIGHT_FIELD_GENDERED,
  assistantMessage,
  GENDER_MALE_ONLY_FIELD,
  HEALTH_CERT_FIELD,
  NAME_FIELD,
  PHONE_FIELD,
  TEST_CANDIDATE_NAME,
  TEST_CANDIDATE_PHONE,
  userMessage,
} from './form.fixtures';

const CONTRACT: ContractFieldDef[] = [
  NAME_FIELD,
  PHONE_FIELD,
  AGE_FIELD,
  GENDER_MALE_ONLY_FIELD,
  HEALTH_CERT_FIELD,
];

function form(contract: ContractFieldDef[] = CONTRACT): BookingCollectionForm {
  return createForm({ jobId: 528781, contract });
}

function proposal(overrides: Partial<ValueProposal> & Pick<ValueProposal, 'value' | 'sourceText'>) {
  return {
    producer: 'candidate_quote' as const,
    candidateTexts: [overrides.sourceText],
    ...overrides,
  };
}

/** 姓名闸门要求结构化出处或"我叫X"；手机号闸门要求原话里出现该号。 */
const NAME_MESSAGES = [userMessage(`姓名：${TEST_CANDIDATE_NAME}`)];
const PHONE_MESSAGES = [userMessage(`我的手机号是${TEST_CANDIDATE_PHONE}`)];

function fillName(base = form()): BookingCollectionForm {
  const result = proposeValue(
    base,
    NAME_FIELD,
    proposal({
      value: TEST_CANDIDATE_NAME,
      sourceText: `姓名：${TEST_CANDIDATE_NAME}`,
      messages: NAME_MESSAGES,
    }),
  );
  expect(result.outcome).toBe('accepted');
  return result.form;
}

function fillPhone(base: BookingCollectionForm): BookingCollectionForm {
  const result = proposeValue(
    base,
    PHONE_FIELD,
    proposal({
      value: TEST_CANDIDATE_PHONE,
      sourceText: `我的手机号是${TEST_CANDIDATE_PHONE}`,
      messages: PHONE_MESSAGES,
    }),
  );
  expect(result.outcome).toBe('accepted');
  return result.form;
}

describe('form.types · verdictOf', () => {
  it('空表单是 collecting；判定优先级为 submitted > escalated > disqualified > collecting > ready', () => {
    expect(verdictOf(form())).toBe('collecting');

    const filled = createForm({ jobId: 1, contract: [NAME_FIELD] });
    expect(verdictOf(fillName(filled))).toBe('ready');

    expect(verdictOf(escalate(fillName(filled), 'x'))).toBe('escalated');
    expect(verdictOf(markSubmitted(escalate(fillName(filled), 'x'), 9527))).toBe('submitted');
  });

  it('createForm 按契约字段集开槽，全部 empty 且 askCount=0', () => {
    const created = form();
    expect(Object.keys(created.slots)).toHaveLength(CONTRACT.length);
    expect(Object.values(created.slots).every((slot) => slot.state === 'empty')).toBe(true);
    expect(Object.values(created.slots).every((slot) => slot.askCount === 0)).toBe(true);
    expect(created.candidateRef).toBe('session');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 蓝图 §10 六事故防线（全绿才算完）
// ══════════════════════════════════════════════════════════════════════════

describe('防线 1 · 反复问根治：filled 槽位零重问', () => {
  it('filled 槽位不出现在待问清单里', () => {
    const filled = fillName();
    expect(emptySlotIds(filled, CONTRACT)).not.toContain(NAME_FIELD.labelId);
    expect(filledSlotIds(filled, CONTRACT)).toEqual([NAME_FIELD.labelId]);
  });

  it('markAsked 对 filled 槽位不计数、不返回可问', () => {
    const filled = fillName();
    const { form: next, askable } = markAsked(filled, [NAME_FIELD.labelId, PHONE_FIELD.labelId]);
    expect(askable).toEqual([PHONE_FIELD.labelId]);
    expect(next.slots[NAME_FIELD.labelId].askCount).toBe(0);
  });

  it('对 filled 槽位再提案一律 ignored，值不被覆盖（类型级不变量）', () => {
    const filled = fillName();
    const result = proposeValue(
      filled,
      NAME_FIELD,
      proposal({ value: '张三', sourceText: '姓名：张三', messages: [userMessage('姓名：张三')] }),
    );
    expect(result.outcome).toBe('ignored');
    expect(result.reason).toBe(PROPOSAL_IGNORE_REASONS.slotAlreadyFilled);
    expect(result.form.slots[NAME_FIELD.labelId].value?.value).toBe(TEST_CANDIDATE_NAME);
  });

  it('重放同一条消息不会让 filled 槽位回到 empty（跨轮重放不变量）', () => {
    let current = fillName();
    for (let turn = 0; turn < 5; turn += 1) {
      current = proposeValue(
        current,
        NAME_FIELD,
        proposal({
          value: TEST_CANDIDATE_NAME,
          sourceText: `姓名：${TEST_CANDIDATE_NAME}`,
          messages: NAME_MESSAGES,
        }),
      ).form;
      current = markAsked(current, [NAME_FIELD.labelId]).form;
    }
    expect(current.slots[NAME_FIELD.labelId].state).toBe('filled');
    expect(current.slots[NAME_FIELD.labelId].askCount).toBe(0);
    expect(current.escalatedReason).toBeUndefined();
  });
});

describe('棘轮：对系统单向、对本人双向（§3 0819 裁定）', () => {
  it('候选人显式改口 → 公证通过即替换，outcome=restated', () => {
    const filled = fillName();
    const text = '姓名：李四';
    const result = proposeValue(filled, NAME_FIELD, {
      value: '李四',
      sourceText: text,
      producer: 'candidate_quote',
      candidateTexts: [text],
      messages: [userMessage(text)],
      restatement: true,
    });
    expect(result.outcome).toBe('restated');
    expect(result.form.slots[NAME_FIELD.labelId].value?.value).toBe('李四');
    expect(result.detail).toContain('显式改口');
  });

  it('改口 askCount 不清零——防"改一次刷新一次配额"绕过熔断', () => {
    let current = markAsked(form(), [NAME_FIELD.labelId]).form;
    current = fillName(current);
    const text = '姓名：李四';
    const restated = proposeValue(current, NAME_FIELD, {
      value: '李四',
      sourceText: text,
      producer: 'candidate_quote',
      candidateTexts: [text],
      messages: [userMessage(text)],
      restatement: true,
    });
    expect(restated.form.slots[NAME_FIELD.labelId].askCount).toBe(1);
  });

  it('改口同样过公证——出处站不住的改口照拒', () => {
    const filled = fillName();
    const result = proposeValue(filled, NAME_FIELD, {
      value: '李四',
      sourceText: '姓名：李四',
      producer: 'model',
      candidateTexts: ['随便聊点别的'],
      messages: [userMessage('随便聊点别的')],
      restatement: true,
    });
    expect(result.outcome).toBe('rejected');
    expect(result.form.slots[NAME_FIELD.labelId].value?.value).toBe(TEST_CANDIDATE_NAME);
  });

  it('不带 restatement 的重推一律挡死——系统/模型永远推不动 filled 槽位', () => {
    const filled = fillName();
    const text = '姓名：李四';
    const result = proposeValue(filled, NAME_FIELD, {
      value: '李四',
      sourceText: text,
      producer: 'model',
      candidateTexts: [text],
      messages: [userMessage(text)],
    });
    expect(result.outcome).toBe('ignored');
    expect(result.reason).toBe(PROPOSAL_IGNORE_REASONS.slotAlreadyFilled);
  });

  it('改口命中筛选条件照样当轮判不合格', () => {
    const contract = [GENDER_MALE_ONLY_FIELD];
    let current = createForm({ jobId: 1, contract });
    current = proposeValue(current, GENDER_MALE_ONLY_FIELD, {
      value: '男',
      optionCodes: ['1'],
      sourceText: '我是男的',
      producer: 'candidate_quote',
      candidateTexts: ['我是男的'],
    }).form;
    const restated = proposeValue(current, GENDER_MALE_ONLY_FIELD, {
      value: '女',
      optionCodes: ['2'],
      sourceText: '写错了我是女的',
      producer: 'candidate_quote',
      candidateTexts: ['写错了我是女的'],
      restatement: true,
    });
    expect(restated.outcome).toBe('disqualified');
  });
});

describe('分性别值域筛（实测 528995 身高/体重）', () => {
  const contract = [GENDER_MALE_ONLY_FIELD, HEIGHT_FIELD_GENDERED];

  function withGender(value: '男' | '女'): BookingCollectionForm {
    const optionCodes = value === '男' ? ['1'] : ['2'];
    const source = `我是${value}的`;
    return proposeValue(createForm({ jobId: 1, contract }), GENDER_MALE_ONLY_FIELD, {
      value,
      optionCodes,
      sourceText: source,
      producer: 'candidate_quote',
      candidateTexts: [source],
    }).form;
  }

  function proposeHeight(base: BookingCollectionForm, cm: string) {
    const source = `我身高${cm}`;
    return proposeValue(base, HEIGHT_FIELD_GENDERED, {
      value: cm,
      sourceText: source,
      producer: 'candidate_quote',
      candidateTexts: [source],
    });
  }

  it('按在案性别取对应档：男 160-190，155 判不合格', () => {
    const result = proposeHeight(withGender('男'), '155');
    expect(result.outcome).toBe('disqualified');
    expect(result.detail).toContain('值域越界');
  });

  it('同一个值换性别档就合格——分档不能取错', () => {
    // 女档 150-180：155 合格。（性别槽位本岗 rejected 女，故单独造一份不筛性别的契约）
    const neutralGender = {
      ...GENDER_MALE_ONLY_FIELD,
      acceptedOptions: [
        { optionCode: '1', optionLabel: '男' },
        { optionCode: '2', optionLabel: '女' },
      ],
      rejectedOptions: [],
    };
    const neutral = [neutralGender, HEIGHT_FIELD_GENDERED];
    const source = '我是女的';
    const base = proposeValue(createForm({ jobId: 1, contract: neutral }), neutralGender, {
      value: '女',
      optionCodes: ['2'],
      sourceText: source,
      producer: 'candidate_quote',
      candidateTexts: [source],
    }).form;
    expect(proposeHeight(base, '155').outcome).toBe('accepted');
  });

  it('性别未知 → 分性别值域整体不参与判决（漏斗优先，下游 errorList 截）', () => {
    const base = createForm({ jobId: 1, contract });
    expect(proposeHeight(base, '155').outcome).toBe('accepted');
  });

  it('带单位的值也能取数（"170cm"）', () => {
    const result = proposeHeight(withGender('男'), '170cm');
    expect(result.outcome).toBe('accepted');
  });
});

describe('防线 2 · 复述落账：「不对，电话错了」精确重开一格', () => {
  it('corrections 只重开被点名且在案的那一格，其余格不动', () => {
    const filled = markRecapSent(fillPhone(fillName()), [NAME_FIELD.labelId, PHONE_FIELD.labelId]);
    const corrected = applyRecapResult(filled, { corrections: [PHONE_FIELD.labelId] });

    expect(corrected.slots[PHONE_FIELD.labelId].state).toBe('empty');
    expect(corrected.slots[PHONE_FIELD.labelId].value).toBeUndefined();
    expect(corrected.slots[NAME_FIELD.labelId].state).toBe('filled');
    expect(corrected.slots[NAME_FIELD.labelId].value?.value).toBe(TEST_CANDIDATE_NAME);
  });

  it('affirmed 不动表单，verdict 停在 ready 放行提交', () => {
    const filled = markRecapSent(fillName(createForm({ jobId: 1, contract: [NAME_FIELD] })), [
      NAME_FIELD.labelId,
    ]);
    expect(applyRecapResult(filled, { affirmed: true })).toBe(filled);
    expect(verdictOf(filled)).toBe('ready');
  });

  it('重开不清零 askCount：改口不刷新熔断配额', () => {
    let current = markAsked(form(), [NAME_FIELD.labelId]).form;
    current = fillName(current);
    current = markRecapSent(current, [NAME_FIELD.labelId]);
    const corrected = applyRecapResult(current, { corrections: [NAME_FIELD.labelId] });
    expect(corrected.slots[NAME_FIELD.labelId].askCount).toBe(1);
  });

  it('复述里没出现过的格子指不动（lastRecap 是唯一定位依据）', () => {
    const filled = markRecapSent(fillPhone(fillName()), [NAME_FIELD.labelId]);
    const corrected = applyRecapResult(filled, { corrections: [PHONE_FIELD.labelId] });
    expect(corrected.slots[PHONE_FIELD.labelId].state).toBe('filled');
  });
});

describe('防线 3 · 先筛后收：命中 rejectedOptions 当轮即 disqualified', () => {
  it('性别答"女"命中 rejected[女] → 该槽 disqualified，整表 verdict=disqualified', () => {
    const result = proposeValue(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '女', optionCodes: ['2'], sourceText: '我是女的' }),
    );
    expect(result.outcome).toBe('disqualified');
    expect(result.form.slots[GENDER_MALE_ONLY_FIELD.labelId].state).toBe('disqualified');
    expect(verdictOf(result.form)).toBe('disqualified');
    expect(isTerminal(result.form)).toBe(true);
  });

  it('账本落真实原因（判定入账永远如实，委婉只在渲染层）', () => {
    const result = proposeValue(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '女', optionCodes: ['2'], sourceText: '我是女的' }),
    );
    expect(result.detail).toContain('rejectedOption');
    expect(result.detail).toContain('女');
    expect(result.form.slots[GENDER_MALE_ONLY_FIELD.labelId].value?.value).toBe('女');
  });

  it('不合格后不再收该槽后续字段', () => {
    const disqualified = proposeValue(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '女', optionCodes: ['2'], sourceText: '我是女的' }),
    ).form;
    const retry = proposeValue(
      disqualified,
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '男', optionCodes: ['1'], sourceText: '我是男的' }),
    );
    expect(retry.outcome).toBe('ignored');
    expect(retry.reason).toBe(PROPOSAL_IGNORE_REASONS.slotDisqualified);
  });

  it('accepted 选项照常入账', () => {
    const result = proposeValue(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '男', optionCodes: ['1'], sourceText: '我是男的' }),
    );
    expect(result.outcome).toBe('accepted');
    expect(result.form.slots[GENDER_MALE_ONLY_FIELD.labelId].value?.optionCodes).toEqual(['1']);
  });

  it('年龄越出契约 min/max 硬区间 → 值域筛不合格（判决单源：判据读契约）', () => {
    const contract = [AGE_FIELD_18_40];
    const result = proposeValue(
      createForm({ jobId: 1, contract }),
      AGE_FIELD_18_40,
      proposal({ value: '55', sourceText: '我今年55岁了' }),
    );
    expect(result.outcome).toBe('disqualified');
    expect(result.detail).toContain('值域越界');
  });

  it('契约没带 min/max = 该岗没有这道筛（不读岗位数据补筛）', () => {
    const result = proposeValue(
      createForm({ jobId: 1, contract: [AGE_FIELD] }),
      AGE_FIELD,
      proposal({ value: '55', sourceText: '我今年55岁了' }),
    );
    expect(result.outcome).toBe('accepted');
  });

  it('年龄弹性档（boundary）不判不合格，可继续推进', () => {
    const result = proposeValue(
      createForm({ jobId: 1, contract: [AGE_FIELD_18_40] }),
      AGE_FIELD_18_40,
      proposal({ value: '42', sourceText: '我42岁' }),
    );
    expect(result.outcome).toBe('accepted');
  });
});

describe('防线 4 · 臆造防线：sourceText 回查失败的提案零入账', () => {
  it('sourceText 不在候选人原文里 → rejected，表单一格不动', () => {
    const base = form();
    const result = proposeValue(base, PHONE_FIELD, {
      value: '15921708092',
      sourceText: '我的手机号是15921708092',
      producer: 'model',
      candidateTexts: ['你好，还招人吗'],
      messages: [userMessage('你好，还招人吗')],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.sourceTextNotFound);
    expect(result.form).toBe(base);
  });

  it('空 sourceText 直接拒收', () => {
    const result = proposeValue(form(), AGE_FIELD, proposal({ value: '26', sourceText: '  ' }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.sourceTextNotFound);
  });

  it('身份槽位的值本体没落在原话里 → rejected（严格身份追加判据）', () => {
    const text = '我叫兮兮，之前在奶茶店做过';
    const result = proposeValue(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: text,
      producer: 'model',
      candidateTexts: [text],
      messages: [userMessage(text)],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.valueNotInSourceText);
  });

  it('占位号形态被形态门拦下（gu2kra6p 族，进真实工单前最后一道）', () => {
    const text = '我的手机号是13800138000';
    const result = proposeValue(
      form(),
      PHONE_FIELD,
      proposal({ value: '13800138000', sourceText: text, messages: [userMessage(text)] }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.invalidValueShape);
  });

  it('契约选项集外的 optionCode 拒收', () => {
    const result = proposeValue(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '男', optionCodes: ['99'], sourceText: '我是男的' }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.unknownOptionCode);
  });

  it('身份槽位缺归属取证语料 → fail-closed 拒收，不当作放行', () => {
    const text = `我的手机号是${TEST_CANDIDATE_PHONE}`;
    const result = proposeValue(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: text,
      producer: 'candidate_quote',
      candidateTexts: [text],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.missingAttributionCorpus);
  });

  it('确认式身份提案的问句只由模型自报、真实历史不存在 → fail-closed 拒收', () => {
    const result = proposeValue(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: '确认',
      producer: 'model',
      candidateTexts: ['确认'],
      messages: [userMessage('确认')],
      agentQuestionQuote: `手机号是${TEST_CANDIDATE_PHONE}，对吗？`,
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.identityGateRejected);
  });

  it('确认式身份提案绑定真实相邻问答对 → 允许入账', () => {
    const question = `手机号是${TEST_CANDIDATE_PHONE}，对吗？`;
    const result = proposeValue(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: '确认',
      producer: 'model',
      candidateTexts: ['确认'],
      messages: [assistantMessage(question), userMessage('确认')],
      agentQuestionQuote: question,
    });
    expect(result.outcome).toBe('accepted');
  });

  it('姓名仅以「我是X」打招呼语昵称出现 → 归属门拒收', () => {
    const text = '你好，我是小晴';
    const result = proposeValue(
      form(),
      NAME_FIELD,
      proposal({ value: '小晴', sourceText: text, messages: [userMessage(text)] }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.identityGateRejected);
  });

  it('置信按证据形态授予：逐字落在原话里=high，归一化产物=medium', () => {
    const high = proposeValue(
      form(),
      AGE_FIELD,
      proposal({ value: '26', sourceText: '我今年26岁' }),
    );
    expect(high.form.slots[AGE_FIELD.labelId].value?.confidence).toBe('high');

    const medium = proposeValue(
      form(),
      HEALTH_CERT_FIELD,
      proposal({
        value: '有本地有效健康证',
        optionCodes: ['1'],
        sourceText: '有的，本地办的健康证',
      }),
    );
    expect(medium.form.slots[HEALTH_CERT_FIELD.labelId].value?.confidence).toBe('medium');
  });

  it('producer 原样入账（署名如实，公证不改写来源）', () => {
    const text = '有的，本地办的健康证';
    const result = proposeValue(form(), HEALTH_CERT_FIELD, {
      value: '有本地有效健康证',
      optionCodes: ['1'],
      sourceText: text,
      producer: 'model',
      candidateTexts: [text],
    });
    expect(result.form.slots[HEALTH_CERT_FIELD.labelId].value?.producer).toBe('model');
  });
});

describe('防线 5 · 死锁终结：errorList 回写后不存在永卡 ready', () => {
  const singleField = [NAME_FIELD];

  it('按 labelId 定位重开该槽 → verdict 回到 collecting', () => {
    const ready = fillName(createForm({ jobId: 1, contract: singleField }));
    expect(verdictOf(ready)).toBe('ready');

    const reopened = applyErrorList(
      ready,
      [{ labelId: NAME_FIELD.labelId, field: '姓名', msg: '姓名不合法' }],
      singleField,
    );
    expect(verdictOf(reopened)).toBe('collecting');
    expect(reopened.slots[NAME_FIELD.labelId].state).toBe('empty');
  });

  it('只带展示名时按 labelTitle 匹配（D2）', () => {
    const ready = fillName(createForm({ jobId: 1, contract: singleField }));
    const reopened = applyErrorList(ready, [{ field: '姓名', msg: '姓名不合法' }], singleField);
    expect(verdictOf(reopened)).toBe('collecting');
  });

  it('定位不到 → escalatedReason，不静默（D2 唯一保留特判）', () => {
    const ready = fillName(createForm({ jobId: 1, contract: singleField }));
    const escalated = applyErrorList(ready, [{ field: '证件照', msg: '缺少证件照' }], singleField);
    expect(verdictOf(escalated)).toBe('escalated');
    expect(escalated.escalatedReason).toContain('error_list_unmapped');
    expect(escalated.escalatedReason).toContain('证件照');
  });

  it('无论哪条路径，回写后都不会停在 ready', () => {
    const ready = fillName(createForm({ jobId: 1, contract: singleField }));
    for (const errors of [
      [{ labelId: NAME_FIELD.labelId, field: '姓名', msg: 'x' }],
      [{ field: '姓名', msg: 'x' }],
      [{ field: '没这个字段', msg: 'x' }],
      [{ labelId: 99999, field: '没这个字段', msg: 'x' }],
    ]) {
      expect(verdictOf(applyErrorList(ready, errors, singleField))).not.toBe('ready');
    }
  });

  it('空 errorList 不改表（不是错误就别当错误处理）', () => {
    const ready = fillName(createForm({ jobId: 1, contract: singleField }));
    expect(applyErrorList(ready, [], singleField)).toBe(ready);
  });
});

describe('防线 6 · 熔断：同槽 2 问不中 → escalated，第 3 问不存在', () => {
  it('问满上限后不再返回可问，整表转人工', () => {
    let current = form();
    for (let i = 0; i < MAX_ASKS_PER_SLOT; i += 1) {
      const step = markAsked(current, [NAME_FIELD.labelId]);
      expect(step.askable).toEqual([NAME_FIELD.labelId]);
      current = step.form;
    }
    expect(current.slots[NAME_FIELD.labelId].askCount).toBe(MAX_ASKS_PER_SLOT);
    expect(verdictOf(current)).toBe('collecting');

    const third = markAsked(current, [NAME_FIELD.labelId]);
    expect(third.askable).toEqual([]);
    expect(third.exhausted).toEqual([NAME_FIELD.labelId]);
    expect(verdictOf(third.form)).toBe('escalated');
    expect(third.form.escalatedReason).toContain('ask_limit_exhausted');
    expect(third.form.slots[NAME_FIELD.labelId].askCount).toBe(MAX_ASKS_PER_SLOT);
  });

  it('答上了就不再计数——熔断只惩罚"问不中"', () => {
    let current = markAsked(form(), [NAME_FIELD.labelId]).form;
    current = fillName(current);
    for (let i = 0; i < 5; i += 1) current = markAsked(current, [NAME_FIELD.labelId]).form;
    expect(current.escalatedReason).toBeUndefined();
  });

  it('escalate 首个原因胜出，后续不覆盖', () => {
    const escalated = escalate(escalate(form(), '第一个原因'), '第二个原因');
    expect(escalated.escalatedReason).toBe('第一个原因');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 其余写路径
// ══════════════════════════════════════════════════════════════════════════

describe('markSubmitted / configDebts / 疑似多人', () => {
  it('markSubmitted 落 workOrderId，verdict 变 submitted 并压过其它状态', () => {
    const submitted = markSubmitted(escalate(form(), '随便什么原因'), 9527);
    expect(submitted.workOrderId).toBe(9527);
    expect(verdictOf(submitted)).toBe('submitted');
  });

  it('recordConfigDebt 同一 labelId 只记一行', () => {
    const once = recordConfigDebt(form(), 605, '标题里带筛选指令，映射不出选项');
    const twice = recordConfigDebt(once, 605, '又一次');
    expect(twice.configDebts).toHaveLength(1);
    expect(twice).toBe(once);
    expect(twice.configDebts?.[0].note).toContain('筛选指令');
  });

  it('姓名与手机号成对换新 → 判疑似多人', () => {
    const filled = fillPhone(fillName());
    expect(
      detectSuspectedMultiPerson(filled, CONTRACT, [
        { labelId: NAME_FIELD.labelId, value: '李四' },
        { labelId: PHONE_FIELD.labelId, value: '13700001111' },
      ]),
    ).toBe(true);
  });

  it('只换其中一个不算（纠错别字/换号码是正常的）', () => {
    const filled = fillPhone(fillName());
    expect(
      detectSuspectedMultiPerson(filled, CONTRACT, [
        { labelId: NAME_FIELD.labelId, value: '李四' },
      ]),
    ).toBe(false);
    expect(
      detectSuspectedMultiPerson(filled, CONTRACT, [
        { labelId: NAME_FIELD.labelId, value: TEST_CANDIDATE_NAME },
        { labelId: PHONE_FIELD.labelId, value: '13700001111' },
      ]),
    ).toBe(false);
  });

  it('assistant 消息不参与候选人语料判定（回声不构成出处）', () => {
    const text = `姓名：${TEST_CANDIDATE_NAME}`;
    const result = proposeValue(form(), NAME_FIELD, {
      value: TEST_CANDIDATE_NAME,
      sourceText: text,
      producer: 'model',
      candidateTexts: [],
      messages: [assistantMessage(text)],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.sourceTextNotFound);
  });
});
