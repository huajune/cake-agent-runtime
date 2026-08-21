import { createForm, markSubmitted, type BookingCollectionForm } from '@resolution/collection';
import type { ToolBuildContext } from '@shared-types/tool.types';
import { buildInterviewPrecheckTool } from '@tools/duliday-interview-precheck.tool';
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
    rebindToPhone: jest.fn(async (_scope, form, phone) => ({ ...form, candidateRef: phone })),
  };
  const sponge = {
    fetchJobs: jest.fn(),
    fetchJobCollectionContract: jest.fn(),
  };
  const ops = { recordEvent: jest.fn().mockResolvedValue(true) };

  beforeEach(() => {
    jest.clearAllMocks();
    currentForm = null;
    context = createToolContext({
      session: { corpId: 'corp-1', userId: 'user-1', sessionId: 'session-1' },
      turnInput: { messages: [] },
    });
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB] });
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: CONTRACT });
  });

  async function execute(input: Record<string, unknown>) {
    const built = buildInterviewPrecheckTool(sponge as never, ops as never, {
      collectionForms: collectionForms as never,
    })(context);
    return built.execute!(input as never, {
      toolCallId: 'precheck-test',
      context: {},
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<Record<string, any>>;
  }

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
      candidateClaims: [{ field: 'name', value: '兮兮', quote: '我叫兮兮' }],
    });
    expect(result.collectionVerdict).toBe('collecting');
    expect(result.nextAction).toBe('collect_fields');
    expect(result.bookingChecklist.requiredFieldsToCollectNow).toEqual([
      '联系电话',
      '年龄',
      '性别',
    ]);
    expect(result.bookingChecklist.requiredFieldsToCollectNow).not.toContain('姓名');
  });

  it('ready：资料齐后先返回一次提交前复述，不直接 booking', async () => {
    context.turnInput.messages = [
      { role: 'user', content: '我叫兮兮，电话18271421690，我今年25岁，我是女的' },
    ];
    const result = await execute({
      jobId: 100,
      candidateClaims: [
        { field: 'name', value: '兮兮', quote: '我叫兮兮' },
        { field: 'phone', value: '18271421690', quote: '电话18271421690' },
        { field: 'age', value: '25', quote: '我今年25岁' },
        { field: 'gender', value: '女', quote: '我是女的' },
      ],
    });
    expect(result.collectionVerdict).toBe('ready');
    expect(result.nextAction).toBe('confirm_collection');
    expect(result.recap.candidateMessage).toContain('姓名：兮兮');
    expect(result.recap.candidateMessage).toContain('联系电话：18271421690');
    expect(currentForm?.lastRecap?.labelIds).toEqual([101, 102, 103, 104]);
  });

  it('候选人明确确认复述后，本轮写入 booking 的短期放行凭据', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '确认' }];
    const result = await execute({ jobId: 100 });
    expect(result.nextAction).toBe('ready_to_book');
    expect(context.ledger.jobs.collectionReadyJobId).toBe(100);
  });

  it('候选人纠正复述里的年龄时只重开并改写该槽，其它槽保持 filled', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '年龄不是25，是26' }];
    const result = await execute({
      jobId: 100,
      candidateClaims: [
        { field: 'age', value: '26', quote: '年龄不是25，是26', operation: 'correct' },
      ],
    });
    expect(result.nextAction).toBe('confirm_collection');
    expect(currentForm?.slots[103].value?.value).toBe('26');
    expect(currentForm?.slots[101].value?.value).toBe('兮兮');
    expect(result.recap.candidateMessage).toContain('年龄：26');
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
      candidateClaims: [{ field: 'isStudent', value: '学生', quote: '我是学生' }],
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

  it('岗位自由文本年龄要求不再作为第二判据源', async () => {
    currentForm = filledForm();
    context.turnInput.messages = [{ role: 'user', content: '确认' }];
    const result = await execute({ jobId: 100 });
    expect(JOB.hiringRequirement.basicPersonalRequirements.maxAge).toBe(20);
    expect(currentForm?.slots[103].value?.value).toBe('25');
    expect(result.nextAction).toBe('ready_to_book');
  });
});
