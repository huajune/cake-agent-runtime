import { CandidateProgressService } from '@biz/candidate-progress/services/candidate-progress.service';
import type { SignupWorkOrderItem } from '@sponge/sponge.types';

describe('CandidateProgressService', () => {
  const scope = {
    corpId: 'corp',
    userId: 'person',
    chatId: 'chat-b',
    botImId: 'bot-b',
    botUserId: 'manager-b',
  };
  const longTerm = { tryGetActiveBookings: jest.fn(), getProfile: jest.fn() };
  const session = { getSessionState: jest.fn() };
  const workbench = { getStage: jest.fn() };
  const sponge = { fetchSignupWorkOrders: jest.fn() };
  const snapshot = { load: jest.fn(), peekForCandidate: jest.fn() };
  const tracer = { emit: jest.fn() };
  const service = new CandidateProgressService(
    longTerm as never,
    session as never,
    workbench as never,
    sponge as never,
    snapshot as never,
    tracer as never,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    longTerm.tryGetActiveBookings.mockResolvedValue([]);
    longTerm.getProfile.mockResolvedValue({
      name: {
        value: '虚构本人甲',
        source: 'system',
        confidence: 'high',
        evidence: 'candidate statement',
      },
      phone: {
        value: '13812345678',
        source: 'system',
        confidence: 'high',
        evidence: 'candidate statement',
      },
    });
    session.getSessionState.mockResolvedValue({ facts: null });
    workbench.getStage.mockResolvedValue({ currentStage: null });
    sponge.fetchSignupWorkOrders.mockResolvedValue({ workOrders: [], total: 0 });
    snapshot.peekForCandidate.mockResolvedValue(null);
  });
  it('recovers a valid own phone from the same account profile after session expiry', async () => {
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      candidateName: '虚构本人甲',
      workOrders: [{ workOrderId: 1, currentStatus: '约面成功' }],
    });
    const result = await service.read(scope, 'fresh');
    expect(result).toMatchObject({
      active: 'yes',
      phone: { value: '13812345678', source: 'profile' },
      stage: { fallback: true },
      group: { verified: false },
    });
    expect(longTerm.getProfile).toHaveBeenCalledWith('corp', 'person', 'manager-b');
    expect(sponge.fetchSignupWorkOrders).toHaveBeenCalledWith(
      { phone: '13812345678', onlyCurrentAccount: false },
      { botImId: 'bot-b' },
      { timeoutMs: 3000, allowDefaultToken: false },
    );
  });
  it('does not use a malformed session phone or placeholders to bypass identity validation', async () => {
    session.getSessionState.mockResolvedValue({
      facts: { interview_info: { phone: { value: '11111111111' } } },
    });
    longTerm.getProfile.mockResolvedValue({
      phone: {
        value: '123',
        source: 'system',
        confidence: 'high',
        evidence: 'candidate statement',
      },
    });
    expect(await service.read(scope, 'fresh')).toMatchObject({
      active: 'unknown',
      phone: { value: null, source: 'missing' },
    });
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
  });
  it('keeps unknown distinct from an authoritative empty list', async () => {
    sponge.fetchSignupWorkOrders.mockRejectedValueOnce(new Error('timeout'));
    expect((await service.read(scope, 'fresh')).active).toBe('unknown');
    expect((await service.read(scope, 'fresh')).active).toBe('no');
  });
  it('uses the existing snapshot for cached mode without extra external fetch', async () => {
    snapshot.load.mockResolvedValue({
      status: 'ok',
      entries: [],
      allWorkOrders: [],
      fetchedAt: Date.now(),
    });
    expect((await service.read(scope, 'cached')).active).toBe('no');
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
    snapshot.load.mockResolvedValue({ status: 'ok', entries: [], fetchedAt: Date.now() });
    expect((await service.read(scope, 'cached')).active).toBe('unknown');
  });
  it('does not infer current-account ownership from a legacy cached snapshot', async () => {
    snapshot.load.mockResolvedValue({
      status: 'ok',
      entries: [],
      allWorkOrders: [
        { workOrderId: 12, currentStatus: '约面成功', signupSource: 'supplier' },
        { workOrderId: 13, currentStatus: '约面成功', signupSource: 'bot' },
      ],
      fetchedAt: Date.now(),
    });
    const result = await service.read(scope, 'cached');
    expect(result.orders).toEqual([
      expect.objectContaining({ workOrderId: 12, ownedByCurrentAccount: 'unknown' }),
      expect.objectContaining({ workOrderId: 13, ownedByCurrentAccount: 'unknown' }),
    ]);
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
  });
  it('cannot promote a partial empty read to no-booking guard evidence', async () => {
    snapshot.peekForCandidate.mockResolvedValue({ entries: [], fetchedAt: Date.now() });
    longTerm.tryGetActiveBookings.mockResolvedValue(null);
    expect(await service.readGuardBookings('corp', 'person')).toBeUndefined();
    longTerm.tryGetActiveBookings.mockResolvedValue([]);
    expect(await service.readGuardBookings('corp', 'person')).toEqual([]);
    snapshot.peekForCandidate.mockResolvedValue(null);
    longTerm.tryGetActiveBookings.mockResolvedValue([
      { work_order_id: 1, linked_at: '2026-10-01' },
    ]);
    expect(await service.readGuardBookings('corp', 'person')).toHaveLength(1);
  });
  it('records disagreement using the same source batch while keeping the old result', async () => {
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      candidateName: '虚构本人甲',
      workOrders: [{ workOrderId: 1, currentStatus: '面试成功' }],
    });
    expect(await service.read(scope, 'fresh')).toMatchObject({ policy: 'legacy', active: 'yes' });
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'candidate_progress_difference',
        context: false,
        proactive: true,
        openWithoutWindow: true,
        selectedPolicy: 'legacy',
      }),
    );
  });

  describe.each(['fresh', 'cached'] as const)('%s candidate ownership', (mode) => {
    const loadOrders = (workOrders: SignupWorkOrderItem[], candidateName: string | null = null) => {
      sponge.fetchSignupWorkOrders.mockResolvedValue({ candidateName, workOrders });
      snapshot.load.mockResolvedValue({
        status: 'ok',
        candidateName,
        allWorkOrders: workOrders,
        // Snapshot entries have a different time window and must not drive pre-booking stops.
        entries: [],
        fetchedAt: Date.now(),
      });
    };

    it.each(['约面成功', '面试成功', '上岗成功'])(
      'does not stop for a companion-only %s order on the same phone',
      async (currentStatus) => {
        const orders = [{ workOrderId: 2, currentStatus, candidateName: '虚构同行人乙' }];
        loadOrders(orders, '虚构本人甲');
        const result = await service.read(scope, mode);
        expect(result).toMatchObject({ active: 'no', outOfBandVerdict: null, workOrders: orders });
        expect(result.orders[0].ownedByCurrentAccount).toBe('unknown');
      },
    );

    it('uses the same-account profile name even when the session already has a phone', async () => {
      session.getSessionState.mockResolvedValue({
        facts: { interview_info: { phone: { value: '13812345678' } } },
      });
      loadOrders([{ workOrderId: 1, currentStatus: '约面成功' }], '虚构 本人甲');
      expect(await service.read(scope, mode)).toMatchObject({
        active: 'yes',
        phone: { source: 'session' },
        outOfBandVerdict: { workOrderId: 1 },
      });
      expect(longTerm.getProfile).toHaveBeenCalledWith('corp', 'person', 'manager-b');
    });

    it('uses session identity without requiring an available long-term profile', async () => {
      longTerm.getProfile.mockResolvedValue(null);
      session.getSessionState.mockResolvedValue({
        facts: {
          interview_info: { phone: { value: '13812345678' }, name: { value: '虚构本人甲' } },
        },
      });
      loadOrders([{ workOrderId: 1, currentStatus: '约面成功', candidateName: '虚构本人甲' }]);
      expect((await service.read(scope, mode)).active).toBe('yes');
    });

    it('still stops for a verified own order among companion and unnamed orders', async () => {
      loadOrders([
        { workOrderId: 2, currentStatus: '约面成功', candidateName: '虚构同行人乙' },
        { workOrderId: 3, currentStatus: '约面成功' },
        { workOrderId: 1, currentStatus: '约面成功', candidateName: '虚构本人甲' },
      ]);
      expect(await service.read(scope, mode)).toMatchObject({
        active: 'yes',
        outOfBandVerdict: { workOrderId: 1 },
      });
    });

    it('keeps unknown when a potentially active order has no supplier name', async () => {
      loadOrders([{ workOrderId: 1, currentStatus: '约面成功' }]);
      expect(await service.read(scope, mode)).toMatchObject({
        active: 'unknown',
        outOfBandVerdict: null,
      });
    });

    it('keeps unknown when the candidate identity is unavailable', async () => {
      session.getSessionState.mockResolvedValue({
        facts: { interview_info: { phone: { value: '13812345678' } } },
      });
      longTerm.getProfile.mockResolvedValue(null);
      loadOrders([{ workOrderId: 1, currentStatus: '约面成功', candidateName: '虚构同行人乙' }]);
      expect(await service.read(scope, mode)).toMatchObject({
        active: 'unknown',
        outOfBandVerdict: null,
      });
    });

    it('does not treat an unnamed terminated order as active or an identity blocker', async () => {
      loadOrders([{ workOrderId: 1, currentStatus: '约面取消' }]);
      expect((await service.read(scope, mode)).active).toBe('no');
    });

    it('preserves pre-booking windows even when the snapshot window excludes the order', async () => {
      const day = 24 * 60 * 60 * 1000;
      const oldSignup = new Date(Date.now() - 20 * day).toISOString();
      loadOrders([
        {
          workOrderId: 1,
          candidateName: '虚构本人甲',
          currentStatus: '约面成功',
          signUpTime: oldSignup,
          interviewTime: new Date(Date.now() - 2 * day).toISOString(),
        },
      ]);
      expect((await service.read(scope, mode)).active).toBe('yes');
      loadOrders([
        {
          workOrderId: 1,
          candidateName: '虚构本人甲',
          currentStatus: '约面成功',
          signUpTime: oldSignup,
          interviewTime: new Date(Date.now() - 4 * day).toISOString(),
        },
      ]);
      expect((await service.read(scope, mode)).active).toBe('no');
    });
  });
});
