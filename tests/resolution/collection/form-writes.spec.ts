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
  markRecapSent,
  markSubmitted,
  MAX_ASKS_PER_SLOT,
  migrateAskTracking,
  applyFieldValueProposal as applyFieldValueProposalRaw,
  PROPOSAL_IGNORE_REASONS,
  PROPOSAL_REJECTION_REASONS,
  MAX_REJECTED_ATTEMPTS_PER_SLOT,
  recordRejectedAttempts,
  recordUnansweredAsks,
  recordConfigDebt,
  yieldRecoverableEscalationToScreening,
  type FieldValueProposal,
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

type FieldValueProposalFixture = FieldValueProposal & {
  candidateTexts?: readonly string[];
  messages?: readonly unknown[];
};

function applyFieldValueProposal(
  targetForm: BookingCollectionForm,
  field: ContractFieldDef,
  fixture: FieldValueProposalFixture,
) {
  const { candidateTexts = [fixture.sourceText], messages = [], ...valueProposal } = fixture;
  return applyFieldValueProposalRaw(targetForm, field, valueProposal, {
    candidateTexts,
    messages,
  });
}

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

function proposal(
  overrides: Partial<FieldValueProposalFixture> &
    Pick<FieldValueProposalFixture, 'value' | 'sourceText'>,
): FieldValueProposalFixture {
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
  const result = applyFieldValueProposal(
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
  const result = applyFieldValueProposal(
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

  it('实际问句回执对 filled 槽位不计数', () => {
    const filled = fillName();
    const { form: next, recorded } = recordUnansweredAsks(
      filled,
      [NAME_FIELD.labelId, PHONE_FIELD.labelId],
      'turn-1',
    );
    expect(recorded).toEqual([PHONE_FIELD.labelId]);
    expect(next.slots[NAME_FIELD.labelId].askCount).toBe(0);
  });

  it('对 filled 槽位再提案一律 ignored，值不被覆盖（类型级不变量）', () => {
    const filled = fillName();
    const result = applyFieldValueProposal(
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
      current = applyFieldValueProposal(
        current,
        NAME_FIELD,
        proposal({
          value: TEST_CANDIDATE_NAME,
          sourceText: `姓名：${TEST_CANDIDATE_NAME}`,
          messages: NAME_MESSAGES,
        }),
      ).form;
      current = recordUnansweredAsks(current, [NAME_FIELD.labelId], 'turn-' + turn).form;
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
    const result = applyFieldValueProposal(filled, NAME_FIELD, {
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
    let current = recordUnansweredAsks(form(), [NAME_FIELD.labelId], 'turn-1').form;
    current = fillName(current);
    const text = '姓名：李四';
    const restated = applyFieldValueProposal(current, NAME_FIELD, {
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
    const result = applyFieldValueProposal(filled, NAME_FIELD, {
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
    const result = applyFieldValueProposal(filled, NAME_FIELD, {
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
    current = applyFieldValueProposal(current, GENDER_MALE_ONLY_FIELD, {
      value: '男',
      optionCodes: ['1'],
      sourceText: '我是男的',
      producer: 'candidate_quote',
      candidateTexts: ['我是男的'],
    }).form;
    const restated = applyFieldValueProposal(current, GENDER_MALE_ONLY_FIELD, {
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
    return applyFieldValueProposal(createForm({ jobId: 1, contract }), GENDER_MALE_ONLY_FIELD, {
      value,
      optionCodes,
      sourceText: source,
      producer: 'candidate_quote',
      candidateTexts: [source],
    }).form;
  }

  function proposeHeight(base: BookingCollectionForm, cm: string) {
    const source = `我身高${cm}`;
    return applyFieldValueProposal(base, HEIGHT_FIELD_GENDERED, {
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
    const base = applyFieldValueProposal(createForm({ jobId: 1, contract: neutral }), neutralGender, {
      value: '女',
      optionCodes: ['2'],
      sourceText: source,
      producer: 'candidate_quote',
      candidateTexts: [source],
    }).form;
    expect(proposeHeight(base, '155').outcome).toBe('accepted');
  });

  it('只读 systemField=gender 的槽位，其他值里的“男/女/1/2”不得污染分档', () => {
    const experienceField: ContractFieldDef = {
      labelId: 1,
      labelTitle: '相关经验',
      fieldType: 'TEXT',
      required: true,
      acceptedOptions: [],
      rejectedOptions: [],
    };
    const neutralGender: ContractFieldDef = {
      ...GENDER_MALE_ONLY_FIELD,
      acceptedOptions: [
        { optionCode: '1', optionLabel: '男' },
        { optionCode: '2', optionLabel: '女' },
      ],
      rejectedOptions: [],
    };
    const localContract = [experienceField, neutralGender, HEIGHT_FIELD_GENDERED];
    let current = createForm({ jobId: 1, contract: localContract });
    current = applyFieldValueProposal(current, experienceField, {
      value: '男装导购经验',
      sourceText: '我有男装导购经验',
      producer: 'candidate_quote',
      candidateTexts: ['我有男装导购经验'],
    }).form;
    current = applyFieldValueProposal(current, neutralGender, {
      value: '女',
      optionCodes: ['2'],
      sourceText: '我是女的',
      producer: 'candidate_quote',
      candidateTexts: ['我是女的'],
    }).form;

    expect(proposeHeight(current, '155').outcome).toBe('accepted');
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
    expect(corrected.slots[PHONE_FIELD.labelId].systemField).toBe('phone');
    expect(corrected.slots[NAME_FIELD.labelId].state).toBe('filled');
    expect(corrected.slots[NAME_FIELD.labelId].value?.value).toBe(TEST_CANDIDATE_NAME);
  });

  it('affirmed 持久化到当前复述，verdict 停在 ready 放行提交', () => {
    const filled = markRecapSent(fillName(createForm({ jobId: 1, contract: [NAME_FIELD] })), [
      NAME_FIELD.labelId,
    ]);
    const affirmed = applyRecapResult(filled, { affirmed: true });
    expect(affirmed.lastRecap).toEqual({
      labelIds: [NAME_FIELD.labelId],
      affirmed: true,
    });
    expect(verdictOf(affirmed)).toBe('ready');
  });

  it('复述确认后任一槽位改口都作废旧快照', () => {
    const recapped = markRecapSent(fillName(createForm({ jobId: 1, contract: [NAME_FIELD] })), [
      NAME_FIELD.labelId,
    ]);
    const affirmed = applyRecapResult(recapped, { affirmed: true });
    const text = '姓名：李四';
    const restated = applyFieldValueProposal(affirmed, NAME_FIELD, {
      value: '李四',
      sourceText: text,
      producer: 'candidate_quote',
      candidateTexts: [text],
      messages: [userMessage(text)],
      restatement: true,
    });
    expect(restated.outcome).toBe('restated');
    expect(restated.form.lastRecap).toBeUndefined();
  });

  it('重开不清零 askCount：改口不刷新熔断配额', () => {
    let current = recordUnansweredAsks(form(), [NAME_FIELD.labelId], 'turn-1').form;
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
    const result = applyFieldValueProposal(
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
    const result = applyFieldValueProposal(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '女', optionCodes: ['2'], sourceText: '我是女的' }),
    );
    expect(result.detail).toContain('rejectedOption');
    expect(result.detail).toContain('女');
    expect(result.form.slots[GENDER_MALE_ONLY_FIELD.labelId].value?.value).toBe('女');
  });

  it('不合格后不再收该槽后续字段', () => {
    const disqualified = applyFieldValueProposal(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '女', optionCodes: ['2'], sourceText: '我是女的' }),
    ).form;
    const retry = applyFieldValueProposal(
      disqualified,
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '男', optionCodes: ['1'], sourceText: '我是男的' }),
    );
    expect(retry.outcome).toBe('ignored');
    expect(retry.reason).toBe(PROPOSAL_IGNORE_REASONS.slotDisqualified);
  });

  it('accepted 选项照常入账', () => {
    const result = applyFieldValueProposal(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '男', optionCodes: ['1'], sourceText: '我是男的' }),
    );
    expect(result.outcome).toBe('accepted');
    expect(result.form.slots[GENDER_MALE_ONLY_FIELD.labelId].value?.optionCodes).toEqual(['1']);
  });

  it('年龄越出契约 min/max 硬区间 → 值域筛不合格（判决单源：判据读契约）', () => {
    const contract = [AGE_FIELD_18_40];
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract }),
      AGE_FIELD_18_40,
      proposal({ value: '55', sourceText: '我今年55岁了' }),
    );
    expect(result.outcome).toBe('disqualified');
    expect(result.detail).toContain('值域越界');
  });

  it('契约没带 min/max = 该岗没有这道筛（不读岗位数据补筛）', () => {
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract: [AGE_FIELD] }),
      AGE_FIELD,
      proposal({ value: '55', sourceText: '我今年55岁了' }),
    );
    expect(result.outcome).toBe('accepted');
  });

  it('年龄弹性档（boundary）不判不合格，可继续推进', () => {
    const result = applyFieldValueProposal(
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
    const result = applyFieldValueProposal(base, PHONE_FIELD, {
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
    const result = applyFieldValueProposal(form(), AGE_FIELD, proposal({ value: '26', sourceText: '  ' }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.sourceTextNotFound);
  });

  it('身份槽位的值本体没落在原话里 → rejected（严格身份追加判据）', () => {
    const text = '我叫兮兮，之前在奶茶店做过';
    const result = applyFieldValueProposal(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: text,
      producer: 'model',
      candidateTexts: [text],
      messages: [userMessage(text)],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.valueNotInSourceText);
  });

  // 生产 chat 6a8d583b：候选人报「93年」，模型正确换算成 33 却被当成臆造拒收，
  // 候选人被连问两遍年龄。闸门的用途是反臆造——代码能从真话里复算出同一个值时，
  // 臆造已被排除，判据应与 grantConfidence 的 high 档一致。
  it('确定性解析器能从原话复算出的身份值放行（93年 → 33 岁）', () => {
    const text = '陈佚非  93年  15001908960 男 有健康证';
    const result = applyFieldValueProposal(form(), AGE_FIELD, {
      value: String(new Date().getFullYear() - 1993),
      sourceText: text,
      producer: 'model',
      candidateTexts: [text],
      messages: [userMessage(text)],
    });
    expect(result.outcome).toBe('accepted');
  });

  it('复算不出等价值时仍然拒收——放宽的只是"逐字"，不是反臆造本身', () => {
    const text = '我今年不太想说年龄';
    const result = applyFieldValueProposal(form(), AGE_FIELD, {
      value: '26',
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
    const result = applyFieldValueProposal(
      form(),
      PHONE_FIELD,
      proposal({ value: '13800138000', sourceText: text, messages: [userMessage(text)] }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.invalidValueShape);
  });

  it('契约选项集外的 optionCode 拒收', () => {
    const result = applyFieldValueProposal(
      form(),
      GENDER_MALE_ONLY_FIELD,
      proposal({ value: '男', optionCodes: ['99'], sourceText: '我是男的' }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.unknownOptionCode);
  });

  it('身份槽位缺归属取证语料 → fail-closed 拒收，不当作放行', () => {
    const text = `我的手机号是${TEST_CANDIDATE_PHONE}`;
    const result = applyFieldValueProposal(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: text,
      producer: 'candidate_quote',
      candidateTexts: [text],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.missingAttributionCorpus);
  });

  it('确认式身份提案的问句只由模型自报、真实历史不存在 → fail-closed 拒收', () => {
    const result = applyFieldValueProposal(form(), PHONE_FIELD, {
      value: TEST_CANDIDATE_PHONE,
      sourceText: '确认',
      producer: 'model',
      candidateTexts: ['确认'],
      messages: [userMessage('确认')],
      agentQuestionQuote: `手机号是${TEST_CANDIDATE_PHONE}，对吗？`,
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.confirmationEvidenceRejected);
  });

  it('确认式身份提案绑定真实相邻问答对 → 允许入账', () => {
    const question = `手机号是${TEST_CANDIDATE_PHONE}，对吗？`;
    const result = applyFieldValueProposal(form(), PHONE_FIELD, {
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
    const result = applyFieldValueProposal(
      form(),
      NAME_FIELD,
      proposal({ value: '小晴', sourceText: text, messages: [userMessage(text)] }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.identityGateRejected);
  });

  it('槽位值不再持久化置信度，字面与非字面明确表达走同一入账结构', () => {
    const literal = applyFieldValueProposal(
      form(),
      AGE_FIELD,
      proposal({ value: '26', sourceText: '我今年26岁' }),
    );
    expect(literal.form.slots[AGE_FIELD.labelId].value).not.toHaveProperty('confidence');

    const semantic = applyFieldValueProposal(
      form(),
      HEALTH_CERT_FIELD,
      proposal({
        value: '有本地有效健康证',
        optionCodes: ['1'],
        sourceText: '有的，本地办的健康证',
      }),
    );
    expect(semantic.outcome).toBe('accepted');
    expect(semantic.form.slots[HEALTH_CERT_FIELD.labelId].value).not.toHaveProperty('confidence');
  });

  it('开放语义提案的正常表达未被确定性 adapter 覆盖时不拒收、不降级', () => {
    const professional: ContractFieldDef = {
      labelId: 999,
      labelTitle: '专业',
      fieldType: 'TEXT',
      required: true,
      acceptedOptions: [],
      rejectedOptions: [],
    };
    const result = applyFieldValueProposal(
      form([professional]),
      professional,
      proposal({
        value: '无',
        sourceText: '我读的通识课程，没有分专业',
        producer: 'model',
      }),
    );
    expect(result.outcome).toBe('accepted');
    expect(result.form.slots[professional.labelId].value?.value).toBe('无');
  });

  it('确定性 adapter 从原话得出不同契约值时拒绝模型提案', () => {
    const text = '没有健康证，可以办';
    const result = applyFieldValueProposal(form(), HEALTH_CERT_FIELD, {
      value: '有本地有效健康证',
      optionCodes: ['1'],
      sourceText: text,
      producer: 'model',
      candidateTexts: [text],
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(PROPOSAL_REJECTION_REASONS.deterministicConflict);
  });

  it('「93 年的」与「还在读书」可由模型映射为规范值后通过封闭公证', () => {
    const age = applyFieldValueProposal(
      form(),
      AGE_FIELD,
      proposal({ value: '33', sourceText: '我93年的', producer: 'model' }),
    );
    expect(age.outcome).toBe('accepted');

    const student: ContractFieldDef = {
      labelId: 998,
      labelTitle: '是否学生',
      fieldType: 'SINGLE_OPTION',
      required: true,
      acceptedOptions: [{ optionCode: 'student', optionLabel: '在校学生' }],
      rejectedOptions: [],
    };
    const studentResult = applyFieldValueProposal(form([student]), student, {
      value: '在校学生',
      optionCodes: ['student'],
      sourceText: '我还在读书',
      producer: 'model',
      candidateTexts: ['我还在读书'],
    });
    expect(studentResult.outcome).toBe('accepted');
  });

  it('producer 原样入账（署名如实，公证不改写来源）', () => {
    const text = '有的，本地办的健康证';
    const result = applyFieldValueProposal(form(), HEALTH_CERT_FIELD, {
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
    const ready = applyRecapResult(
      markRecapSent(fillName(createForm({ jobId: 1, contract: singleField })), [
        NAME_FIELD.labelId,
      ]),
      { affirmed: true },
    );
    expect(verdictOf(ready)).toBe('ready');

    const reopened = applyErrorList(
      ready,
      [{ labelId: NAME_FIELD.labelId, field: '姓名', msg: '姓名不合法' }],
      singleField,
    );
    expect(verdictOf(reopened)).toBe('collecting');
    expect(reopened.slots[NAME_FIELD.labelId].state).toBe('empty');
    expect(reopened.lastRecap).toBeUndefined();
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
  it('第 2 次实际发问后仍未补齐，整表转人工', () => {
    let current = form();
    for (let i = 0; i < MAX_ASKS_PER_SLOT; i += 1) {
      const step = recordUnansweredAsks(current, [NAME_FIELD.labelId], 'turn-' + (i + 1));
      expect(step.recorded).toEqual([NAME_FIELD.labelId]);
      expect(step.exhausted).toEqual(i + 1 === MAX_ASKS_PER_SLOT ? [NAME_FIELD.labelId] : []);
      current = step.form;
    }
    expect(current.slots[NAME_FIELD.labelId].askCount).toBe(MAX_ASKS_PER_SLOT);
    expect(verdictOf(current)).toBe('escalated');
    expect(current.escalatedReason).toContain('ask_limit_exhausted');
  });

  it('同一候选人回复回合内工具重试不重复计数', () => {
    const first = recordUnansweredAsks(form(), [NAME_FIELD.labelId], 'same-turn');
    const retried = recordUnansweredAsks(first.form, [NAME_FIELD.labelId], 'same-turn');
    expect(retried.recorded).toEqual([]);
    expect(retried.form.slots[NAME_FIELD.labelId].askCount).toBe(1);
  });

  it('答上了就不再计数——熔断只惩罚"问不中"', () => {
    let current = recordUnansweredAsks(form(), [NAME_FIELD.labelId], 'turn-1').form;
    current = fillName(current);
    for (let i = 0; i < 5; i += 1) {
      current = recordUnansweredAsks(current, [NAME_FIELD.labelId], 'later-' + i).form;
    }
    expect(current.escalatedReason).toBeUndefined();
  });

  it('问满转人工后候选人补齐该槽，解除 ask_limit_exhausted 但保留历史次数', () => {
    const single = createForm({ jobId: 1, contract: [NAME_FIELD] });
    const first = recordUnansweredAsks(single, [NAME_FIELD.labelId], 'turn-1').form;
    const exhausted = recordUnansweredAsks(first, [NAME_FIELD.labelId], 'turn-2').form;
    expect(verdictOf(exhausted)).toBe('escalated');

    const resolved = fillName(exhausted);
    expect(resolved.slots[NAME_FIELD.labelId].askCount).toBe(MAX_ASKS_PER_SLOT);
    expect(resolved.escalatedReason).toBeUndefined();
    expect(verdictOf(resolved)).toBe('ready');
  });

  it('旧版虚假计数首次加载时清零，已填资料与其它人工原因不受影响', () => {
    const legacyAskLimit = {
      ...form(),
      askTrackingVersion: undefined,
      escalatedReason: 'ask_limit_exhausted: ' + NAME_FIELD.labelId,
      slots: {
        ...form().slots,
        [NAME_FIELD.labelId]: { ...form().slots[NAME_FIELD.labelId], askCount: 2 },
      },
    } as unknown as BookingCollectionForm;
    const migrated = migrateAskTracking(legacyAskLimit);
    expect(migrated.askTrackingVersion).toBe(2);
    expect(migrated.slots[NAME_FIELD.labelId].askCount).toBe(0);
    expect(migrated.escalatedReason).toBeUndefined();

    const otherEscalation = {
      ...legacyAskLimit,
      escalatedReason: 'suspected_multi_person',
    };
    expect(migrateAskTracking(otherEscalation).escalatedReason).toBe('suspected_multi_person');
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
    const result = applyFieldValueProposal(form(), NAME_FIELD, {
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

describe('recordRejectedAttempts · 答而不解 ≠ 不答（badcase batch_6a8fec04ce406a6aee03d65f_*）', () => {
  it('第 1 次拒收只记账不熔断；达到上限落 unparseable_answer', () => {
    let form = createForm({ jobId: 1, contract: [NAME_FIELD] });

    const first = recordRejectedAttempts(form, [NAME_FIELD.labelId]);
    form = first.form;
    expect(first.exhausted).toEqual([]);
    expect(form.slots[NAME_FIELD.labelId].rejectedAttempts).toBe(1);
    expect(form.escalatedReason).toBeUndefined();

    const second = recordRejectedAttempts(form, [NAME_FIELD.labelId]);
    expect(second.exhausted).toEqual([NAME_FIELD.labelId]);
    expect(second.form.slots[NAME_FIELD.labelId].rejectedAttempts).toBe(
      MAX_REJECTED_ATTEMPTS_PER_SLOT,
    );
    expect(second.form.escalatedReason).toBe(`unparseable_answer: ${NAME_FIELD.labelId}`);
  });

  it('同一候选人回合（turnId）重复拒收只记一次——模型同轮重试工具不烧配额（生产 chat 6a9117face406a6aee7f99c9）', () => {
    let form = createForm({ jobId: 1, contract: [NAME_FIELD] });
    const first = recordRejectedAttempts(form, [NAME_FIELD.labelId], 'turn-1');
    form = first.form;
    expect(form.slots[NAME_FIELD.labelId].rejectedAttempts).toBe(1);

    // 模型收到拒收提示后同轮原样重投：第二次工具调用不得再记账、更不得熔断。
    const sameTurnRetry = recordRejectedAttempts(form, [NAME_FIELD.labelId], 'turn-1');
    expect(sameTurnRetry.exhausted).toEqual([]);
    expect(sameTurnRetry.form.slots[NAME_FIELD.labelId].rejectedAttempts).toBe(1);
    expect(sameTurnRetry.form.escalatedReason).toBeUndefined();

    // 候选人下一轮再次真实作答仍读不懂 → 这才是第 2 次，熔断成立。
    const nextTurn = recordRejectedAttempts(sameTurnRetry.form, [NAME_FIELD.labelId], 'turn-2');
    expect(nextTurn.exhausted).toEqual([NAME_FIELD.labelId]);
    expect(nextTurn.form.escalatedReason).toBe(`unparseable_answer: ${NAME_FIELD.labelId}`);
  });

  it('非 empty 槽位不记账（同轮已被其它通道写入的不算读不懂）', () => {
    let form = createForm({ jobId: 1, contract: [NAME_FIELD] });
    const written = applyFieldValueProposal(form, NAME_FIELD, {
      value: TEST_CANDIDATE_NAME,
      sourceText: `姓名：${TEST_CANDIDATE_NAME}`,
      producer: 'candidate_quote',
      candidateTexts: [`姓名：${TEST_CANDIDATE_NAME}`],
      messages: [userMessage(`姓名：${TEST_CANDIDATE_NAME}`)],
    });
    form = written.form;
    const receipt = recordRejectedAttempts(form, [NAME_FIELD.labelId]);
    expect(receipt.form.slots[NAME_FIELD.labelId].rejectedAttempts).toBeUndefined();
  });

  it('已有 escalatedReason 不被覆盖（与 recordUnansweredAsks 同款保序）', () => {
    let form = createForm({ jobId: 1, contract: [NAME_FIELD] });
    form = escalate(form, 'suspected_multi_person');
    form = recordRejectedAttempts(form, [NAME_FIELD.labelId]).form;
    form = recordRejectedAttempts(form, [NAME_FIELD.labelId]).form;
    expect(form.escalatedReason).toBe('suspected_multi_person');
  });

  it('unparseable_answer 是可恢复原因：槽位后来补齐即解除（reconcile 双前缀）', () => {
    let form = createForm({ jobId: 1, contract: [NAME_FIELD] });
    form = recordRejectedAttempts(form, [NAME_FIELD.labelId]).form;
    form = recordRejectedAttempts(form, [NAME_FIELD.labelId]).form;
    expect(verdictOf(form)).toBe('escalated');

    const written = applyFieldValueProposal(form, NAME_FIELD, {
      value: TEST_CANDIDATE_NAME,
      sourceText: `姓名：${TEST_CANDIDATE_NAME}`,
      producer: 'candidate_quote',
      candidateTexts: [`姓名：${TEST_CANDIDATE_NAME}`],
      messages: [userMessage(`姓名：${TEST_CANDIDATE_NAME}`)],
    });
    expect(written.outcome).toBe('accepted');
    expect(written.form.escalatedReason).toBeUndefined();
    expect(verdictOf(written.form)).toBe('ready');
  });
});

describe('yieldRecoverableEscalationToScreening · 筛选终局优先', () => {
  function formWithDisqualifiedAge(): BookingCollectionForm {
    const form = createForm({ jobId: 1, contract: [AGE_FIELD_18_40] });
    const result = applyFieldValueProposal(form, AGE_FIELD_18_40, {
      value: '55',
      sourceText: '我55岁',
      producer: 'candidate_quote',
      candidateTexts: ['我55岁'],
      messages: [userMessage('我55岁')],
    });
    expect(result.outcome).toBe('disqualified');
    return result.form;
  }

  it('可恢复熔断（问满/读不懂）让位 disqualified，verdict 回到筛选终局', () => {
    for (const reason of ['ask_limit_exhausted: 12', 'unparseable_answer: 12']) {
      const escalated = { ...formWithDisqualifiedAge(), escalatedReason: reason };
      const yielded = yieldRecoverableEscalationToScreening(escalated);
      expect(yielded.escalatedReason).toBeUndefined();
      expect(verdictOf(yielded)).toBe('disqualified');
    }
  });

  it('不可恢复原因（疑似多人/errorList 失配）不让位', () => {
    const escalated = { ...formWithDisqualifiedAge(), escalatedReason: 'suspected_multi_person' };
    const kept = yieldRecoverableEscalationToScreening(escalated);
    expect(kept.escalatedReason).toBe('suspected_multi_person');
    expect(verdictOf(kept)).toBe('escalated');
  });

  it('没有 disqualified 槽位时不动（熔断该转人工就转）', () => {
    let form = createForm({ jobId: 1, contract: [NAME_FIELD] });
    form = { ...form, escalatedReason: 'ask_limit_exhausted: 769' };
    expect(yieldRecoverableEscalationToScreening(form).escalatedReason).toBe(
      'ask_limit_exhausted: 769',
    );
  });
});
