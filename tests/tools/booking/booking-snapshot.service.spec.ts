import { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import { parseLocalDateTime } from '@infra/utils/date.util';

const NOW = parseLocalDateTime('2026-09-22 10:00:00')!.getTime();

describe('BookingSnapshotService', () => {
  const sponge = { fetchSignupWorkOrders: jest.fn() };
  const redis = { get: jest.fn(), setex: jest.fn(), del: jest.fn() };
  const hosting = { resolveDulidayToken: jest.fn() };
  const tracer = { emit: jest.fn() };

  const baseInput = {
    phone: '18271421690',
    botImId: 'bot-1',
    corpId: 'corp-1',
    userId: 'user-1',
    knownCandidateNames: ['张三'],
    now: NOW,
  };

  const supplierOrder = {
    workOrderId: 464227,
    jobId: 529005,
    brandName: '肯德基',
    currentStatus: '约面成功',
    signupSource: 'SUPPLIER',
    signUpTime: '2026-09-20 10:00:00',
    interviewTime: '2026-09-25 14:00',
    candidateName: '张三',
  };

  const service = () =>
    new BookingSnapshotService(sponge as never, redis as never, hosting as never, tracer as never);

  beforeEach(() => {
    jest.clearAllMocks();
    hosting.resolveDulidayToken.mockResolvedValue('token-1');
    redis.get.mockResolvedValue(null);
    redis.setex.mockResolvedValue(undefined);
    redis.del.mockResolvedValue(1);
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      candidateName: '张三',
      total: 1,
      workOrders: [supplierOrder],
    });
  });

  it('用本会话账号 token 按手机号查一次，服务端只过滤在途状态，3 秒超时且禁止回退默认 token', async () => {
    const result = await service().load(baseInput);

    expect(sponge.fetchSignupWorkOrders).toHaveBeenCalledWith(
      { phone: '18271421690', queryParam: { currentStatus: ['约面待确认', '约面成功'] } },
      { botImId: 'bot-1' },
      { timeoutMs: 3000, allowDefaultToken: false },
    );
    expect(result).toMatchObject({
      status: 'ok',
      fromCache: false,
      candidateName: '张三',
      entries: [
        expect.objectContaining({
          workOrderId: 464227,
          signupSource: 'SUPPLIER',
          ownedByCandidate: true,
        }),
      ],
    });
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'booking_snapshot', status: 'ok', supplierCount: 1 }),
    );
  });

  it('本地再过滤：老报名且面试已过的在途单剔除，老报名但面试在未来保留', async () => {
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      candidateName: '张三',
      workOrders: [
        {
          ...supplierOrder,
          workOrderId: 1,
          signUpTime: '2026-08-01 09:00:00',
          interviewTime: '2026-08-05 14:00',
        },
        {
          ...supplierOrder,
          workOrderId: 2,
          signUpTime: '2026-08-01 09:00:00',
          interviewTime: '2026-09-30 14:00',
        },
      ],
    });
    const result = await service().load(baseInput);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entries.map((entry) => entry.workOrderId)).toEqual([2]);
  });

  it('本人校验：海绵姓名与会话/档案姓名不一致 → ownedByCandidate=false 但仍在快照里', async () => {
    const result = await service().load({ ...baseInput, knownCandidateNames: ['李四'] });
    expect(result).toMatchObject({
      status: 'ok',
      entries: [expect.objectContaining({ workOrderId: 464227, ownedByCandidate: false })],
    });
  });

  it('5 分钟缓存按手机号+账号写入，并按候选人身份镜像一份', async () => {
    await service().load(baseInput);
    expect(redis.setex).toHaveBeenCalledWith(
      'booking:snapshot:bot-1:18271421690',
      300,
      expect.objectContaining({ fetchedAt: NOW }),
    );
    expect(redis.setex).toHaveBeenCalledWith(
      'booking:snapshot:candidate:corp-1:user-1',
      300,
      expect.objectContaining({ fetchedAt: NOW }),
    );
  });

  it('缓存命中不打海绵；命中面试类关键词（bypassCache）时穿透', async () => {
    redis.get.mockResolvedValue({ entries: [], candidateName: '张三', fetchedAt: NOW - 1000 });

    const cached = await service().load(baseInput);
    expect(cached).toMatchObject({ status: 'ok', fromCache: true });
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'booking_snapshot', status: 'cache_hit' }),
    );

    const fresh = await service().load({ ...baseInput, bypassCache: true });
    expect(fresh).toMatchObject({ status: 'ok', fromCache: false });
    expect(sponge.fetchSignupWorkOrders).toHaveBeenCalledTimes(1);
  });

  it('账号没配 token → skipped_no_token 并落观测，不查海绵、不回退默认 token', async () => {
    hosting.resolveDulidayToken.mockResolvedValue(null);
    const result = await service().load(baseInput);
    expect(result).toEqual({ status: 'skipped_no_token' });
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'booking_snapshot',
        status: 'skipped_no_token',
        botImId: 'bot-1',
      }),
    );
  });

  it('没有 botImId 视同没配 token', async () => {
    const result = await service().load({ ...baseInput, botImId: undefined });
    expect(result).toEqual({ status: 'skipped_no_token' });
    expect(hosting.resolveDulidayToken).not.toHaveBeenCalled();
  });

  it('非候选人号段 → skipped_no_phone', async () => {
    await expect(service().load({ ...baseInput, phone: '10086' })).resolves.toEqual({
      status: 'skipped_no_phone',
    });
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
  });

  it('海绵查询失败 → failed（调用方回落指针路径），失败也落观测', async () => {
    sponge.fetchSignupWorkOrders.mockRejectedValue(new Error('海绵工单查询失败: 504'));
    const result = await service().load(baseInput);
    expect(result).toEqual({ status: 'failed', error: '海绵工单查询失败: 504' });
    expect(redis.setex).not.toHaveBeenCalled();
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'booking_snapshot', status: 'failed' }),
    );
  });

  it('缓存读写失败只降级，不影响查询结果', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.setex.mockRejectedValue(new Error('redis down'));
    const result = await service().load(baseInput);
    expect(result).toMatchObject({ status: 'ok', fromCache: false });
  });

  it('invalidate 同时删手机号缓存与候选人镜像', async () => {
    await service().invalidate({
      phone: '18271421690',
      botImId: 'bot-1',
      corpId: 'corp-1',
      userId: 'user-1',
    });
    expect(redis.del).toHaveBeenCalledWith(
      'booking:snapshot:bot-1:18271421690',
      'booking:snapshot:candidate:corp-1:user-1',
    );
    redis.del.mockClear();
    await service().invalidate({ phone: null, botImId: null });
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('peekForCandidate 只读镜像，不触发海绵查询', async () => {
    redis.get.mockResolvedValue({ entries: [], candidateName: null, fetchedAt: NOW });
    await expect(service().peekForCandidate('corp-1', 'user-1')).resolves.toMatchObject({
      fetchedAt: NOW,
    });
    expect(redis.get).toHaveBeenCalledWith('booking:snapshot:candidate:corp-1:user-1');
    expect(sponge.fetchSignupWorkOrders).not.toHaveBeenCalled();
  });
});
