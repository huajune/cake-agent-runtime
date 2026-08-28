import { getTomorrowDate } from '@infra/utils/date.util';
import { createForm, markSubmitted, type BookingCollectionForm } from '@resolution/collection';
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

function filledForm(contract = CONTRACT): BookingCollectionForm {
  const form = createForm({ jobId: 100, contract });
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
        producer: 'candidate_quote',
        confidence: 'high',
      },
    };
  }
  form.lastRecap = { labelIds: contract.map((field) => field.labelId) };
  return form;
}

describe('duliday_interview_precheck（collection form 唯一路径）', () => {
  let currentForm: BookingCollectionForm | null;
  let context: ToolBuildContext;
  const collectionForms = {
    loadOrCreate: jest.fn(async (_scope, contract) => {
      currentForm ??= createForm({ jobId: 100, contract });
      return currentForm;
    }),
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
    return built.execute!(input as never, {
      toolCallId: 'precheck-test',
      context: {},
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<Record<string, any>>;
  }

  it('公开工具 Schema 只保留 formAnswers 一个收资入口，且 description 共用照发指令', () => {
    expect(Object.keys(PRECHECK_INPUT_SCHEMA.shape)).toEqual([
      'jobId',
      'requestedDate',
      'formAnswers',
    ]);
    expect(PRECHECK_DESCRIPTION).not.toContain('candidateClaims');
    expect(PRECHECK_DESCRIPTION).toContain(COLLECTION_TEMPLATE_SEND_INSTRUCTION);
    expect(
      PRECHECK_INPUT_SCHEMA.safeParse({
        jobId: 100,
        formAnswers: [{ labelTitle: '年龄', value: false, quote: '不是学生' }],
      }).success,
    ).toBe(false);
  });

  it('无答案时字段全集、展示顺序和模板全部只来自实时岗位契约', async () => {
    const result = await execute({ jobId: 100 });
    expect(result.bookingChecklist.requiredFields).toEqual(['姓名', '联系电话', '年龄', '性别']);
    for (const title of result.bookingChecklist.requiredFields) {
      expect(result.bookingChecklist.templateText).toContain(`${title}：`);
    }
    expect(result._replyInstruction).toContain(COLLECTION_TEMPLATE_SEND_INSTRUCTION);
  });

  it('拒绝无法解析的 requestedDate，且不触碰外部接口', async () => {
    const result = await execute({ jobId: 100, requestedDate: 'next week' });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_INVALID_REQUESTED_DATE);
    expect(sponge.fetchJobs).not.toHaveBeenCalled();
  });

  it('jobId 不在会话召回集时先于 Sponge 拦截', async () => {
    context = mergeToolContext(context, {
      archive: { recalledJobIds: [200], isRecalledJobId: (jobId) => jobId === 200 },
    });
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_PROVIDED);
    expect(sponge.fetchJobs).not.toHaveBeenCalled();
  });

  it('collecting：只返回当前 empty 槽，filled 槽不会复问', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我叫兮兮' }];
    const result = await execute({
      jobId: 100,
      formAnswers: [{ labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' }],
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

  it('ready：资料齐后先返回一次提交前复述，不直接 booking', async () => {
    context.turnInput.messages = [
      { role: 'user', content: '我叫兮兮，电话18271421690，我今年25岁，我是女的' },
    ];
    const result = await execute({
      jobId: 100,
      formAnswers: [
        { labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '电话18271421690' },
        { labelTitle: '年龄', value: '25', quote: '我今年25岁' },
        { labelTitle: '性别', value: '女', quote: '我是女的' },
      ],
    });
    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('confirm_collection');
    expect(result.recap.candidateMessage).toContain('姓名：兮兮');
    expect(result.recap.candidateMessage).toContain('联系电话：18271421690');
    expect(currentForm?.lastRecap?.labelIds).toEqual([101, 102, 103, 104]);
  });

  // 生产原型 chat 6a901168ce406a6aeeeee205：候选人照模板逐行填满整表，却被要求核对两遍。
  it('自填模板直通：候选人一条消息填满整表 → 直接 ready_to_book，不发复述轮', async () => {
    const filledTemplate = [
      '姓名：兮兮',
      '联系电话：18271421690',
      '年龄：25',
      '性别：女',
    ].join('\n');
    context.turnInput.messages = [{ role: 'user', content: filledTemplate }];

    const result = await execute({
      jobId: 100,
      formAnswers: [
        { labelTitle: '姓名', value: '兮兮', quote: '姓名：兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '联系电话：18271421690' },
        { labelTitle: '年龄', value: '25', quote: '年龄：25' },
        { labelTitle: '性别', value: '女', quote: '性别：女' },
      ],
    });

    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('ready_to_book');
    expect(result.recap).toBeUndefined();
    // 提交闸门要的确认回执已落账（booking 入口闸查 lastRecap），来源标为自填。
    expect(currentForm?.lastRecap).toEqual({
      labelIds: [101, 102, 103, 104],
      affirmed: true,
      source: 'self_filled',
    });
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  // 生产事故复刻：模型在资料到达那轮漏调 precheck、自产了一份野生复述讨确认，直到候选人
  // 回「对」才首次提交 formAnswers。直通判据认的是**证据**（哪条消息里填满了表）而不是
  // **时序**（哪一轮提交的），所以模型晚一轮也不再多讨一次确认。
  it('模型迟一轮提交时，早前那条自填模板仍然构成核对 → 直接 ready_to_book', async () => {
    context.turnInput.messages = [
      { role: 'assistant', content: '你先把资料发我，我帮你约：\n姓名：\n联系电话：\n年龄：\n性别：' },
      {
        role: 'user',
        content: ['姓名：兮兮', '联系电话：18271421690', '年龄：25', '性别：女'].join('\n'),
      },
      { role: 'assistant', content: '收到你的资料啦，我先核对一下' },
      { role: 'user', content: '对' },
    ];

    const result = await execute({
      jobId: 100,
      formAnswers: [
        { labelTitle: '姓名', value: '兮兮', quote: '姓名：兮兮' },
        { labelTitle: '联系电话', value: '18271421690', quote: '联系电话：18271421690' },
        { labelTitle: '年龄', value: '25', quote: '年龄：25' },
        { labelTitle: '性别', value: '女', quote: '性别：女' },
      ],
    });

    expect(result.nextAction).toBe('ready_to_book');
    expect(result.recap).toBeUndefined();
    expect(currentForm?.lastRecap?.source).toBe('self_filled');
  });

  it('ask_limit_exhausted 后候选人补齐对应字段，解除 handoff 并恢复复述确认', async () => {
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
      formAnswers: [{ labelTitle: '专业', value: '无', quote: '专业：无' }],
    });

    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('confirm_collection');
    expect(currentForm?.slots[213].state).toBe('filled');
    expect(currentForm?.slots[213].askCount).toBe(2);
    expect(currentForm?.escalatedReason).toBeUndefined();
    expect(result.recap.candidateMessage).toContain('专业：无');
  });

  it('候选人明确确认复述后，本轮写入 booking 的短期放行凭据', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '确认' }];
    const result = await execute({ jobId: 100 });
    expect(result.nextAction).toBe('ready_to_book');
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('组合式确认（对的，没问题）同样写入放行凭据，不再多绕一轮', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '对的，没问题' }];
    const result = await execute({ jobId: 100 });
    expect(result.nextAction).toBe('ready_to_book');
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('先确认复述、下一轮再选面试日期时仍放行 booking', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '没问题' }];
    const confirmed = await execute({ jobId: 100 });
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
      formAnswers: [
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

  it('clear 经 recap 精确重开一格，其它已填槽不受影响', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '联系电话先清掉，我重新发' }];
    const result = await execute({
      jobId: 100,
      formAnswers: [
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

  it('契约外 formAnswers 标题不改槽位与清单，并通过既有 collection_form_audit 落审计', async () => {
    context.turnInput.messages = [{ role: 'user', content: '我是社会人士' }];
    const result = await execute({
      jobId: 100,
      formAnswers: [{ labelTitle: '身份', value: '社会人士', quote: '我是社会人士' }],
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
      formAnswers: [{ labelTitle: '是否学生', value: '学生', quote: '我是学生' }],
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

  it('误投 formAnswers 的「面试时间」条目转运为 requestedDate 参加可约性校验', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    context.turnInput.messages = [{ role: 'user', content: '我明天有空' }];
    const result = await execute({
      jobId: 100,
      formAnswers: [{ labelTitle: '面试时间', value: '明天', quote: '我明天有空' }],
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
      formAnswers: [{ labelTitle: '面试时间', value: '过几天', quote: '过几天再说吧' }],
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
      formAnswers: [{ labelTitle: '面试日期', value: '后天', quote: '后天都行' }],
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
      formAnswers: [
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
      formAnswers: [
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
    context.turnInput.messages = [{ role: 'user', content: '确认' }];
    const result = await execute({ jobId: 100 });
    expect(JOB.hiringRequirement.basicPersonalRequirements.maxAge).toBe(20);
    expect(currentForm?.slots[103].value?.value).toBe('25');
    expect(result.nextAction).toBe('ready_to_book');
  });
});
