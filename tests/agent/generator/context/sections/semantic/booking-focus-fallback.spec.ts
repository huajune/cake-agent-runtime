import { bookingFocusJobFallback } from '@agent/generator/context/sections/semantic/memory.section';

describe('bookingFocusJobFallback（J5/J6 已约岗位视为合法焦点）', () => {
  it('快照里恰有一张带岗位 ID 的工单 → 合成焦点岗位（只带工单能给的字段）', () => {
    expect(
      bookingFocusJobFallback([
        {
          workOrderId: 1,
          jobId: 529005,
          source: 'out_of_band',
          signupSource: 'SUPPLIER',
          ownedByCandidate: true,
          brandName: '肯德基',
          jobName: '服务员',
        },
      ]),
    ).toEqual({
      jobId: 529005,
      brandName: '肯德基',
      jobName: '服务员',
      storeName: null,
      cityName: null,
      regionName: null,
      laborForm: null,
      salaryDesc: null,
      jobCategoryName: null,
    });
  });

  it('没有工单、工单无岗位 ID、或多张带岗位 ID 的工单 → 不猜焦点', () => {
    expect(bookingFocusJobFallback([])).toBeNull();
    expect(
      bookingFocusJobFallback([{ workOrderId: 1, jobId: null, source: 'active_booking' }]),
    ).toBeNull();
    expect(
      bookingFocusJobFallback([
        { workOrderId: 1, jobId: 10, source: 'active_booking' },
        { workOrderId: 2, jobId: 20, source: 'active_booking' },
      ]),
    ).toBeNull();
  });

  it('多张工单但只有一张带岗位 ID → 取那一张', () => {
    expect(
      bookingFocusJobFallback([
        { workOrderId: 1, jobId: null, source: 'active_booking' },
        { workOrderId: 2, jobId: 20, source: 'active_booking', brandName: null, jobName: null },
      ])?.jobId,
    ).toBe(20);
  });
});
