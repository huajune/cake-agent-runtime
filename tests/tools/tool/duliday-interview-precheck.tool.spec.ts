import { getTomorrowDate } from '@infra/utils/date.util';
import { buildBookableSlots } from '@tools/booking/bookable-slot.util';
import {
  createForm,
  markSubmitted,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import type { ToolBuildContext } from '@shared-types/tool.types';
import {
  buildInterviewPrecheckTool,
  COLLECTION_TEMPLATE_SEND_INSTRUCTION,
  PRECHECK_DESCRIPTION,
  PRECHECK_INPUT_SCHEMA,
} from '@tools/duliday-interview-precheck.tool';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext, mergeToolContext } from '../../helpers/tool-context.fixture';

const CONTRACT = [
  {
    labelId: 101,
    labelTitle: '姓名',
    fieldType: 'TEXT' as const,
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'name' as const,
  },
  {
    labelId: 102,
    labelTitle: '联系电话',
    fieldType: 'TEXT' as const,
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'phone' as const,
  },
  {
    labelId: 103,
    labelTitle: '年龄',
    fieldType: 'TEXT' as const,
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'age' as const,
  },
  {
    labelId: 104,
    labelTitle: '性别',
    fieldType: 'SINGLE_OPTION' as const,
    required: true,
    acceptedOptions: [
      { optionCode: 'MALE', optionLabel: '男' },
      { optionCode: 'FEMALE', optionLabel: '女' },
    ],
    rejectedOptions: [],
    systemField: 'gender' as const,
  },
];
const PROFESSIONAL_CONTRACT = [
  {
    labelId: 213,
    labelTitle: '专业',
    fieldType: 'TEXT' as const,
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
  },
];
const RECAP_TAIL = '没问题的话我这就帮你提交，有不对的地方直接说改哪项';

const JOB = {
  basicInfo: {
    jobId: 100,
    brandName: '测试品牌',
    jobName: '服务员',
    storeInfo: { storeName: '测试门店' },
  },
  hiringRequirement: {
    basicPersonalRequirements: { minAge: 18, maxAge: 20 },
  },
  interviewProcess: {
    firstInterview: {
      firstInterviewWay: '电话面试',
      periodicInterviewTimes: [],
      fixedInterviewTimes: [],
    },
  },
};

// 覆盖全周的周期性面试窗口：requestedDate 可约性校验对任意未来日期都能命中时段。
const JOB_WITH_WINDOWS = {
  ...JOB,
  interviewProcess: {
    firstInterview: {
      firstInterviewWay: '门店面试',
      periodicInterviewTimes: ['一', '二', '三', '四', '五', '六', '日'].map((day) => ({
        interviewWeekday: `每周${day}`,
        interviewTimes: [{ interviewStartTime: '10:00', interviewEndTime: '18:00' }],
      })),
      fixedInterviewTimes: [],
    },
  },
};

// 同日双窗口（上午 10:00-11:00 + 下午 13:00-16:00）：唯一 slot 兜底失效的形态。
const JOB_WITH_TWO_WINDOWS = {
  ...JOB,
  interviewProcess: {
    firstInterview: {
      firstInterviewWay: '门店面试',
      periodicInterviewTimes: ['一', '二', '三', '四', '五', '六', '日'].map((day) => ({
        interviewWeekday: `每周${day}`,
        interviewTimes: [
          { interviewStartTime: '10:00', interviewEndTime: '11:00' },
          { interviewStartTime: '13:00', interviewEndTime: '16:00' },
        ],
      })),
      fixedInterviewTimes: [],
    },
  },
};

function filledForm(contract = CONTRACT): BookingCollectionForm {
  const form = createForm({ jobId: 100, contract });
  form.contractSnapshot = { fields: [...contract] };
  for (const field of contract) {
    const values: Record<number, { value: string; optionCodes?: string[] }> = {
      101: { value: '兮兮' },
      102: { value: '18271421690' },
      103: { value: '25' },
      104: { value: '女', optionCodes: ['FEMALE'] },
    };
    const value = values[field.labelId] ?? { value: '已填写' };
    form.slots[field.labelId] = {
      labelId: field.labelId,
      state: 'filled',
      askCount: 1,
      value: {
        ...value,
        sourceText: value.value,
        producer: field.labelId === contract[0]?.labelId ? 'archive' : 'candidate_quote',
      },
    };
  }
  form.lastRecap = { labelIds: contract.map((field) => field.labelId) };
  return form;
}

function recapDialogue(reply: string): Array<{ role: 'assistant' | 'user'; content: string }> {
  return [
    {
      role: 'assistant',
      content: [
        '帮你核对一下报名信息：',
        '姓名：兮兮',
        '联系电话：18271421690',
        '年龄：25',
        '性别：女',
        '',
        RECAP_TAIL,
      ].join('\n'),
    },
    { role: 'user', content: reply },
  ];
}

function recapConfirmationInput() {
  return {
    mode: 'validate',
    jobId: 100,
    recapConfirmation: true,
  };
}

