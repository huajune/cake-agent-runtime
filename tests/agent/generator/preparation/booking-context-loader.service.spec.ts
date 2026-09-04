import { BookingContextLoaderService } from '@agent/generator/preparation/booking-context-loader.service';
import { renderBookingPrompt } from '@agent/generator/context/sections/semantic/memory.section';

describe('BookingContextLoaderService', () => {
  const longTerm = { getActiveBookings: jest.fn() };
  const sponge = {
    getWorkOrderById: jest.fn(),
    getCachedWorkOrderById: jest.fn(),
    fetchSignupWorkOrders: jest.fn(),
    fetchJobs: jest.fn(),
  };
  const service = new BookingContextLoaderService(longTerm as never, sponge as never);
  const params = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    sponge.fetchJobs.mockResolvedValue({ jobs: [] });
    sponge.fetchSignupWorkOrders.mockResolvedValue({ workOrders: [] });
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

  it('uses an out-of-band active work order when the pointer path is empty', async () => {
    sponge.fetchSignupWorkOrders.mockResolvedValue({
      workOrders: [
        {
          workOrderId: 88,
          jobId: 99,
          brandName: '肯德基',
          currentStatus: '约面待确认',
        },
      ],
    });
    const memory = {
      shortTerm: { sessionState: { facts: { interview_info: { phone: null } } } },
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
          },
        },
      },
    } as never;

    const result = await service.enrichOutOfBand({ state: 'none' }, memory, params, '面试安排呢');
    expect(result).toEqual(expect.objectContaining({ state: 'active', source: 'out_of_band' }));
    expect(renderBookingPrompt(result)).toContain('肯德基');
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
      undefined,
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
