import { BookingContextLoaderService } from '@agent/generator/preparation/booking-context-loader.service';
import {
  renderBookingPrompt,
  visibleBookingWorkOrders,
} from '@agent/generator/context/sections/semantic/memory.section';
import { CallerKind } from '@enums/agent.enum';

describe('BookingContextLoaderService', () => {
  const longTerm = { getActiveBookings: jest.fn() };
  const sponge = {
    getWorkOrderById: jest.fn(),
    getCachedWorkOrderById: jest.fn(),
    fetchSignupWorkOrders: jest.fn(),
    fetchJobs: jest.fn(),
  };
  const snapshot = { load: jest.fn() };
  const phoneIndex = { record: jest.fn() };
  const service = new BookingContextLoaderService(
    longTerm as never,
    sponge as never,
    snapshot as never,
    phoneIndex as never,
  );
  const params = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
    botImId: 'bot-1',
    callerKind: CallerKind.WECOM,
  } as never;

  const memoryWithPhone = (over: { name?: string; phone?: string | null } = {}) =>
    ({
      shortTerm: {
        sessionState: {
          facts: {
            interview_info: {
              phone: over.phone === undefined ? null : { value: over.phone },
              name: over.name ? { value: over.name } : null,
            },
          },
        },
      },
      longTerm: {
        semantic: {
          profile: {
            phone: {
              value: '13800000000',
              confidence: 'high',
              source: 'user',
              evidence: '用户提供',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
            name: {
              value: '张三',
              confidence: 'high',
              source: 'user',
              evidence: '用户提供',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          },
        },
      },
    }) as never;

  const noPhoneMemory = {
    shortTerm: { sessionState: { facts: { interview_info: { phone: null, name: null } } } },
    longTerm: { semantic: { profile: null } },
  } as never;

  const supplierEntry = {
    workOrder: {
      workOrderId: 88,
      jobId: 99,
      brandName: '肯德基',
      currentStatus: '约面待确认',
      interviewTime: '2026-09-25 14:00',
      signupSource: 'SUPPLIER',
    },
    workOrderId: 88,
    jobId: 99,
    brandName: '肯德基',
    jobName: null,
    interviewTime: '2026-09-25 14:00',
    signUpTime: null,
    signupSource: 'SUPPLIER',
    candidateName: '张三',
    ownedByCandidate: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sponge.fetchJobs.mockResolvedValue({ jobs: [] });
    sponge.fetchSignupWorkOrders.mockResolvedValue({ workOrders: [] });
    longTerm.getActiveBookings.mockResolvedValue([]);
    snapshot.load.mockResolvedValue({
      status: 'ok',
      entries: [],
      candidateName: null,
      fromCache: false,
      fetchedAt: 0,
    });
    phoneIndex.record.mockResolvedValue(undefined);
  });

  describe('load（快照优先）', () => {
    it('有本人手机号时按手机号查快照：传本会话账号、已知姓名，关键词穿透缓存；同时刷新手机号→会话索引', async () => {
      snapshot.load.mockResolvedValue({
        status: 'ok',
        entries: [supplierEntry],
        candidateName: '张三',
        fromCache: false,
        fetchedAt: 0,
      });

      const result = await service.load(memoryWithPhone({ name: '张三' }), params, '面试安排呢');

      expect(snapshot.load).toHaveBeenCalledWith({
        phone: '13800000000',
        botImId: 'bot-1',
        corpId: 'corp-1',
        userId: 'user-1',
        knownCandidateNames: ['张三', '张三'],
        bypassCache: true,
      });
      expect(phoneIndex.record).toHaveBeenCalledWith('13800000000', {
        corpId: 'corp-1',
        userId: 'user-1',
        chatId: 'session-1',
        botImId: 'bot-1',
      });
      expect(result).toEqual(
        expect.objectContaining({
          state: 'active',
          source: 'snapshot',
          entries: [expect.objectContaining({ signupSource: 'SUPPLIER', ownedByCandidate: true })],
        }),
      );
      const rendered = renderBookingPrompt(result);
      expect(rendered).toContain('肯德基');
      expect(rendered).toContain('招聘顾问后台登记');
      expect(visibleBookingWorkOrders(result)).toEqual([
        expect.objectContaining({
          workOrderId: 88,
          jobId: 99,
          source: 'out_of_band',
          signupSource: 'SUPPLIER',
          ownedByCandidate: true,
          brandName: '肯德基',
        }),
      ]);
      // 快照路径不再逐工单号查 N 次
      expect(sponge.getWorkOrderById).not.toHaveBeenCalled();
      expect(sponge.getCachedWorkOrderById).not.toHaveBeenCalled();
    });

    it('非预约回合不穿透缓存', async () => {
      await service.load(memoryWithPhone(), params, '你们工资怎么算');
      expect(snapshot.load).toHaveBeenCalledWith(expect.objectContaining({ bypassCache: false }));
    });

    it.each([CallerKind.TEST_SUITE, CallerKind.DEBUG])(
      '%s 链路仍查快照但不刷新手机号→会话索引（带外扫描不能反查到测试会话）',
      async (callerKind) => {
        await service.load(
          memoryWithPhone(),
          { ...(params as object), callerKind } as never,
          '面试',
        );
        expect(snapshot.load).toHaveBeenCalledTimes(1);
        expect(phoneIndex.record).not.toHaveBeenCalled();
      },
    );

    it('本人校验未通过的工单只渲染并标注归属', async () => {
      snapshot.load.mockResolvedValue({
        status: 'ok',
        entries: [{ ...supplierEntry, ownedByCandidate: false }],
        candidateName: '王五',
        fromCache: false,
        fetchedAt: 0,
      });
      const result = await service.load(memoryWithPhone({ name: '张三' }), params, '面试');
      expect(renderBookingPrompt(result)).toContain('登记姓名与候选人自报姓名不一致');
      expect(visibleBookingWorkOrders(result)[0]).toMatchObject({ ownedByCandidate: false });
    });

    it('快照成功且为空 → none（权威空态），不再回落指针', async () => {
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 1, linked_at: '2026-01-01T00:00:00.000Z' },
      ]);
      const result = await service.load(memoryWithPhone(), params, '有面试吗');
      expect(result).toEqual({ state: 'none' });
      expect(sponge.getCachedWorkOrderById).not.toHaveBeenCalled();
    });

    it('30 分钟窗口内的另一账号指针工单并入快照（并发建单场景）', async () => {
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 777, linked_at: new Date(Date.now() - 60_000).toISOString() },
        { work_order_id: 1, linked_at: '2026-01-01T00:00:00.000Z' },
      ]);
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 777,
        brandName: '瑞幸',
        currentStatus: '约面待确认',
      });
      const result = await service.load(memoryWithPhone(), params, '有面试吗');
      expect(sponge.getCachedWorkOrderById).toHaveBeenCalledTimes(1);
      expect(sponge.getCachedWorkOrderById).toHaveBeenCalledWith(777, expect.anything());
      expect(result).toEqual(
        expect.objectContaining({
          state: 'active',
          source: 'snapshot',
          entries: [expect.objectContaining({ ownedByCandidate: true })],
        }),
      );
      expect(renderBookingPrompt(result)).toContain('瑞幸');
    });

    it.each([
      ['failed', { status: 'failed', error: 'timeout' }],
      ['skipped_no_token', { status: 'skipped_no_token' }],
    ])('快照 %s 时回落 active_booking 指针路径', async (_label, loadResult) => {
      snapshot.load.mockResolvedValue(loadResult);
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 449822, linked_at: '2026-09-01T00:00:00.000Z' },
      ]);
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 449822,
        brandName: '奥乐齐',
        currentStatus: '约面待确认',
      });
      const result = await service.load(memoryWithPhone(), params, '你们工资怎么算');
      expect(result).toEqual(
        expect.objectContaining({ state: 'active', source: 'active_booking' }),
      );
      expect(renderBookingPrompt(result)).toContain('奥乐齐');
    });

    it('没有本人手机号时直接走指针路径，不查快照、不写索引', async () => {
      longTerm.getActiveBookings.mockResolvedValue([]);
      const result = await service.load(noPhoneMemory, params, '有面试吗');
      expect(snapshot.load).not.toHaveBeenCalled();
      expect(phoneIndex.record).not.toHaveBeenCalled();
      expect(result).toEqual({ state: 'none' });
    });
  });

  it('distinguishes an authoritative empty result from a source failure', async () => {
    longTerm.getActiveBookings.mockResolvedValueOnce([]);
    const empty = await service.loadPointer(params, '有面试吗');
    expect(empty).toEqual({ state: 'none' });
    expect(renderBookingPrompt(empty)).toContain('[预约状态]');

    longTerm.getActiveBookings.mockRejectedValueOnce(new Error('redis down'));
    const hidden = await service.loadPointer(params, '有面试吗');
    expect(hidden).toEqual({ state: 'hidden' });
    expect(renderBookingPrompt(hidden)).toBe('');
  });

  // 以下几例随备料层拆分从 preparation.service.spec 删除，指针路径的取数分支
  // （直查 vs 短缓存、同步中、指针失效、部分失败、地址补齐）此前无处守着。
  it('直查海绵瞬时失败时标记 syncing，不回退本地快照', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
    sponge.getWorkOrderById.mockRejectedValue(new Error('sponge timeout'));

    const snapshot = await service.loadPointer(params, '我想改约面试时间');

    expect(snapshot).toEqual(
      expect.objectContaining({ state: 'active', source: 'active_booking', syncing: true }),
    );
    expect(sponge.getCachedWorkOrderById).not.toHaveBeenCalled();
    const rendered = renderBookingPrompt(snapshot);
    expect(rendered).toContain('预约信息同步中');
    expect(rendered).not.toContain('预约 1');
  });

  it('海绵明确查不到工单（指针失效）时静默跳过，不注入同步中提示', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
    sponge.getWorkOrderById.mockResolvedValue(null);

    const snapshot = await service.loadPointer(params, '面试还算数吗');

    expect(snapshot).toEqual(
      expect.objectContaining({ state: 'active', entries: [], syncing: false }),
    );
    // 失效指针若也走「同步中」，每个预约回合都会永久停在「稍等一下」。
    expect(renderBookingPrompt(snapshot)).toBe('');
  });

  it('非预约回合走短缓存，不为每轮加一次海绵直查', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
    sponge.getCachedWorkOrderById.mockResolvedValue({
      workOrderId: 449822,
      brandName: '奥乐齐',
      currentStatus: '约面待确认',
    });

    await service.loadPointer(params, '你们这边工资怎么算');

    expect(sponge.getCachedWorkOrderById).toHaveBeenCalledTimes(1);
    expect(sponge.getWorkOrderById).not.toHaveBeenCalled();
  });

  it.each(['我想改约', '那天我去不了', '取消吧', '面试地址在哪'])(
    '改约/取消/地址类信号（%s）触发直查海绵',
    async (message) => {
      longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 449822,
        brandName: '奥乐齐',
        currentStatus: '约面待确认',
      });

      await service.loadPointer(params, message);

      expect(sponge.getWorkOrderById).toHaveBeenCalled();
      expect(sponge.getCachedWorkOrderById).not.toHaveBeenCalled();
    },
  );

  it('本轮无用户输入时按非预约回合处理，走缓存路径', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
    sponge.getCachedWorkOrderById.mockResolvedValue({
      workOrderId: 449822,
      brandName: '奥乐齐',
      currentStatus: '约面待确认',
    });

    await service.loadPointer(params, undefined);

    expect(sponge.getWorkOrderById).not.toHaveBeenCalled();
    expect(sponge.getCachedWorkOrderById).toHaveBeenCalledTimes(1);
  });

  it('一个工单查询失败时保留其它在途预约', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 1 }, { work_order_id: 2 }]);
    sponge.getWorkOrderById.mockImplementation(async (workOrderId: number) => {
      if (workOrderId === 1) throw new Error('sponge down');
      return { workOrderId: 2, brandName: '瑞幸', currentStatus: '约面待确认' };
    });

    const snapshot = await service.loadPointer(params, '改约');

    expect(snapshot).toEqual(expect.objectContaining({ state: 'active', syncing: true }));
    const rendered = renderBookingPrompt(snapshot);
    expect(rendered).toContain('瑞幸');
    expect(rendered).toContain('预约信息同步中');
  });

  it('询问定位时补齐工作门店地址与线下面试地址', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
    sponge.getWorkOrderById.mockResolvedValue({
      workOrderId: 449822,
      jobId: 520361,
      brandName: '成都你六姐',
      currentStatus: '约面待确认',
    });
    sponge.fetchJobs.mockResolvedValue({
      jobs: [
        {
          basicInfo: { storeInfo: { storeAddress: '上海东方渔人码头成都你六姐F1楼' } },
          interviewProcess: {
            interviewMethod: '线下面试',
            interviewAddress: '新店开业前在成都你六姐（上海控江旭辉店）面试',
          },
        },
      ],
    });

    const snapshot = await service.loadPointer(params, '面试地址怎么走');

    expect(sponge.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ jobIdList: [520361] }),
      expect.objectContaining({ botImId: 'bot-1' }),
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            location: expect.objectContaining({ storeAddress: '上海东方渔人码头成都你六姐F1楼' }),
          }),
        ],
      }),
    );
  });

  it('不询问定位的回合不拉取岗位地址详情', async () => {
    longTerm.getActiveBookings.mockResolvedValue([{ work_order_id: 449822 }]);
    sponge.getWorkOrderById.mockResolvedValue({
      workOrderId: 449822,
      jobId: 520361,
      brandName: '奥乐齐',
      currentStatus: '约面待确认',
    });

    await service.loadPointer(params, '我想改约');

    expect(sponge.fetchJobs).not.toHaveBeenCalled();
  });
});