describe('duliday_interview_precheck（collection form 唯一路径）', () => {
  let currentForm: BookingCollectionForm | null;
  let context: ToolBuildContext;
  const collectionForms = {
    loadOrCreate: jest.fn(async (_scope, contract, _candidatePhone?: string) => {
      currentForm ??= createForm({ jobId: 100, contract });
      currentForm.contractSnapshot ??= { fields: [...contract] };
      return currentForm;
    }),
    refreshContractSnapshot: jest.fn(
      (form: BookingCollectionForm, contract: readonly ContractFieldDef[]) => ({
        ...form,
        contractSnapshot: { fields: [...contract] },
      }),
    ),
    persist: jest.fn(async (_scope, form) => {
      currentForm = form;
    }),
    saveFinalizedProgressFacts: jest.fn().mockResolvedValue(undefined),
    rebindToPhone: jest.fn(async (_scope, form, phone) => ({ ...form, candidateRef: phone })),
  };
  const sponge = {
    fetchJobs: jest.fn(),
    fetchJobCollectionContract: jest.fn(),
  };
  const ops = { recordEvent: jest.fn().mockResolvedValue(true) };
  const observer = { emit: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    currentForm = null;
    context = createToolContext({
      session: {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        botUserId: 'wecom-user-A',
      },
      turnInput: { messages: [] },
    });
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB] });
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: CONTRACT });
  });

  async function execute(input: Record<string, unknown>) {
    const built = buildInterviewPrecheckTool(sponge as never, ops as never, {
      collectionForms: collectionForms as never,
      observer,
    })(context);
    const normalizedInput = {
      mode:
        input.mode ??
        (input.fieldValueProposals !== undefined || input.recapConfirmation === true
          ? 'validate'
          : 'query'),
      ...input,
    };
    return built.execute!(normalizedInput as never, {
      toolCallId: 'precheck-test',
      context: {},
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<Record<string, any>>;
  }

  it('公开工具 Schema 用显式 mode 区分查询与收资校验', () => {
    expect(Object.keys(PRECHECK_INPUT_SCHEMA.shape)).toEqual([
      'mode',
      'jobId',
      'candidatePhone',
      'requestedDate',
      'fieldValueProposals',
      'recapConfirmation',
    ]);
    expect(PRECHECK_DESCRIPTION).not.toContain('candidateClaims');
    expect(PRECHECK_DESCRIPTION).toContain(COLLECTION_TEMPLATE_SEND_INSTRUCTION);
    expect(PRECHECK_DESCRIPTION).toContain('mode="query"');
    expect(PRECHECK_DESCRIPTION).toContain('mode="validate"');
    expect(PRECHECK_DESCRIPTION).not.toContain('先仅传 jobId');
    expect(PRECHECK_INPUT_SCHEMA.safeParse({ mode: 'query', jobId: 100 }).success).toBe(true);
    expect(
      PRECHECK_INPUT_SCHEMA.safeParse({
        mode: 'query',
        jobId: 100,
        requestedDate: '2026-09-10',
      }).success,
    ).toBe(true);
    expect(
      PRECHECK_INPUT_SCHEMA.safeParse({
        mode: 'validate',
        jobId: 100,
        fieldValueProposals: [{ labelTitle: '年龄', value: false, quote: '不是学生' }],
      }).success,
    ).toBe(false);
    expect(
      PRECHECK_INPUT_SCHEMA.safeParse({
        mode: 'validate',
        jobId: 100,
        recapConfirmation: true,
      }).success,
    ).toBe(true);
    expect(PRECHECK_INPUT_SCHEMA.safeParse({ mode: 'validate', jobId: 100 }).success).toBe(false);
    expect(
      PRECHECK_INPUT_SCHEMA.safeParse({
        mode: 'query',
        jobId: 100,
        fieldValueProposals: [{ labelTitle: '年龄', value: '20', quote: '20岁' }],
      }).success,
    ).toBe(false);
    expect(
      PRECHECK_INPUT_SCHEMA.safeParse({
        mode: 'validate',
        jobId: 100,
        recapConfirmation: { candidateQuote: '好的', recapQuote: RECAP_TAIL },
      }).success,
    ).toBe(false);
  });

  it('多人报名显式指定本轮手机号时使用独立 additional 表单并禁止污染主联系人事实', async () => {
    const candidatePhone = '18271421691';
    const text = [
      '第二位候选人',
      '姓名：小李',
      `联系电话：${candidatePhone}`,
      '年龄：19',
      '性别：男',
    ].join('\n');
    context.turnInput.messages = [{ role: 'user', content: text }];
    collectionForms.loadOrCreate.mockImplementationOnce(
      async (_scope, contract, phone?: string, options?: { candidateScope?: 'additional' }) => {
        expect(phone).toBe(candidatePhone);
        expect(options).toEqual({ candidateScope: 'additional' });
        return {
          ...createForm({ candidateRef: candidatePhone, jobId: 100, contract }),
          contractSnapshot: { fields: [...contract] },
          candidateScope: 'additional' as const,
        };
      },
    );

    const result = await execute({
      jobId: 100,
      candidatePhone,
      fieldValueProposals: [
        { labelTitle: '姓名', value: '小李', quote: '姓名：小李' },
        { labelTitle: '联系电话', value: candidatePhone, quote: `联系电话：${candidatePhone}` },
        { labelTitle: '年龄', value: '19', quote: '年龄：19' },
        { labelTitle: '性别', value: '男', quote: '性别：男' },
      ],
    });

    expect(result).toMatchObject({
      candidateScope: 'additional',
      collectionVerdict: 'ready',
      nextAction: 'ready_to_book',
    });
    expect(result._replyInstruction).toContain('只有 booking success=true 后才能处理下一人');
    expect(collectionForms.saveFinalizedProgressFacts).not.toHaveBeenCalled();
  });

  it('无答案时字段全集、展示顺序和模板全部只来自实时岗位契约', async () => {
    const result = await execute({ jobId: 100 });
    expect(result.bookingChecklist.requiredFields).toEqual(['姓名', '联系电话', '年龄', '性别']);
    for (const title of result.bookingChecklist.requiredFields) {
      expect(result.bookingChecklist.templateText).toContain(`${title}：`);
    }
    expect(result._replyInstruction).toContain(COLLECTION_TEMPLATE_SEND_INSTRUCTION);
    expect(collectionForms.persist).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        contractSnapshot: {
          fields: expect.arrayContaining(CONTRACT.map((field) => expect.objectContaining(field))),
        },
      }),
    );
  });

  it('mode=query 只读取表单与预约信息，不消费当前消息里的报名答案', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮' }];

    const queried = await execute({ mode: 'query', jobId: 100 });

    expect(queried.collectionVerdict).toBe('collecting');
    expect(queried.bookingChecklist.knownFieldMap).toBeUndefined();
    expect(currentForm?.slots[101].state).toBe('empty');
    expect(queried._replyInstruction).toContain('改用 mode=validate');

    const validated = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' }],
    });
    expect(validated.bookingChecklist.knownFieldMap).toEqual(
      expect.objectContaining({ 姓名: '兮兮' }),
    );
  });

  it('首次 validate 同次建立实时契约快照并校验答案，不要求预先 query', async () => {
    collectionForms.loadOrCreate.mockImplementationOnce(async (_scope, contract) =>
      createForm({ jobId: 100, contract }),
    );
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮' }];

    const result = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' }],
    });

    expect(result.errorType).toBeUndefined();
    expect(result.collectionVerdict).toBe('collecting');
    expect(result.bookingChecklist.knownFieldMap).toEqual(
      expect.objectContaining({ 姓名: '兮兮' }),
    );
    expect(collectionForms.refreshContractSnapshot).toHaveBeenCalled();
    expect(collectionForms.persist).toHaveBeenCalled();
  });

  it('校验时海绵契约已不同于持久快照则拒绝混版', async () => {
    const stored = createForm({ jobId: 100, contract: CONTRACT });
    stored.contractSnapshot = {
      fields: [{ ...CONTRACT[0], labelTitle: '旧版姓名' }, ...CONTRACT.slice(1)],
    };
    collectionForms.loadOrCreate.mockResolvedValueOnce(stored);

    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮' }];
    const result = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' }],
    });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_CONTRACT_CHANGED);
    expect(result._replyInstruction).toContain('刷新');
    expect(collectionForms.persist).not.toHaveBeenCalled();
  });

  it('岗位确定后的首次收资同时返回真实 bookableSlots', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    const result = await execute({ mode: 'query', jobId: 100 });
    expect(result.collectionVerdict).toBe('collecting');
    expect(result.bookingChecklist.templateText).toContain('姓名：');
    expect(result.interview.bookableSlots.length).toBeGreaterThan(0);
    expect(result.interview.bookableSlots).toEqual(
      expect.arrayContaining([expect.objectContaining({ bookingAllowed: true })]),
    );
    expect(result._replyInstruction).toContain('面试时间');
  });

  it('无法解析的 requestedDate 不落草稿，但不阻断并行收资', async () => {
    const result = await execute({ jobId: 100, requestedDate: 'next week' });
    expect(result.errorType).toBeUndefined();
    expect(result.interview.scheduleDraft).toBeUndefined();
    expect(result.collectionVerdict).toBe('collecting');
    expect(sponge.fetchJobs).toHaveBeenCalled();
  });

  it('jobId 不在会话召回集时先于 Sponge 拦截', async () => {
    context = mergeToolContext(context, {
      archive: { recalledJobIds: [200], isRecalledJobId: (jobId) => jobId === 200 },
    });
    const result = await execute({ mode: 'query', jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_PROVIDED);
    expect(result._replyInstruction).toContain('cityNameList');
    expect(result._replyInstruction).toContain('brandAliasList');
    expect(result._replyInstruction).toContain('searchJobName');
    expect(sponge.fetchJobs).not.toHaveBeenCalled();
  });

  it('collecting：只返回当前 empty 槽，filled 槽不会复问', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' }],
    });
    expect(result.collectionVerdict).toBe('collecting');
    expect(result.nextAction).toBe('collect_fields');
    expect(result.bookingChecklist.requiredFieldsToCollectNow).toEqual([
      '联系电话',
      '年龄',
      '性别',
    ]);
    expect(result.bookingChecklist.requiredFieldsToCollectNow).not.toContain('姓名');
    expect(collectionForms.saveFinalizedProgressFacts).toHaveBeenCalledWith(
      {
        corpId: 'corp-1',
        userId: 'user-1',
        botUserId: 'wecom-user-A',
        jobId: 100,
        sessionId: 'session-1',
      },
      expect.objectContaining({ slots: expect.any(Object) }),
      expect.any(Array),
      [expect.objectContaining({ labelId: 101 })],
    );
  });

  it('完整自然表达同轮给齐资料和时间：无 recap 并直接 ready_to_book', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    context.turnInput.messages = [
      { role: 'user', content: '我叫兮兮，电话18271421690，我今年25岁，我是女的，明天面试' },
    ];
    const result = await execute({
      jobId: 100,
      requestedDate: '明天',
      fieldValueProposals: [
        { labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '电话18271421690' },
        { labelTitle: '年龄', value: '25', quote: '我今年25岁' },
        { labelTitle: '性别', value: '女', quote: '我是女的' },
      ],
    });
    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('ready_to_book');
    expect(result.recap).toBeUndefined();
    expect(currentForm?.lastRecap).toBeUndefined();
    expect(currentForm?.scheduleDraft).toEqual(
      expect.objectContaining({
        requestedDate: getTomorrowDate(),
        selectedInterviewTime: expect.any(String),
      }),
    );
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('逐行填满模板与自然表达走同一路径：资料授权，无时间则 select_interview_time', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    const filledTemplate = ['姓名：兮兮', '联系电话：18271421690', '年龄：25', '性别：女'].join(
      '\n',
    );
    context.turnInput.messages = [{ role: 'user', content: filledTemplate }];

    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        { labelTitle: '姓名', value: '兮兮', quote: '姓名：兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '联系电话：18271421690' },
        { labelTitle: '年龄', value: '25', quote: '年龄：25' },
        { labelTitle: '性别', value: '女', quote: '性别：女' },
      ],
    });

    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('select_interview_time');
    expect(result.interview.availabilityAuthority).toEqual(
      expect.objectContaining({
        timezone: 'Asia/Shanghai',
        authoritativeField: 'bookableSlots',
      }),
    );
    expect(result._replyInstruction).toContain('严禁根据“当天”或当前钟点二次计算');
    expect(result.recap).toBeUndefined();
    expect(currentForm?.lastRecap).toBeUndefined();
    expect(context.ledger.jobs.collectionReadyJobId).toBeUndefined();
  });

  it('多轮里的明确候选人作答同样直接资料授权，不生成 recap', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    context.turnInput.messages = [
      {
        role: 'assistant',
        content: '你先把资料发我，我帮你约：\n姓名：\n联系电话：\n年龄：\n性别：',
      },
      {
        role: 'user',
        content: ['姓名：兮兮', '联系电话：18271421690', '年龄：25', '性别：女'].join('\n'),
      },
      { role: 'assistant', content: '收到你的资料啦，我先核对一下' },
      { role: 'user', content: '对' },
    ];

    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        { labelTitle: '姓名', value: '兮兮', quote: '姓名：兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '联系电话：18271421690' },
        { labelTitle: '年龄', value: '25', quote: '年龄：25' },
        { labelTitle: '性别', value: '女', quote: '性别：女' },
      ],
    });

    expect(result.nextAction).toBe('select_interview_time');
    expect(result.recap).toBeUndefined();
    expect(currentForm?.lastRecap).toBeUndefined();
  });

  // 生产 chat 6a8d583b：年龄被公证退回，工具只回了 missing=[年龄]、没说为什么，
  // 模型于是回头再问候选人一遍。拒收必须对模型可见，与 unmatchedAnswers 同形。
  it('公证拒收对模型可见：rejectedAnswers 带原因与改法，收资指令点名被退回的字段', async () => {
    const text = '我叫兮兮，我是女的';
    context.turnInput.messages = [{ role: 'user', content: text }];

    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        { labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' },
        // 候选人这句话里没有电话，模型却提交了一个号码——公证必须退回。
        { labelTitle: '联系电话', value: '18271421690', quote: '我叫兮兮，我是女的' },
      ],
    });

    expect(result.rejectedAnswers).toEqual([
      expect.objectContaining({ labelTitle: '联系电话', reason: 'value_not_in_source_text' }),
    ]);
    expect(result.rejectedAnswers[0].hint).toContain('不要提交自行加工过的值');
    expect(result._replyInstruction).toContain('联系电话');
    expect(result._replyInstruction).toContain('被公证退回');
    // 退回的字段没有入账，仍在待收清单里。
    expect(result.bookingChecklist.missingFields).toContain('联系电话');
  });

  it('身份闸门拒绝昵称后要求补问真名，禁止原值重投', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我是兮兮' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '姓名', value: '兮兮', quote: '我是兮兮' }],
    });

    expect(result.rejectedAnswers).toEqual([
      expect.objectContaining({
        labelTitle: '姓名',
        reason: 'identity_gate_rejected',
        action: 'ask_candidate',
        hint: expect.stringContaining('自动打招呼里的昵称'),
      }),
    ]);
    expect(result._replyInstruction).toContain('禁止原值重投');
    expect(result._replyInstruction).toContain('等待新回复后再提交');
    expect(result._replyInstruction).not.toContain('已有真实答案不要重复询问');
  });

  it('社保肯定答案缺维度时只澄清缺项，并把标签文本与类型写入审计', async () => {
    const socialInsuranceField = {
      labelId: 12,
      labelTitle: '社保缴纳情况',
      fieldType: 'SINGLE_OPTION' as const,
      required: true,
      acceptedOptions: [
        { optionCode: '1', optionLabel: '本人缴纳本地社保' },
        { optionCode: '2', optionLabel: '无公司在缴社保流水' },
        { optionCode: '3', optionLabel: '公司缴纳本地社保' },
        { optionCode: '4', optionLabel: '本人缴纳外地社保' },
        { optionCode: '5', optionLabel: '公司缴纳外地社保' },
      ],
      rejectedOptions: [],
    };
    sponge.fetchJobCollectionContract.mockResolvedValue({
      jobId: 100,
      fields: [socialInsuranceField],
    });
    context.turnInput.messages = [{ role: 'user', content: '社保缴纳情况：个人灵活社保' }];

    const result = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [
        {
          labelTitle: '社保缴纳情况',
          value: '个人灵活社保',
          quote: '社保缴纳情况：个人灵活社保',
        },
      ],
    });
    expect(result.rejectedAnswers).toEqual([
      expect.objectContaining({
        labelTitle: '社保缴纳情况',
        reason: 'social_insurance_dimensions_missing',
        action: 'ask_candidate',
        hint: expect.stringContaining('参保地是本地还是外地'),
      }),
    ]);
    expect(result.rejectedAnswers[0].hint).not.toContain('本人还是公司');
    expect(observer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collection_form_audit',
        kind: 'proposal_rejected',
        labelId: 12,
        labelTitle: '社保缴纳情况',
        fieldType: 'SINGLE_OPTION',
        reason: 'social_insurance_dimensions_missing',
      }),
    );
  });

  it('没有拒收时不返回 rejectedAnswers，收资指令保持原样', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' }],
    });

    expect(result.rejectedAnswers).toBeUndefined();
    expect(result._replyInstruction).not.toContain('被公证退回');
  });

  // 生产 chat 6a9117face406a6aee7f99c9：候选人打字填「上传简历」，通用提示「核对后重投」
  // 引导模型同轮重投，两次拒收一轮烧光「读不懂两次」配额，候选人只作答一次即转人工。
  it('FILE 字段文字作答：拒收提示改为让候选人发文件；同轮重投不熔断，下一轮仍失败才转人工', async () => {
    const fileContract = [
      ...CONTRACT,
      {
        labelId: 149,
        labelTitle: '上传简历',
        fieldType: 'FILE' as const,
        required: true,
        acceptedOptions: [],
        rejectedOptions: [],
      },
    ];
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: fileContract });
    context.session.turnId = 'batch-turn-1';
    const text = '上传简历：之前在宿迁开挖掘机，后来在苏州当司机';
    context.turnInput.messages = [{ role: 'user', content: text }];

    const fileProposal = {
      labelTitle: '上传简历',
      value: '之前在宿迁开挖掘机，后来在苏州当司机',
      quote: text,
    };
    const first = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [fileProposal],
    });
    expect(first.rejectedAnswers).toEqual([
      expect.objectContaining({ labelTitle: '上传简历', reason: 'invalid_value_shape' }),
    ]);
    expect(first.rejectedAnswers[0].hint).toContain('直接把简历文件或简历截图/照片发过来');
    expect(first.rejectedAnswers[0].hint).not.toContain('手机号非 11 位');
    expect(first.nextAction).toBe('collect_fields');

    // 模型收到拒收回执后同轮原样重投：不得把「读不懂两次」的配额一轮烧光。
    const sameTurnRetry = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [fileProposal],
    });
    expect(sameTurnRetry.nextAction).toBe('collect_fields');

    // 同一句话滞留在证据窗里被下一轮重新解析，也不得再烧一次配额：
    // 熔断配额按**作答内容**记，不按轮数记（生产 chat 6a94e92d… 籍贯「南京」案）。
    context.session.turnId = 'batch-turn-2';
    const sameTextNextTurn = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [fileProposal],
    });
    expect(sameTextNextTurn.nextAction).toBe('collect_fields');

    // 候选人**换了一句**仍以文字作答（发文件引导已明确给过）→ 这才转人工。
    context.session.turnId = 'batch-turn-3';
    context.turnInput.messages = [{ role: 'user', content: '上传简历：我还开过叉车' }];
    const nextTurn = await execute({
      mode: 'validate',
      jobId: 100,
      fieldValueProposals: [
        {
          labelTitle: '上传简历',
          value: '我还开过叉车',
          quote: '上传简历：我还开过叉车',
        },
      ],
    });
    expect(nextTurn.nextAction).toBe('handoff');
  });

  it('ask_limit_exhausted 后候选人补齐对应字段，解除 handoff 并进入选时间', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    sponge.fetchJobCollectionContract.mockResolvedValue({
      jobId: 100,
      fields: PROFESSIONAL_CONTRACT,
    });
    currentForm = createForm({ jobId: 100, contract: PROFESSIONAL_CONTRACT });
    currentForm.slots[213].askCount = 2;
    currentForm.slots[213].lastAskCountedTurnId = 'previous-turn';
    currentForm.escalatedReason = 'ask_limit_exhausted: 213';
    context.session.turnId = 'candidate-filled-professional';
    context.turnInput.messages = [
      { role: 'assistant', content: '你什么专业？没有就是无' },
      { role: 'user', content: '专业：无' },
    ];

    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '专业', value: '无', quote: '专业：无' }],
    });

    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('select_interview_time');
    expect(currentForm?.slots[213].state).toBe('filled');
    expect(currentForm?.slots[213].askCount).toBe(2);
    expect(currentForm?.escalatedReason).toBeUndefined();
    expect(result.recap).toBeUndefined();
  });

  it('archive 外部预填的 ready 表单进入 confirm_collection', async () => {
    currentForm = filledForm();
    currentForm.lastRecap = undefined;
    const result = await execute({ jobId: 100 });
    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('confirm_collection');
    expect(result.recap.candidateMessage).toContain('姓名：兮兮');
    expect(context.ledger.jobs.collectionReadyJobId).toBeUndefined();
  });

  it.each(['没问题', '好的', '确认', '没问题，麻烦老师了', '可以的，麻烦了'])(
    '明确确认“%s”均以同形态 recapConfirmation 绑定真实相邻 recap 后一次放行',
    async (candidateQuote) => {
      currentForm = filledForm();
      context.turnInput.messages = recapDialogue(candidateQuote);
      const input = recapConfirmationInput();
      expect(input.recapConfirmation).toBe(true);

      const result = await execute(input);

      expect(result.nextAction).toBe('ready_to_book');
      expect(currentForm?.lastRecap?.affirmed).toBe(true);
      expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
    },
  );

  it('外部预填 recap 与选择时间可在同一候选人轮完成', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    currentForm = filledForm();
    const candidateQuote = '没问题，明天可以面试';
    context.turnInput.messages = recapDialogue(candidateQuote);

    const result = await execute({
      ...recapConfirmationInput(),
      requestedDate: '明天',
    });

    expect(currentForm?.lastRecap?.affirmed).toBe(true);
    expect(currentForm?.scheduleDraft).toEqual(
      expect.objectContaining({
        requestedDate: getTomorrowDate(),
        selectedInterviewTime: expect.any(String),
      }),
    );
    expect(result.nextAction).toBe('ready_to_book');
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('候选人纠正最后一个外部预填值后重新派生为无 recap，无时间则只选时间', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    sponge.fetchJobCollectionContract.mockResolvedValue({
      jobId: 100,
      fields: PROFESSIONAL_CONTRACT,
    });
    currentForm = createForm({ jobId: 100, contract: PROFESSIONAL_CONTRACT });
    currentForm.slots[213] = {
      labelId: 213,
      state: 'filled',
      askCount: 0,
      value: { value: '市场营销', sourceText: '档案：市场营销', producer: 'archive' },
    };
    currentForm.lastRecap = { labelIds: [213] };
    const text = '专业不是市场营销，是计算机';
    context.turnInput.messages = [{ role: 'user', content: text }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        { labelTitle: '专业', value: '计算机', quote: text, operation: 'correct' },
      ],
    });
    expect(currentForm?.slots[213].value).toEqual(
      expect.objectContaining({ value: '计算机', producer: 'model' }),
    );
    expect(currentForm?.lastRecap).toBeUndefined();
    expect(result.nextAction).toBe('select_interview_time');
  });

  it('未提交 recapConfirmation 时，短答也不能旁路 recap notary', async () => {
    currentForm = filledForm();
    context.turnInput.messages = recapDialogue('好的');
    const result = await execute({ jobId: 100 });
    expect(result.nextAction).toBe('confirm_collection');
    expect(currentForm?.lastRecap?.affirmed).not.toBe(true);
    expect(context.ledger.jobs.collectionReadyJobId).toBeUndefined();
  });

  it('lastRecap 已落账但当前 KV 从未真实送达时补回官方 candidateMessage', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '我看一下' }];

    const result = await execute({ jobId: 100 });

    expect(result.nextAction).toBe('confirm_collection');
    expect(result.recap.candidateMessage).toContain('姓名：兮兮');
    expect(result.recap.candidateMessage).toContain('联系电话：18271421690');
    expect(result._replyInstruction).toContain('发送 recap.candidateMessage');
  });

  it('先确认复述、下一轮再选面试日期时仍放行 booking', async () => {
    currentForm = filledForm();
    context.turnInput.messages = recapDialogue('没问题');
    const confirmed = await execute(recapConfirmationInput());
    expect(confirmed.nextAction).toBe('ready_to_book');
    expect(currentForm?.lastRecap?.affirmed).toBe(true);

    // 模拟新回合：ledger 是轮内态，但 Redis 表单保留上轮的复述确认。
    context.ledger.jobs.collectionReadyJobId = undefined;
    context.turnInput.messages = [{ role: 'user', content: '明天10点' }];
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });

    const dated = await execute({ jobId: 100, requestedDate: '明天' });
    expect(dated.nextAction).toBe('ready_to_book');
    expect(dated.interview.requestedDate).toEqual(
      expect.objectContaining({ value: getTomorrowDate(), status: 'available' }),
    );
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('隔轮追认：复述后插入简短追问轮，候选人再确认仍可入账（死锁回归）', async () => {
    // 生产 chat 6a951ac7ce406a6aeea1338c 形态：紧邻 assistant 组只有简短追问、
    // 不含「标签：值」行；快照未变时在案复述仍是有效锚点，「没」这类语境化短答可入账。
    currentForm = filledForm();
    context.turnInput.messages = [
      ...recapDialogue('稍等'),
      { role: 'assistant', content: '好嘞，确认下没问题我就帮你提交' },
      { role: 'user', content: '没' },
    ];
    const result = await execute(recapConfirmationInput());
    expect(result.nextAction).toBe('ready_to_book');
    expect(currentForm?.lastRecap?.affirmed).toBe(true);
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('recapConfirmation 找不到真实送达的当前快照时给模型回执并落审计', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '好的' }];
    const result = await execute(recapConfirmationInput());
    expect(result.nextAction).toBe('confirm_collection');
    expect(result.rejectedRecapConfirmation).toEqual({
      reason: 'recap_snapshot_mismatch',
      hint: expect.stringContaining('官方文本'),
    });
    expect(result._replyInstruction).toContain('rejectedRecapConfirmation');
    expect(observer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collection_form_audit',
        kind: 'recap_confirmation_rejected',
        reason: 'recap_snapshot_mismatch',
        channel: 'recap_confirmation',
      }),
    );
  });

  it('复述被改写送达时判快照失配，并返回官方文案供照发重投', async () => {
    // 生产 chat 6a951cadce406a6aeed925e7 形态：模型没照发官方复述，标签被改写，
    // 教科书式「好的」也无法入账；回执给出官方文案让模型重发走出死锁。
    currentForm = filledForm();
    context.turnInput.messages = [
      {
        role: 'assistant',
        content: '资料确认下：\n名字 兮兮\n电话 18271421690\n确认无误我就帮你提交了',
      },
      { role: 'user', content: '好的' },
    ];
    const result = await execute(recapConfirmationInput());
    expect(result.nextAction).toBe('confirm_collection');
    expect(result.rejectedRecapConfirmation.reason).toBe('recap_snapshot_mismatch');
    expect(result.recap.candidateMessage).toContain('姓名：兮兮');
    expect(result._replyInstruction).toContain('照发');
    expect(currentForm?.lastRecap?.affirmed).not.toBe(true);
  });

  it('确认词与纠错混排（对的，但是电话错了）不判确认，停在 confirm_collection', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '对的，但是电话错了' }];
    const result = await execute({ jobId: 100 });
    expect(result.nextAction).toBe('confirm_collection');
  });

  it('候选人纠正复述里的年龄时只重开并改写该槽，其它槽保持 filled', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '年龄不是25，是26' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        {
          labelTitle: '年龄',
          value: '26',
          quote: '年龄不是25，是26',
          operation: 'correct',
        },
      ],
    });
    expect(result.nextAction).toBe('confirm_collection');
    expect(currentForm?.slots[103].value?.value).toBe('26');
    expect(currentForm?.slots[101].value?.value).toBe('兮兮');
    expect(result.recap.candidateMessage).toContain('年龄：26');
  });

  it('同值 correct 是 no-op，不作废 lastRecap 也不重复发送整张复述', async () => {
    currentForm = filledForm();
    context.turnInput.messages = recapDialogue('年龄还是 25');

    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        {
          labelTitle: '年龄',
          value: ' ２５ ',
          quote: '年龄还是 25',
          operation: 'correct',
        },
      ],
    });

    expect(result.nextAction).toBe('confirm_collection');
    expect(currentForm?.slots[103].value?.value).toBe('25');
    expect(currentForm?.lastRecap).toEqual({ labelIds: [101, 102, 103, 104] });
    expect(result.recap.candidateMessage).toBeUndefined();
    expect(result.recap.instruction).toContain('不要重发整张收资表');
  });

  it('clear 经 recap 精确重开一格，其它已填槽不受影响', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '联系电话先清掉，我重新发' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        {
          labelTitle: '联系电话',
          value: null,
          quote: '联系电话先清掉',
          operation: 'clear',
        },
      ],
    });
    expect(result.nextAction).toBe('collect_fields');
    expect(currentForm?.slots[102].state).toBe('empty');
    expect(currentForm?.slots[101].value?.value).toBe('兮兮');
    expect(result.bookingChecklist.requiredFieldsToCollectNow).toEqual(['联系电话']);
  });

  it('契约外 fieldValueProposals 标题不改槽位与清单，并通过既有 collection_form_audit 落审计', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我是社会人士' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '身份', value: '社会人士', quote: '我是社会人士' }],
    });
    expect(result.bookingChecklist.requiredFields).toEqual(['姓名', '联系电话', '年龄', '性别']);
    expect(
      Object.keys(currentForm?.slots ?? {})
        .map(Number)
        .sort(),
    ).toEqual([101, 102, 103, 104]);
    expect(observer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collection_form_audit',
        kind: 'proposal_rejected',
        reason: 'label_title_not_found',
        channel: 'form_answer',
      }),
    );
  });

  it('disqualified：契约 rejectedOption 生产接线到中性拒绝话术', async () => {
    const studentField = {
      labelId: 105,
      labelTitle: '是否学生',
      fieldType: 'SINGLE_OPTION' as const,
      required: true,
      acceptedOptions: [{ optionCode: 'SOCIAL', optionLabel: '社会人士' }],
      rejectedOptions: [{ optionCode: 'STUDENT', optionLabel: '学生' }],
      disclosure: 'RESTRICTED' as const,
    };
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: [studentField] });
    context.turnInput.messages = [{ role: 'user', content: '我是学生' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '是否学生', value: '学生', quote: '我是学生' }],
    });
    expect(result.collectionVerdict).toBe('disqualified');
    expect(result.nextAction).toBe('screening_rejected');
    expect(result.rejection.forbiddenActions.join(' ')).toContain('绝不披露真实不合格原因');
  });

  it('空契约视为数据异常并接线到 escalated/handoff', async () => {
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: [] });
    const result = await execute({ jobId: 100 });
    expect(result.collectionVerdict).toBe('escalated');
    expect(result.nextAction).toBe('handoff');
  });

  it('submitted：已有 workOrderId 时停止重复办理', async () => {
    currentForm = markSubmitted(filledForm(), 9001);
    const result = await execute({ jobId: 100 });
    expect(result.collectionVerdict).toBe('submitted');
    expect(result.nextAction).toBe('already_submitted');
  });

  it('误投 fieldValueProposals 的「面试时间」条目转运为 requestedDate 参加可约性校验', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    context.turnInput.messages = [{ role: 'user', content: '我明天有空' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '面试时间', value: '明天', quote: '我明天有空' }],
    });
    expect(result.success).toBe(true);
    expect(result.interview.requestedDate).toEqual(
      expect.objectContaining({ value: getTomorrowDate(), status: 'available' }),
    );
    // 转运成功的条目不算定位失败，也不再进收资核落定位失败审计。
    expect(result.unmatchedAnswers).toBeUndefined();
    expect(observer.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'proposal_rejected', reason: 'label_title_not_found' }),
    );
  });

  it('「面试时间」值解析失败不升级为日期报错，走 unmatchedAnswers 反馈', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    context.turnInput.messages = [{ role: 'user', content: '过几天再说吧' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [{ labelTitle: '面试时间', value: '过几天', quote: '过几天再说吧' }],
    });
    expect(result.success).toBe(true);
    expect(result.errorType).toBeUndefined();
    expect(result.interview.requestedDate).toBeUndefined();
    expect(result.unmatchedAnswers).toEqual([
      { labelTitle: '面试时间', hint: expect.stringContaining('requestedDate') },
    ]);
  });

  it('显式 requestedDate 参数优先，误投条目只走 unmatchedAnswers', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    context.turnInput.messages = [{ role: 'user', content: '明天或者后天都行' }];
    const result = await execute({
      jobId: 100,
      requestedDate: '明天',
      fieldValueProposals: [{ labelTitle: '面试日期', value: '后天', quote: '后天都行' }],
    });
    expect(result.success).toBe(true);
    expect(result.interview.requestedDate.value).toBe(getTomorrowDate());
    expect(result.unmatchedAnswers).toEqual([
      { labelTitle: '面试日期', hint: expect.stringContaining('requestedDate 参数为准') },
    ]);
  });

  it('unmatchedAnswers 覆盖定位失败与主干撞车弃权，契约内标题正常入槽不受影响', async () => {
    const trunkCollisionContract = [
      ...CONTRACT,
      {
        labelId: 105,
        labelTitle: '体重（kg）',
        fieldType: 'TEXT' as const,
        required: true,
        acceptedOptions: [],
        rejectedOptions: [],
      },
      {
        labelId: 106,
        labelTitle: '体重（斤）',
        fieldType: 'TEXT' as const,
        required: true,
        acceptedOptions: [],
        rejectedOptions: [],
      },
    ];
    sponge.fetchJobCollectionContract.mockResolvedValue({
      jobId: 100,
      fields: trunkCollisionContract,
    });
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮，有健康证' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        { labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' },
        { labelTitle: '健康证', value: '有', quote: '有健康证' },
        { labelTitle: '体重', value: '60', quote: '体重60' },
      ],
    });
    expect(result.unmatchedAnswers).toEqual([
      { labelTitle: '健康证', hint: expect.stringContaining('不在本岗契约') },
      { labelTitle: '体重', hint: expect.stringContaining('命中多个字段') },
    ]);
    expect(currentForm?.slots[101].value?.value).toBe('兮兮');
  });

  it('动态标签全部命中契约时不产生 unmatchedAnswers，路径与改造前一致', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮，电话18271421690' }];
    const result = await execute({
      jobId: 100,
      fieldValueProposals: [
        { labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '电话18271421690' },
      ],
    });
    expect(result.unmatchedAnswers).toBeUndefined();
    expect(currentForm?.slots[101].value?.value).toBe('兮兮');
    expect(currentForm?.slots[102].value?.value).toBe('18271421690');
  });

  it('岗位自由文本年龄要求不再作为第二判据源', async () => {
    currentForm = filledForm();
    context.turnInput.messages = recapDialogue('确认');
    const result = await execute(recapConfirmationInput());
    expect(JOB.hiringRequirement.basicPersonalRequirements.maxAge).toBe(20);
    expect(currentForm?.slots[103].value?.value).toBe('25');
    expect(result.nextAction).toBe('ready_to_book');
  });

  describe('同日多窗口岗位的窗口内时刻映射（badcase chat 6a9679e2ce406a6aee6ef96b）', () => {
    const tomorrow = getTomorrowDate();

    // 全部候选人自答（无外部预填）：不触发 recap，聚焦时间闸门。
    function authorizedForm(): BookingCollectionForm {
      const form = filledForm();
      for (const slot of Object.values(form.slots)) {
        if (slot.value) slot.value = { ...slot.value, producer: 'candidate_quote' };
      }
      return form;
    }

    beforeEach(() => {
      sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_TWO_WINDOWS] });
    });

    it('requestedDate 带窗口内时刻时映射到所在窗口，放行 ready_to_book', async () => {
      currentForm = authorizedForm();
      context.turnInput.messages = [{ role: 'user', content: '明天下午三点也可以' }];
      const result = await execute({ jobId: 100, requestedDate: `${tomorrow} 15:00:00` });
      expect(result.nextAction).toBe('ready_to_book');
      expect(currentForm?.scheduleDraft).toEqual(
        expect.objectContaining({
          requestedDate: tomorrow,
          selectedInterviewTime: `${tomorrow} 13:00:00`,
        }),
      );
      expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
    });

    it('不带秒的窗口内时刻同样命中', async () => {
      currentForm = authorizedForm();
      context.turnInput.messages = [{ role: 'user', content: '明天上午十点半' }];
      const result = await execute({ jobId: 100, requestedDate: `${tomorrow} 10:30` });
      expect(result.nextAction).toBe('ready_to_book');
      expect(currentForm?.scheduleDraft?.selectedInterviewTime).toBe(`${tomorrow} 10:00:00`);
    });

    it('窗口外时刻不映射，维持 select_interview_time', async () => {
      currentForm = authorizedForm();
      context.turnInput.messages = [{ role: 'user', content: '明天中午12点行吗' }];
      const result = await execute({ jobId: 100, requestedDate: `${tomorrow} 12:00:00` });
      expect(result.nextAction).toBe('select_interview_time');
      expect(currentForm?.scheduleDraft?.selectedInterviewTime).toBeUndefined();
    });

    it('只给日期时多窗口不自动落时间（既有行为不回归）', async () => {
      currentForm = authorizedForm();
      context.turnInput.messages = [{ role: 'user', content: '明天可以' }];
      const result = await execute({ jobId: 100, requestedDate: tomorrow });
      expect(result.nextAction).toBe('select_interview_time');
      expect(currentForm?.scheduleDraft?.selectedInterviewTime).toBeUndefined();
    });
  });
});

describe('窗口制岗位可约时刻口径（badcase 8x91d33j / kx7173ak）', () => {
  it('可约窗口 slot 带 interviewTimeFlexible 与窗口内任意时刻提示', () => {
    const slots = buildBookableSlots({
      windows: [{ weekday: '每周一', startTime: '13:30', endTime: '16:30' } as never],
      horizonDays: 7,
    });
    const bookable = slots.find((s) => s.bookingAllowed);
    expect(bookable?.interviewTimeFlexible).toBe(true);
    expect(bookable?.interviewTimeHint).toContain('窗口内任意时刻都可预约');
    expect(bookable?.interviewTimeHint).toContain('不要改写成窗口起点');
    // 默认提交时刻仍是窗口起点（候选人没说时刻时用）
    expect(bookable?.interviewTime).toContain('13:30:00');
  });

  it('只标日期的窗口不给灵活提示（bookingAllowed=false）', () => {
    const slots = buildBookableSlots({
      windows: [{ weekday: '每周二' } as never],
      horizonDays: 7,
    });
    expect(slots.every((s) => s.interviewTimeFlexible === undefined)).toBe(true);
  });
});
