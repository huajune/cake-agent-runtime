import {
  createForm,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';
import { getTomorrowDate } from '@infra/utils/date.util';
import type { ToolBuildContext } from '@shared-types/tool.types';
import type { TurnOutcome } from '@agent/runner/agent-runner.types';
import { resolveReplaySkipDecision } from '@agent/runner/turn-outcome';
import {
  buildInterviewBookingTool,
  resolveInterviewType,
} from '@tools/duliday-interview-booking.tool';
import { STALE_INPUT_REASON_CODE, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext } from '../../helpers/tool-context.fixture';

const CONTRACT: ContractFieldDef[] = [
  {
    labelId: 101,
    labelTitle: '姓名',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'name',
  },
  {
    labelId: 102,
    labelTitle: '联系电话',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'phone',
  },
  {
    labelId: 103,
    labelTitle: '年龄',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'age',
  },
  {
    labelId: 104,
    labelTitle: '性别',
    fieldType: 'SINGLE_OPTION',
    required: true,
    acceptedOptions: [
      { optionCode: 'MALE', optionLabel: '男' },
      { optionCode: 'FEMALE', optionLabel: '女' },
    ],
    rejectedOptions: [],
    systemField: 'gender',
  },
];

const JOB = {
  basicInfo: {
    jobId: 100,
    brandName: '测试品牌',
    jobName: '服务员',
    storeInfo: { storeName: '测试门店' },
  },
  interviewProcess: {
    firstInterview: {
      firstInterviewWay: '电话面试',
      periodicInterviewTimes: [],
      fixedInterviewTimes: [],
    },
  },
};

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

function readyForm(contract: readonly ContractFieldDef[] = CONTRACT): BookingCollectionForm {
  const form = createForm({ jobId: 100, contract });
  const values: Record<number, { value: string; optionCodes?: string[] }> = {
    101: { value: '兮兮' },
    102: { value: '18271421690' },
    103: { value: '25' },
    104: { value: '女', optionCodes: ['FEMALE'] },
    105: { value: 'https://wecom.example.test/resume.pdf' },
  };
  for (const field of contract) {
    const value = values[field.labelId] ?? { value: '已填写' };
    form.slots[field.labelId] = {
      labelId: field.labelId,
      ...(field.systemField ? { systemField: field.systemField } : {}),
      state: 'filled',
      askCount: 1,
      value: {
        ...value,
        sourceText: value.value,
        producer: 'candidate_quote',
      },
    };
  }
  form.lastRecap = { labelIds: contract.map((field) => field.labelId) };
  return form;
}

describe('duliday_interview_booking（form → labelList）', () => {
  let currentForm: BookingCollectionForm;
  let context: ToolBuildContext;
  const sponge = {
    fetchJobCollectionContract: jest.fn(),
    fetchJobs: jest.fn(),
    bookInterview: jest.fn(),
    uploadAttachmentFromUrl: jest.fn(),
  };
  const collectionForms = {
    loadOrCreate: jest.fn(async () => currentForm),
    persist: jest.fn(async (_scope, form) => {
      currentForm = form;
    }),
  };
  const notifier = { notifyInterviewBookingResult: jest.fn().mockResolvedValue(true) };
  const hosting = { pauseUser: jest.fn().mockResolvedValue(undefined) };
  const longTerm = {
    getActiveBookings: jest.fn().mockResolvedValue([]),
    setActiveBooking: jest.fn().mockResolvedValue(undefined),
    writeFromBooking: jest.fn().mockResolvedValue(undefined),
  };
  const sessionFacts = {
    saveCompletedCollectionFacts: jest.fn().mockResolvedValue(undefined),
  };
  const ops = { recordEvent: jest.fn().mockResolvedValue(true) };

  beforeEach(() => {
    jest.clearAllMocks();
    currentForm = readyForm();
    context = createToolContext({
      session: {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        botUserId: 'wecom-user-A',
        botImId: 'bot-A',
        contactName: '测试联系人',
      },
      turnInput: { messages: [{ role: 'user', content: '确认' }] },
    });
    context.ledger.jobs.collectionReadyJobId = 100;
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: CONTRACT });
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB] });
    sponge.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      applyErrorList: null,
      workOrderId: 9001,
    });
    sponge.uploadAttachmentFromUrl.mockResolvedValue({
      fileName: 'resume.pdf',
      cloudStorageKey: 'resume/cloud/key.pdf',
    });
    longTerm.getActiveBookings.mockResolvedValue([]);
  });

  async function execute(input: Record<string, unknown>) {
    const built = buildInterviewBookingTool(
      sponge as never,
      notifier as never,
      hosting as never,
      longTerm as never,
      ops as never,
      { collectionForms: collectionForms as never, sessionFacts: sessionFacts as never },
    )(context);
    return built.execute!(input as never, {
      toolCallId: 'booking-test',
      context: {},
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<Record<string, any>>;
  }

  it('本轮没有 ready_to_book 凭据时，在任何外部请求前拒绝', async () => {
    context.ledger.jobs.collectionReadyJobId = undefined;
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(sponge.fetchJobCollectionContract).not.toHaveBeenCalled();
  });

  it('jobId 无召回出处时恢复防伪短路与专用错误码', async () => {
    context.ledger.jobs.collectionReadyJobId = undefined;
    context.archive.recalledJobIds = [99];
    context.archive.isRecalledJobId = () => false;

    const result = await execute({ jobId: 100 });

    expect(result).toMatchObject({
      errorType: TOOL_ERROR_TYPES.BOOKING_JOB_NOT_PROVIDED,
      shortCircuited: true,
      gateRejected: true,
      reasonCode: 'job_id_not_recalled',
      jobId: 100,
      recalledJobIds: [99],
    });
    expect(context.ledger.jobs.bookingSucceeded).toBe(false);
    expect(sponge.fetchJobCollectionContract).not.toHaveBeenCalled();
  });

  it('只向 entryUser 发送 jobId + labelList，wait_notice 不带 interviewTime', async () => {
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(true);
    const [payload] = sponge.bookInterview.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(['interviewTime', 'jobId', 'labelList']);
    expect(payload.interviewTime).toBeUndefined();
    expect(payload.labelList).toEqual([
      { labelId: 101, value: '兮兮' },
      { labelId: 102, value: '18271421690' },
      { labelId: 103, value: '25' },
      { labelId: 104, options: [{ optionCode: 'FEMALE' }] },
    ]);
    expect(payload).not.toEqual(expect.objectContaining({ name: expect.anything() }));
    expect(payload).not.toEqual(expect.objectContaining({ customerLabelList: expect.anything() }));
  });

  it('普通岗不能用仅有 interviewTime 的输入绕过持久化 schedule draft', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    const interviewTime = `${getTomorrowDate()} 10:00:00`;
    const result = await execute({ jobId: 100, interviewTime });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('普通岗只接受与草稿一致且实时仍可约的精确 interviewTime', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    const interviewTime = `${getTomorrowDate()} 10:00:00`;
    currentForm.scheduleDraft = {
      requestedDate: getTomorrowDate(),
      selectedInterviewTime: interviewTime,
      sourceText: '我明天10点可以',
    };
    const result = await execute({ jobId: 100, interviewTime });
    expect(result.success).toBe(true);
    expect(sponge.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 100, interviewTime }),
      expect.any(Object),
    );
  });

  it('外部预填未确认时，即使时间草稿正确也拒绝旁路提交', async () => {
    sponge.fetchJobs.mockResolvedValue({ jobs: [JOB_WITH_WINDOWS] });
    const interviewTime = `${getTomorrowDate()} 10:00:00`;
    currentForm.slots[101].value!.producer = 'archive';
    currentForm.scheduleDraft = {
      requestedDate: getTomorrowDate(),
      selectedInterviewTime: interviewTime,
      sourceText: '我明天10点可以',
    };
    const result = await execute({ jobId: 100, interviewTime });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('成功后 markSubmitted，active booking 与高置信 booking lineage 同步写入', async () => {
    await execute({ jobId: 100 });
    expect(collectionForms.loadOrCreate).toHaveBeenCalledWith(
      {
        corpId: 'corp-1',
        userId: 'user-1',
        botUserId: 'wecom-user-A',
        sessionId: 'session-1',
        jobId: 100,
      },
      expect.any(Array),
    );
    expect(collectionForms.persist).toHaveBeenLastCalledWith(
      expect.objectContaining({ botUserId: 'wecom-user-A', jobId: 100 }),
      expect.objectContaining({ workOrderId: 9001 }),
    );
    expect(verdictOf(currentForm)).toBe('submitted');
    expect(currentForm.workOrderId).toBe(9001);
    expect(longTerm.setActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1', 9001, {
      job_id: 100,
    });
    expect(sessionFacts.saveCompletedCollectionFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      expect.objectContaining({
        name: expect.objectContaining({ value: '兮兮', confidence: 'high' }),
        phone: expect.objectContaining({ value: '18271421690', confidence: 'high' }),
        gender: expect.objectContaining({ value: '女', confidence: 'high', source: 'system' }),
      }),
    );
    expect(longTerm.writeFromBooking).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'wecom-user-A',
      {
        name: '兮兮',
        phone: '18271421690',
        age: 25,
        gender: '女',
        jobId: 100,
        workOrderId: 9001,
      },
      { sessionId: 'session-1', botImId: 'bot-A' },
    );
  });

  it('追加候选人可独立报名，不受主联系人同岗查重拦截且不覆盖主联系人记忆', async () => {
    currentForm = { ...readyForm(), candidateRef: '18271421691', candidateScope: 'additional' };
    currentForm.slots[101].value = {
      value: '小李',
      sourceText: '姓名：小李',
      producer: 'candidate_quote',
    };
    currentForm.slots[102].value = {
      value: '18271421691',
      sourceText: '联系电话：18271421691',
      producer: 'candidate_quote',
    };
    longTerm.getActiveBookings.mockResolvedValue([
      { work_order_id: 8001, job_id: 100, linked_at: new Date().toISOString() },
    ]);

    const result = await execute({ jobId: 100 });

    expect(result).toMatchObject({ success: true, candidateScope: 'additional' });
    expect(result._replyInstruction).toContain('只有告知成功后才能处理下一位候选人');
    expect(sponge.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        labelList: expect.arrayContaining([
          { labelId: 101, value: '小李' },
          { labelId: 102, value: '18271421691' },
        ]),
      }),
      expect.any(Object),
    );
    expect(longTerm.getActiveBookings).not.toHaveBeenCalled();
    expect(longTerm.setActiveBooking).not.toHaveBeenCalled();
    expect(sessionFacts.saveCompletedCollectionFacts).not.toHaveBeenCalled();
    expect(longTerm.writeFromBooking).not.toHaveBeenCalled();
    expect(collectionForms.persist).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 100 }),
      expect.objectContaining({
        candidateRef: '18271421691',
        candidateScope: 'additional',
        workOrderId: 9001,
      }),
    );
  });

  it('外部工单成功后的表单/记忆写入失败不反向改口为预约失败', async () => {
    longTerm.setActiveBooking.mockRejectedValueOnce(new Error('active booking write failed'));
    collectionForms.persist.mockRejectedValueOnce(new Error('form persist failed'));
    sessionFacts.saveCompletedCollectionFacts.mockRejectedValueOnce(
      new Error('session fact write failed'),
    );
    longTerm.writeFromBooking.mockRejectedValueOnce(new Error('profile write failed'));

    const result = await execute({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.errorType).toBeUndefined();
    expect(context.ledger.jobs.bookingSucceeded).toBe(true);
    expect(hosting.pauseUser).not.toHaveBeenCalled();
    expect(ops.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'booking.succeeded' }),
    );
    expect(ops.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'booking.failed' }),
    );
  });

  it('外部 success=true 是不可回滚提交点，未知回执后处理异常也保持成功口径', async () => {
    ops.recordEvent.mockImplementationOnce(() => {
      throw new Error('unexpected event recorder failure');
    });

    const result = await execute({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.errorType).toBeUndefined();
    expect(result._replyInstruction).toContain('预约已真实成功');
    expect(context.ledger.jobs.bookingSucceeded).toBe(true);
    expect(hosting.pauseUser).not.toHaveBeenCalled();
  });

  it('applyErrorList 带 labelId 时只重开对应槽位', async () => {
    sponge.bookInterview.mockResolvedValue({
      success: false,
      code: 400,
      message: '年龄校验失败',
      applyErrorList: [{ labelId: 103, field: '年龄', msg: '请重新填写' }],
    });
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(false);
    expect(currentForm.slots[103].state).toBe('empty');
    expect(currentForm.slots[101].state).toBe('filled');
    expect(verdictOf(currentForm)).toBe('collecting');
  });

  it('applyErrorList 无法映射时不静默，表单转 escalated', async () => {
    sponge.bookInterview.mockResolvedValue({
      success: false,
      code: 400,
      message: '未知字段失败',
      applyErrorList: [{ field: '不存在的字段', msg: '失败' }],
    });
    await execute({ jobId: 100 });
    expect(verdictOf(currentForm)).toBe('escalated');
    expect(currentForm.escalatedReason).toContain('error_list_unmapped');
  });

  it('FILE 槽先上传，labelList.value 使用 cloudStorageKey', async () => {
    const fileField: ContractFieldDef = {
      labelId: 105,
      labelTitle: '上传简历',
      fieldType: 'FILE',
      required: true,
      acceptedOptions: [],
      rejectedOptions: [],
    };
    const contract = [...CONTRACT, fileField];
    currentForm = readyForm(contract);
    sponge.fetchJobCollectionContract.mockResolvedValue({ jobId: 100, fields: contract });
    await execute({ jobId: 100 });
    expect(sponge.uploadAttachmentFromUrl).toHaveBeenCalledWith(
      { fileUrl: 'https://wecom.example.test/resume.pdf' },
      { botImId: 'bot-A', botUserId: 'wecom-user-A', groupId: undefined },
    );
    expect(sponge.bookInterview.mock.calls[0][0].labelList).toContainEqual({
      labelId: 105,
      value: 'resume/cloud/key.pdf',
    });
  });

  it('选项槽没有 optionCodes 时精确重开，不退回旧枚举映射', async () => {
    currentForm.slots[104].value = {
      value: '女',
      sourceText: '女',
      producer: 'candidate_quote',
    };
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(currentForm.slots[104].state).toBe('empty');
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('测试链路只允许统一假身份，真实 PII 不触发生产写', async () => {
    currentForm.slots[102].value = {
      value: '13912345678',
      sourceText: '13912345678',
      producer: 'candidate_quote',
    };
    context.runtime.strategySource = 'testing';
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.TEST_LINK_REAL_PII_BLOCKED);
    expect(sponge.fetchJobs).not.toHaveBeenCalled();
  });

  it('提交前发现新消息时短路，不创建工单', async () => {
    context.runtime.hasNewerUserInput = jest.fn().mockResolvedValue(true);
    const result = await execute({ jobId: 100 });
    expect(result.shortCircuited).toBe(true);
    expect(result.staleInput).toBe(true);
    expect(result.reasonCode).toBe(STALE_INPUT_REASON_CODE);
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('stale-input 真实返回值必须解锁 turn-outcome 的 replay 旁路（契约配对）', async () => {
    context.runtime.hasNewerUserInput = jest.fn().mockResolvedValue(true);
    const result = await execute({ jobId: 100 });
    // 短路回合的 outcome 是 skipped；若工具返回值与 hasStaleInputAbort 的判定
    // 再次漂移（历史上 PR #1023 丢过 reasonCode），这里会退回 skip:true。
    const decision = resolveReplaySkipDecision({ kind: 'skipped' } as TurnOutcome, [
      { toolName: 'duliday_interview_booking', args: { jobId: 100 }, result },
    ]);
    expect(decision).toEqual({ skip: false, reasons: [], blockingTools: [] });
  });

  it('近期同岗位 active booking 命中软查重', async () => {
    longTerm.getActiveBookings.mockResolvedValue([
      { work_order_id: 8001, job_id: 100, linked_at: new Date().toISOString() },
    ]);
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('成功但缺 workOrderId 时表单转人工，阻止重复提交', async () => {
    sponge.bookInterview.mockResolvedValue({ success: true, code: 0, message: '成功' });
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(true);
    expect(verdictOf(currentForm)).toBe('escalated');
    expect(currentForm.escalatedReason).toBe('booking_success_missing_work_order_id');
  });

  it('resolveInterviewType 只作展示：AI 描述优先，否则取方式', () => {
    expect(
      resolveInterviewType({
        interviewProcess: {
          firstInterview: { firstInterviewWay: '线上面试', firstInterviewDesc: 'AI 视频面试' },
        },
      }),
    ).toBe('AI面试');
    expect(
      resolveInterviewType({
        interviewProcess: { firstInterview: { firstInterviewWay: '线下面试' } },
      }),
    ).toBe('线下面试');
  });
});
