import { CandidateProgressService } from '@biz/candidate-progress/services/candidate-progress.service';

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
});
