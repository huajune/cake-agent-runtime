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
import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import type { PostBookingGroupInviteOutcome } from '@tools/invite/post-booking-group-invite';
import { STALE_INPUT_REASON_CODE, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext } from '../../helpers/tool-context.fixture';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { detectBookingReceiptMismatch } from '@agent/guardrail/output/rules/booking-receipt.rule';

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
      firstInterviewWay: '线下面试',
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
  form.contractSnapshot = { fields: [...contract] };
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
    fetchSignupWorkOrders: jest.fn(),
  };
  const bookingSnapshot = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const phoneSessionIndex = { record: jest.fn().mockResolvedValue(undefined) };
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
    sponge.fetchSignupWorkOrders.mockResolvedValue({ workOrders: [] });
    bookingSnapshot.invalidate.mockResolvedValue(undefined);
    phoneSessionIndex.record.mockResolvedValue(undefined);
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

  function buildTool() {
    return buildInterviewBookingTool(
      sponge as never,
      notifier as never,
      hosting as never,
      longTerm as never,
      ops as never,
      {
        collectionForms: collectionForms as never,
        sessionFacts: sessionFacts as never,
        bookingSnapshot: bookingSnapshot as never,
        phoneSessionIndex: phoneSessionIndex as never,
      },
    )(context);
  }

  async function execute(input: Record<string, unknown>) {
    const built = buildTool();
    return built.execute!(input as never, {
      toolCallId: 'booking-test',
      context: {},
      messages: [],
      abortSignal: undefined as never,
    }) as Promise<Record<string, unknown>>;
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

  it('没有持久契约快照时拒绝 booking，不能临时拿实时契约提交', async () => {
    delete currentForm.contractSnapshot;

    const result = await execute({ jobId: 100 });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(result._outcome).toContain('尚未查询');
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('实时契约不同于持久快照时拒绝 booking', async () => {
    currentForm.contractSnapshot = {
      fields: [{ ...CONTRACT[0], labelTitle: '旧版姓名' }, ...CONTRACT.slice(1)],
    };

    const result = await execute({ jobId: 100 });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(result._outcome).toContain('契约已变化');
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('只向 entryUser 发送 jobId + labelList，wait_notice 不带 interviewTime', async () => {
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(true);
    expect(result._confirmedInterviewTimeHuman).toBeUndefined();
    expect(result._waitNoticeReplyGuide).toContain('面试官会电话联系');
    expect(
      detectBookingReceiptMismatch('报名成功啦，面试官会电话联系你，保持电话畅通哈', [
        { toolName: 'duliday_interview_booking', status: 'ok', result } as never,
      ]),
    ).toBeNull();
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

  it('真实 SDK 后续模型消息隐藏后台工单号，运行时结果与报名指针仍保留', async () => {
    sponge.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      workOrderId: 468104,
      traceId: 'trace-runtime-only',
      notice: 'manager-runtime-only',
      applyErrorList: null,
    });
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'book-1',
              toolName: 'duliday_interview_booking',
              input: '{"jobId":100}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: '报名成功，请保持电话畅通' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        },
      ],
    });
    const result = await generateText({
      model,
      prompt: '确认报名',
      tools: { duliday_interview_booking: buildTool() },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    const visible = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(visible).toContain('面试官会电话联系');
    expect(visible).not.toMatch(
      /468104|workOrderId|trace-runtime-only|manager-runtime-only|labelIds|collectionConfigDebts/,
    );
    expect(JSON.stringify(result.response.messages)).not.toContain('468104');
    expect(result.steps[0].toolResults[0].output).toMatchObject({
      workOrderId: 468104,
      traceId: 'trace-runtime-only',
    });
    expect(currentForm.workOrderId).toBe(468104);
    expect(longTerm.setActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1', 468104, {
      job_id: 100,
      interview_time: null,
    });
    expect(sponge.bookInterview).toHaveBeenCalledTimes(1);
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
      undefined,
      { locatorMode: 'active' },
    );
    expect(collectionForms.persist).toHaveBeenLastCalledWith(
      expect.objectContaining({ botUserId: 'wecom-user-A', jobId: 100 }),
      expect.objectContaining({ workOrderId: 9001 }),
    );
    expect(verdictOf(currentForm)).toBe('submitted');
    expect(currentForm.workOrderId).toBe(9001);
    expect(longTerm.setActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1', 9001, {
      job_id: 100,
      interview_time: null,
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
    expect(result.existingWorkOrderId).toBe(8001);
    expect(result._existingInterviewTimeHuman).toBeUndefined();
    // 查重 ≠ 失败：指令必须说"已约上"，并明令禁止系统故障/稍后重提口径
    //（生产 batch …_1789111221226 把它改写成"系统有点问题，稍后再帮你提交"）。
    expect(result._replyInstruction).toContain('已经约上');
    expect(result._replyInstruction).toContain('禁止说"系统有问题/没提交成功/稍后再帮你提交"');
    expect(result._replyInstruction).toContain('不要编造时间');
  });

  it('本轮预约快照里同品牌在途工单（含带外）→ already_booked，不再查跨账号', async () => {
    context.archive.bookingWorkOrders = [
      {
        workOrderId: 9001,
        jobId: 900,
        source: 'out_of_band',
        signupSource: 'SUPPLIER',
        ownedByCandidate: true,
        brandName: JOB.basicInfo.brandName,
        interviewTime: '2026-09-14 13:30',
      },
    ];
    context.ledger.recordFetchedJobs([
      { jobId: 100, brandName: JOB.basicInfo.brandName, jobName: '服务员' } as never,
    ]);
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result.existingWorkOrderId).toBe(9001);
    expect(result.matchedBy).toBe('brand');
    expect(result.crossAccount).toBe(false);
    expect(result._replyInstruction).toContain('同品牌');
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('快照与指针都没命中时再查 onlyCurrentAccount=false：别的账号同岗位在途 → 如实告知并转 duplicate_signup', async () => {
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      workOrders: [
        {
          workOrderId: 9002,
          jobId: 100,
          currentStatus: '约面成功',
          signUpTime: new Date().toISOString().replace('T', ' ').slice(0, 19),
          interviewTime: '2026-09-14 13:30',
        },
      ],
    });
    const result = await execute({ jobId: 100 });
    expect(sponge.fetchSignupWorkOrders).toHaveBeenCalledWith(
      expect.objectContaining({ onlyCurrentAccount: false, phone: expect.any(String) }),
      expect.objectContaining({ botImId: 'bot-A' }),
      { timeoutMs: 3000, allowDefaultToken: false },
    );
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result.existingWorkOrderId).toBe(9002);
    expect(result.crossAccount).toBe(true);
    expect(result._replyInstruction).toContain('你之前已经报过这个岗位/品牌');
    expect(result._replyInstruction).toContain('reasonCode="duplicate_signup"');
    expect(sponge.bookInterview).not.toHaveBeenCalled();
  });

  it('测试链路用统一假身份报名成功：快照照常失效，但不写手机号→会话索引', async () => {
    context.runtime.strategySource = 'testing';
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(true);
    expect(bookingSnapshot.invalidate).toHaveBeenCalledTimes(1);
    expect(phoneSessionIndex.record).not.toHaveBeenCalled();
  });

  it('报名成功后失效该手机号的预约快照缓存并写手机号→会话索引', async () => {
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(true);
    expect(bookingSnapshot.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ botImId: 'bot-A', corpId: 'corp-1', userId: 'user-1' }),
    );
    expect(phoneSessionIndex.record).toHaveBeenCalledWith(expect.any(String), {
      corpId: 'corp-1',
      userId: 'user-1',
      chatId: 'session-1',
      botImId: 'bot-A',
    });
  });

  it('在途工单记录了面试时间时，查重回执带人类可读时间供回复播报', async () => {
    longTerm.getActiveBookings.mockResolvedValue([
      {
        work_order_id: 8002,
        job_id: 100,
        linked_at: new Date().toISOString(),
        interview_time: '2026-09-14 13:30:00',
      },
    ]);
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result.existingWorkOrderId).toBe(8002);
    expect(result.existingInterviewTime).toBe('2026-09-14 13:30:00');
    expect(result._existingInterviewTimeHuman).toBe('9月14日（周一）13:30');
    expect(result._replyInstruction).toContain('9月14日（周一）13:30');
  });

  /**
   * 生产 batch …_1790057431146（2026-09-22）：attempt 1 booking 成功建单 467600 后 provider
   * 超时，executor 重试重放 booking；表单已 markSubmitted，旧实现按"状态=submitted"拒绝，
   * 回复被守卫改成"没提交成功"、invite 因 bookingSucceeded=false 跳过拉群。
   */
  it('本轮已成功建单后再次调用 → already_booked 幂等回执，不按 submitted 拒绝', async () => {
    currentForm = {
      ...readyForm(),
      workOrderId: 467600,
      scheduleDraft: { selectedInterviewTime: '2026-09-23 10:30:00', sourceText: '明天十点半' },
    };
    context.ledger.jobs.bookingSucceeded = true;
    const result = await execute({ jobId: 100, interviewTime: '2026-09-23 10:30:00' });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result.existingWorkOrderId).toBe(467600);
    expect(result.alreadyBookedSource).toBe('same_turn_submitted_form');
    expect(result.existingInterviewTime).toBe('2026-09-23 10:30:00');
    expect(result._existingInterviewTimeHuman).toBe('9月23日（周三）10:30');
    expect(result._replyInstruction).toContain('本轮已经成功提交过');
    expect(result._replyInstruction).toContain('禁止说"系统有问题/没提交成功/稍后再帮你提交"');
    expect(sponge.fetchJobs).not.toHaveBeenCalled();
    expect(sponge.bookInterview).not.toHaveBeenCalled();
    expect(collectionForms.persist).not.toHaveBeenCalled();
    // 账本维持成功：invite_to_group 只在 bookingSucceeded===false 时跳过拉群
    expect(context.ledger.jobs.bookingSucceeded).toBe(true);
  });

  it('表单 submitted 但本轮账本无成功记录时仍拒绝，旧工单不冒充本轮成功', async () => {
    currentForm = { ...readyForm(), workOrderId: 467600 };
    const result = await execute({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(result._outcome).toContain('submitted');
    expect(sponge.bookInterview).not.toHaveBeenCalled();
    expect(context.ledger.jobs.bookingSucceeded).toBe(false);
  });

  it('成功但缺 workOrderId 时表单转人工，阻止重复提交', async () => {
    sponge.bookInterview.mockResolvedValue({ success: true, code: 0, message: '成功' });
    const result = await execute({ jobId: 100 });
    expect(result.success).toBe(true);
    expect(verdictOf(currentForm)).toBe('escalated');
    expect(currentForm.escalatedReason).toBe('booking_success_missing_work_order_id');
  });

  describe('回执到店形态只看海绵四值面试方式', () => {
    async function bookWithMethod(firstInterviewWay: string | undefined) {
      sponge.fetchJobs.mockResolvedValue({
        jobs: [
          {
            ...JOB_WITH_WINDOWS,
            interviewProcess: {
              firstInterview: {
                ...JOB_WITH_WINDOWS.interviewProcess.firstInterview,
                firstInterviewWay,
              },
            },
          },
        ],
      });
      const interviewTime = `${getTomorrowDate()} 10:00:00`;
      currentForm.scheduleDraft = {
        requestedDate: getTomorrowDate(),
        selectedInterviewTime: interviewTime,
        sourceText: '我明天10点可以',
      };
      return execute({ jobId: 100, interviewTime });
    }

    it('线下面试附到店脚本', async () => {
      const result = await bookWithMethod('线下面试');
      expect(result.success).toBe(true);
      expect(result._onSiteScript).toContain('独立客招聘介绍来的');
      expect(result._onlineInterviewGuide).toBeUndefined();
    });

    it.each(['AI面试', '电话面试', '视频面试'])(
      '%s 附线上提醒、不附到店脚本（生产 batch …_1789456933610：AI 面试却发到店脚本）',
      async (method) => {
        const result = await bookWithMethod(method);
        expect(result.success).toBe(true);
        expect(result._onSiteScript).toBeUndefined();
        expect(result._onlineInterviewGuide).toContain('不需要到店');
      },
    );

    it('面试方式缺失时既不附到店脚本也不附线上提醒', async () => {
      const result = await bookWithMethod(undefined);
      expect(result.success).toBe(true);
      expect(result._onSiteScript).toBeUndefined();
      expect(result._onlineInterviewGuide).toBeUndefined();
    });
  });

  // PRD R3：报名成功后拉群改为程序保证——首次报名成功、私聊、城市可知时由运行时直接拉群，
  // 结果进回执，模型只按结果说话；任何失败都不影响报名成功回执。
  describe('报名成功后运行时拉群', () => {
    interface BookingResultWithInvite {
      success: boolean;
      errorType?: string;
      _outcome: string;
      _replyInstruction: string;
      _groupInviteGuide: string;
      groupInvite: PostBookingGroupInviteOutcome;
    }
    const groupInvite = {
      preflightExistingMembership: jest.fn(),
      invite: jest.fn(),
    };
    const sessionFactsWithCity = {
      ...sessionFacts,
      getSessionState: jest.fn().mockResolvedValue({ invitedGroups: [] }),
      getFacts: jest.fn().mockResolvedValue({
        preferences: {
          city: { value: '上海', confidence: 'high', source: 'candidate_quote', evidence: '原文' },
        },
      }),
    };

    beforeEach(() => {
      groupInvite.preflightExistingMembership.mockResolvedValue(null);
      groupInvite.invite.mockResolvedValue({
        success: true,
        groupName: '上海餐饮群',
        inviteDelivery: 'invite_card',
      });
      context.session.turnId = 'turn-9';
    });

    async function executeWithInvite(input: Record<string, unknown> = { jobId: 100 }) {
      const built = buildInterviewBookingTool(
        sponge as never,
        notifier as never,
        hosting as never,
        longTerm as never,
        ops as never,
        {
          collectionForms: collectionForms as never,
          sessionFacts: sessionFactsWithCity as never,
          groupInvite: groupInvite as never,
        },
      )(context);
      return built.execute!(input as never, {
        toolCallId: 'booking-test',
        context: {},
        messages: [],
        abortSignal: undefined as never,
      }) as Promise<BookingResultWithInvite>;
    }

    it('报名成功后直接拉群：结果进回执、回复指令要求只按结果说话、运营事件带口径', async () => {
      const result = await executeWithInvite();

      expect(result.success).toBe(true);
      expect(groupInvite.invite).toHaveBeenCalledWith(
        expect.objectContaining({ city: '上海', contactWxid: 'user-1', turnKey: 'turn-9' }),
      );
      expect(result.groupInvite).toEqual({
        attempted: true,
        success: true,
        city: '上海',
        groupName: '上海餐饮群',
        delivery: 'invite_card',
      });
      expect(result._groupInviteGuide).toContain('「上海餐饮群」的入群邀请卡片');
      expect(result._replyInstruction).toContain('报名成功');
      expect(result._replyInstruction).toContain('不要再调用 invite_to_group');
      expect(context.ledger.jobs.postBookingGroupInvite).toEqual(result.groupInvite);
      expect(ops.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'booking.succeeded',
          payload: expect.objectContaining({
            turn_id: 'turn-9',
            group_invite: expect.objectContaining({ outcome: 'invited', group_name: '上海餐饮群' }),
          }),
        }),
      );
    });

    it('拉群失败或抛异常不影响报名成功回执', async () => {
      groupInvite.invite.mockRejectedValue(new Error('enterprise api down'));

      const result = await executeWithInvite();

      expect(result.success).toBe(true);
      expect(result.errorType).toBeUndefined();
      expect(result._outcome).toBe('预约成功，可以告知候选人面试安排');
      expect(result.groupInvite).toMatchObject({
        attempted: true,
        success: false,
        failureReason: 'exception',
      });
      expect(result._groupInviteGuide).toContain('不要向候选人提及群相关内容');
      expect(context.ledger.jobs.bookingSucceeded).toBe(true);
      expect(hosting.pauseUser).not.toHaveBeenCalled();
      expect(ops.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'booking.succeeded',
          payload: expect.objectContaining({
            group_invite: expect.objectContaining({ outcome: 'failed:exception' }),
          }),
        }),
      );
    });

    it('群聊里报名成功不拉群并给原因', async () => {
      context.session.imRoomId = 'room-1';
      const result = await executeWithInvite();
      expect(result.success).toBe(true);
      expect(result.groupInvite).toEqual({
        attempted: false,
        success: false,
        skippedReason: 'group_chat',
      });
      expect(groupInvite.invite).not.toHaveBeenCalled();
      delete context.session.imRoomId;
    });

    it('城市未知时不拉群并给原因', async () => {
      sessionFactsWithCity.getFacts.mockResolvedValueOnce(null);
      const result = await executeWithInvite();
      expect(result.success).toBe(true);
      expect(result.groupInvite).toEqual({
        attempted: false,
        success: false,
        skippedReason: 'city_unknown',
      });
      expect(groupInvite.invite).not.toHaveBeenCalled();
      expect(result._groupInviteGuide).toContain('原因: city_unknown');
    });

    it('候选人名下已有其他在途工单：不是首次报名，不拉群', async () => {
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 8001, job_id: 200, linked_at: new Date().toISOString() },
      ]);
      const result = await executeWithInvite();
      expect(result.success).toBe(true);
      expect(result.groupInvite.skippedReason).toBe('not_first_booking');
      expect(groupInvite.invite).not.toHaveBeenCalled();
    });

    it('未注入拉群服务时回执记 service_unavailable（旧装配兼容）', async () => {
      const result = await execute({ jobId: 100 });
      expect(result.success).toBe(true);
      expect(result.groupInvite).toMatchObject({ skippedReason: 'service_unavailable' });
    });
  });
});
