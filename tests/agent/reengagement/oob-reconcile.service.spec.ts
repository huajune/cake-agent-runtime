import { OobReconcileService } from '@agent/reengagement/oob-reconcile.service';
import { parseLocalDateTime } from '@infra/utils/date.util';

const NOW = parseLocalDateTime('2026-09-22 10:00:00')!.getTime();

describe('OobReconcileService', () => {
  const bookingSnapshot = { load: jest.fn() };
  const session = {
    getSessionState: jest.fn(),
    getReengagementState: jest.fn(),
    saveTerminalState: jest.fn(),
  };
  const longTerm = { getProfile: jest.fn() };
  const scheduler = {
    scheduleBookingResolution: jest.fn(),
    scheduleFollowUp: jest.fn(),
    scheduleInterviewSlotCheck: jest.fn(),
  };
  const opsEvents = { recordEvent: jest.fn() };
  const redis = { setNx: jest.fn(), get: jest.fn() };
  const systemConfig = { getAgentReplyConfig: jest.fn() };

  const service = () =>
    new OobReconcileService(
      bookingSnapshot as never,
      session as never,
      longTerm as never,
      scheduler as never,
      opsEvents as never,
      redis as never,
      systemConfig as never,
    );

  const input = {
    corpId: 'corp-1',
    userId: 'user-1',
    chatId: 'chat-1',
    botImId: 'bot-1',
    botUserId: 'wecom-1',
    traceId: 'trace-1',
    channelIdentity: { botImId: 'bot-1', candidateName: '张三' },
    trigger: 'turn' as const,
  };

  const supplierEntry = (over: Record<string, unknown> = {}) => ({
    workOrder: {
      workOrderId: 464227,
      operationLogs: [
        { operationTime: '2026-09-20 10:00:00', operationType: 1, operationName: '创建' },
      ],
    },
    workOrderId: 464227,
    jobId: 529005,
    brandName: '肯德基',
    jobName: '服务员',
    interviewTime: '2026-09-25 14:00',
    signUpTime: '2026-09-20 10:00:00',
    signupSource: 'SUPPLIER',
    candidateName: '张三',
    ownedByCandidate: true,
    ...over,
  });

  const okSnapshot = (entries: unknown[]) => ({
    status: 'ok',
    entries,
    candidateName: '张三',
    fromCache: false,
    fetchedAt: NOW,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    session.getSessionState.mockResolvedValue({
      facts: { interview_info: { name: { value: '张三' }, phone: { value: '18271421690' } } },
    });
    session.getReengagementState.mockResolvedValue({ terminal: undefined });
    session.saveTerminalState.mockResolvedValue(undefined);
    longTerm.getProfile.mockResolvedValue(null);
    scheduler.scheduleBookingResolution.mockResolvedValue({ scheduled: true });
    scheduler.scheduleFollowUp.mockResolvedValue({
      scheduled: false,
      reason: 'missing_interview_time',
    });
    scheduler.scheduleInterviewSlotCheck.mockResolvedValue({ scheduled: true });
    opsEvents.recordEvent.mockResolvedValue(true);
    redis.setNx.mockResolvedValue(true);
    redis.get.mockResolvedValue(null);
    systemConfig.getAgentReplyConfig.mockResolvedValue({ reengagementScenarioDelayMinutes: {} });
    bookingSnapshot.load.mockResolvedValue(okSnapshot([supplierEntry()]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('本人手机号来自会话事实；回合触发不穿透缓存，扫描/恢复穿透', async () => {
    await service().reconcile(input);
    expect(bookingSnapshot.load).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '18271421690',
        botImId: 'bot-1',
        knownCandidateNames: ['张三'],
        bypassCache: false,
      }),
    );
    await service().reconcile({ ...input, trigger: 'scan' });
    expect(bookingSnapshot.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('没有本人手机号或快照不可用时跳过，不排任务不落事件', async () => {
    session.getSessionState.mockResolvedValue({
      facts: { interview_info: { phone: null, name: null } },
    });
    expect(await service().reconcile(input)).toMatchObject({
      status: 'skipped',
      reason: 'no_phone',
    });

    session.getSessionState.mockResolvedValue({
      facts: { interview_info: { name: { value: '张三' }, phone: { value: '18271421690' } } },
    });
    bookingSnapshot.load.mockResolvedValue({ status: 'failed', error: 'timeout' });
    expect(await service().reconcile(input)).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalled();
    expect(opsEvents.recordEvent).not.toHaveBeenCalled();
  });

  it('带外（SUPPLIER）且本人校验通过：置 booked 终态、落 booking.linked_out_of_band、用稳定锚点排提醒与回访', async () => {
    const result = await service().reconcile(input);

    expect(result).toMatchObject({
      status: 'done',
      supplierOwned: 1,
      scheduled: 2,
      linkedEvents: 1,
      terminal: 'booked',
    });
    expect(session.saveTerminalState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1', 'booked');
    expect(opsEvents.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'booking.linked_out_of_band',
        idempotencyKey: '464227:oob_linked',
        botImId: 'bot-1',
        payload: expect.objectContaining({
          source: 'oob',
          signup_source: 'SUPPLIER',
          work_order_id: 464227,
          job_id: 529005,
          operation_logs: [expect.objectContaining({ type: 1, name: '创建' })],
        }),
      }),
    );
    expect(redis.setNx).toHaveBeenCalledWith(
      'oob:anchor:chat-1:reconcile:wo464227:iv2026-09-25_14:00',
      NOW,
      30 * 24 * 60 * 60,
    );
    const signUpAt = parseLocalDateTime('2026-09-20 10:00:00')!.getTime();
    for (const scenarioCode of ['interview_reminder', 'post_interview_followup']) {
      expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionRef: { corpId: 'corp-1', userId: 'user-1', sessionId: 'chat-1' },
          scenarioCode,
          workOrderId: 464227,
          anchorEventId: `reconcile:wo464227:iv2026-09-25_14:00:${scenarioCode}`,
          // 「报名完成时间」取海绵报名时间而不是发现时刻
          anchorAt: signUpAt,
          channelIdentity: input.channelIdentity,
        }),
      );
    }
  });

  it('AI 自建单或本人校验未通过的带外单不排提醒、不落事件；快照有在途单时不清 booked', async () => {
    bookingSnapshot.load.mockResolvedValue(
      okSnapshot([
        supplierEntry({ signupSource: 'AI' }),
        supplierEntry({ workOrderId: 2, ownedByCandidate: false }),
      ]),
    );
    session.getReengagementState.mockResolvedValue({ terminal: 'booked' });
    const result = await service().reconcile(input);
    expect(result).toMatchObject({
      supplierOwned: 0,
      scheduled: 0,
      linkedEvents: 0,
      terminal: 'unchanged',
    });
    expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalled();
    expect(opsEvents.recordEvent).not.toHaveBeenCalled();
    expect(session.saveTerminalState).not.toHaveBeenCalled();
  });

  it('快照已无在途工单且当前为 booked → 回退终态；其它终态不动', async () => {
    bookingSnapshot.load.mockResolvedValue(okSnapshot([]));
    session.getReengagementState.mockResolvedValue({ terminal: 'booked' });
    expect(await service().reconcile(input)).toMatchObject({ terminal: 'cleared' });
    expect(session.saveTerminalState).toHaveBeenCalledWith('corp-1', 'user-1', 'chat-1', undefined);

    session.saveTerminalState.mockClear();
    session.getReengagementState.mockResolvedValue({ terminal: 'handed_off' });
    expect(await service().reconcile(input)).toMatchObject({ terminal: 'unchanged' });
    expect(session.saveTerminalState).not.toHaveBeenCalled();
  });

  it('稳定锚点：同工单同面试时间已排过（SET NX 失败）不重排；面试时间变化换键重排', async () => {
    redis.setNx.mockResolvedValue(false);
    expect(await service().reconcile(input)).toMatchObject({ scheduled: 0 });
    expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalled();

    redis.setNx.mockImplementation(async (key: string) => key.includes('iv2026-09-26_14:00'));
    bookingSnapshot.load.mockResolvedValue(
      okSnapshot([supplierEntry({ interviewTime: '2026-09-26 14:00' })]),
    );
    expect(await service().reconcile(input)).toMatchObject({ scheduled: 2 });
    expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorEventId: 'reconcile:wo464227:iv2026-09-26_14:00:interview_reminder',
      }),
    );
  });

  it('面试已过不排（事件仍幂等落一次）', async () => {
    bookingSnapshot.load.mockResolvedValue(
      okSnapshot([supplierEntry({ interviewTime: '2026-09-21 14:00' })]),
    );
    const result = await service().reconcile(input);
    expect(result).toMatchObject({ scheduled: 0, linkedEvents: 1 });
    expect(redis.setNx).not.toHaveBeenCalled();
    expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalled();
  });

  it('无面试时间（等通知单）：不调解析任务，走 missing_interview_time 落库分支并挂满 3 天复核', async () => {
    bookingSnapshot.load.mockResolvedValue(okSnapshot([supplierEntry({ interviewTime: null })]));
    const result = await service().reconcile(input);
    expect(result).toMatchObject({ scheduled: 0 });
    expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalled();
    expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioCode: 'interview_reminder',
        anchorEventId: 'reconcile:wo464227:ivnone:interview_reminder',
        workOrderId: 464227,
        state: expect.objectContaining({ terminal: 'booked', interviewAt: undefined }),
      }),
    );
    expect(scheduler.scheduleInterviewSlotCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        workOrderId: 464227,
        signUpAt: parseLocalDateTime('2026-09-20 10:00:00')!.getTime(),
      }),
    );
  });

  it('本人校验取会话姓名与长期档案姓名任一', async () => {
    session.getSessionState.mockResolvedValue({
      facts: { interview_info: { name: null, phone: { value: '18271421690' } } },
    });
    longTerm.getProfile.mockResolvedValue({
      name: { value: '张三', confidence: 'high', source: 'user', evidence: 'x', updatedAt: 'y' },
    });
    await service().reconcile(input);
    expect(longTerm.getProfile).toHaveBeenCalledWith('corp-1', 'user-1', 'wecom-1');
    expect(bookingSnapshot.load).toHaveBeenCalledWith(
      expect.objectContaining({ knownCandidateNames: ['张三'] }),
    );
  });

  describe('手动恢复托管（trigger=resume）', () => {
    it('基础锚点早已排过 → 用 :resumed 后缀重排；距面试不足提前量时不重排', async () => {
      // 基础锚点已存在（占位时间在 1 分钟之前），本轮 SET NX 只对 :resumed 键成功
      redis.get.mockResolvedValue(NOW - 10 * 60 * 1000);
      redis.setNx.mockImplementation(async (key: string) => key.endsWith(':resumed'));
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementScenarioDelayMinutes: { interview_reminder: 120 },
      });

      const result = await service().reconcile({ ...input, trigger: 'resume' });
      expect(result).toMatchObject({ scheduled: 2 });
      expect(scheduler.scheduleBookingResolution).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorEventId: 'reconcile:wo464227:iv2026-09-25_14:00:resumed:interview_reminder',
          anchorAt: NOW,
        }),
      );

      // 面试只剩 1 小时，配置提前量 2 小时 → 不重排
      scheduler.scheduleBookingResolution.mockClear();
      bookingSnapshot.load.mockResolvedValue(
        okSnapshot([supplierEntry({ interviewTime: '2026-09-22 11:00' })]),
      );
      expect(await service().reconcile({ ...input, trigger: 'resume' })).toMatchObject({
        scheduled: 0,
      });
      expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalled();
    });

    it('首次发现（基础锚点本轮刚排）不再叠加 :resumed', async () => {
      redis.get.mockResolvedValue(null);
      const result = await service().reconcile({ ...input, trigger: 'resume' });
      expect(result).toMatchObject({ scheduled: 2 });
      expect(scheduler.scheduleBookingResolution).not.toHaveBeenCalledWith(
        expect.objectContaining({ anchorEventId: expect.stringContaining(':resumed') }),
      );
    });
  });

  it('reconcileAfterTurn 吞掉异常，只记日志', async () => {
    bookingSnapshot.load.mockRejectedValue(new Error('boom'));
    await expect(service().reconcileAfterTurn(input)).resolves.toBeUndefined();
  });
  describe('手动恢复托管钩子', () => {
    it('onModuleInit 向 UserHostingService 注册监听；恢复时按会话反查索引后以 resume 触发对账', async () => {
      const userHosting = { registerResumeListener: jest.fn() };
      const phoneIndex = {
        lookupByChat: jest.fn().mockResolvedValue({
          corpId: 'corp-1',
          userId: 'user-1',
          chatId: 'chat-1',
          botImId: 'bot-1',
          phone: '18271421690',
        }),
      };
      const hooked = new OobReconcileService(
        bookingSnapshot as never,
        session as never,
        longTerm as never,
        scheduler as never,
        opsEvents as never,
        redis as never,
        systemConfig as never,
        userHosting as never,
        phoneIndex as never,
      );
      hooked.onModuleInit();
      expect(userHosting.registerResumeListener).toHaveBeenCalledTimes(1);

      const listener = userHosting.registerResumeListener.mock.calls[0][0] as (
        chatId: string,
      ) => Promise<unknown>;
      await listener('chat-1');
      expect(phoneIndex.lookupByChat).toHaveBeenCalledWith('chat-1');
      expect(bookingSnapshot.load).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '18271421690', botImId: 'bot-1', bypassCache: true }),
      );

      phoneIndex.lookupByChat.mockResolvedValue(null);
      bookingSnapshot.load.mockClear();
      await expect(hooked.reconcileAfterResume('chat-2')).resolves.toBeNull();
      expect(bookingSnapshot.load).not.toHaveBeenCalled();
    });
  });
});
