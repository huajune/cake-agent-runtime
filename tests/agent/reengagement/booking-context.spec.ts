import { resolveReengagementBookingContext } from '@agent/reengagement/booking-context';

describe('resolveReengagementBookingContext', () => {
  const input = {
    corpId: 'corp-1',
    userId: 'user-1',
    preferredWorkOrderId: 222,
    botImId: 'bot-1',
  };

  it('uses active_booking only for identity and builds facts from fresh Sponge data', async () => {
    const longTerm = {
      getActiveBookings: jest.fn().mockResolvedValue([
        {
          work_order_id: 111,
          linked_at: '2026-07-01T00:00:00.000Z',
          interview_time: '2026-07-20 09:00',
          brand_name: '旧品牌',
        },
        {
          work_order_id: 222,
          linked_at: '2026-07-02T00:00:00.000Z',
          interview_time: '2026-07-21 09:00',
          brand_name: '另一个旧品牌',
        },
      ]),
    };
    const sponge = {
      getWorkOrderById: jest.fn().mockResolvedValue({
        workOrderId: 222,
        jobId: 9002,
        brandName: '海绵实时品牌',
        companyName: '大型集团',
        projectName: '总部招聘项目',
        jobName: '招商主管',
        currentStatus: '约面成功',
        interviewTime: '2026-07-22 14:30',
      }),
      fetchJobs: jest.fn().mockResolvedValue({
        total: 1,
        jobs: [
          {
            basicInfo: {
              jobName: '招商主管',
              brandName: '岗位品牌',
              storeInfo: { storeName: '上海总部' },
            },
            interviewProcess: {
              firstInterview: {
                firstInterviewWay: '线下面试',
                interviewAddress: '上海市静安区一号楼',
                interviewDemand: '携带身份证',
              },
            },
          },
        ],
      }),
    };

    const result = await resolveReengagementBookingContext(
      longTerm as never,
      sponge as never,
      input,
    );

    expect(longTerm.getActiveBookings).not.toHaveBeenCalled();
    expect(sponge.getWorkOrderById).toHaveBeenCalledWith(222, { botImId: 'bot-1' });
    expect(sponge.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        jobIdList: [9002],
        onlySignableJobs: false,
        options: { includeBasicInfo: true, includeInterviewProcess: true },
      }),
      { botImId: 'bot-1' },
    );
    expect(result).toEqual(
      expect.objectContaining({
        workOrderId: 222,
        jobId: 9002,
        brandName: '海绵实时品牌',
        companyName: '大型集团',
        storeName: '上海总部',
        jobName: '招商主管',
        currentStatus: '约面成功',
        interviewAt: Date.UTC(2026, 6, 22, 6, 30),
        interviewType: '线下面试',
        interviewAddress: '上海市静安区一号楼',
        interviewRequirement: '携带身份证',
      }),
    );
    expect(result?.brandName).not.toBe('另一个旧品牌');
  });

  it('fails closed when fresh work-order lookup is unavailable', async () => {
    const longTerm = {
      getActiveBookings: jest.fn().mockResolvedValue([
        {
          work_order_id: 222,
          linked_at: '2026-07-02T00:00:00.000Z',
          interview_time: '2026-07-21 09:00',
          brand_name: '旧品牌',
          store_name: '旧门店',
        },
      ]),
    };
    const sponge = {
      getWorkOrderById: jest.fn().mockResolvedValue(null),
      fetchJobs: jest.fn(),
    };

    await expect(
      resolveReengagementBookingContext(longTerm as never, sponge as never, input),
    ).resolves.toBeNull();
    expect(sponge.fetchJobs).not.toHaveBeenCalled();
  });

  it('keeps a neutral work-order context when current job details are unavailable', async () => {
    const longTerm = { getActiveBookings: jest.fn().mockResolvedValue([]) };
    const sponge = {
      getWorkOrderById: jest.fn().mockResolvedValue({
        workOrderId: 222,
        jobId: 9002,
        currentStatus: '约面成功',
        interviewTime: '2026-07-22 14:30',
      }),
      fetchJobs: jest.fn().mockRejectedValue(new Error('job service unavailable')),
    };

    const result = await resolveReengagementBookingContext(
      longTerm as never,
      sponge as never,
      input,
    );

    expect(result).toEqual(
      expect.objectContaining({
        workOrderId: 222,
        jobId: 9002,
        currentStatus: '约面成功',
        interviewAt: Date.UTC(2026, 6, 22, 6, 30),
      }),
    );
    expect(result).not.toHaveProperty('interviewType');
    expect(result).not.toHaveProperty('interviewAddress');
    expect(result).not.toHaveProperty('interviewRequirement');
  });

  it('uses active_booking only as an index when no work order is explicitly bound', async () => {
    const longTerm = {
      getActiveBookings: jest.fn().mockResolvedValue([
        { work_order_id: 333, linked_at: '2026-07-03T00:00:00.000Z' },
      ]),
    };
    const sponge = {
      getWorkOrderById: jest.fn().mockResolvedValue({
        workOrderId: 333,
        currentStatus: '约面成功',
        interviewTime: '2026-07-23 10:00',
      }),
      fetchJobs: jest.fn(),
    };

    const result = await resolveReengagementBookingContext(longTerm as never, sponge as never, {
      corpId: 'corp-1',
      userId: 'user-1',
    });

    expect(longTerm.getActiveBookings).toHaveBeenCalledWith('corp-1', 'user-1');
    expect(sponge.getWorkOrderById).toHaveBeenCalledWith(333);
    expect(result?.workOrderId).toBe(333);
  });
});
