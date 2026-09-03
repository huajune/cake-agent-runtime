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
});
