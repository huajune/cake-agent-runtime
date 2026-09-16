import type { JobDetail } from '@sponge/sponge.types';
import { runBookingScheduleAndNameGuards } from '@tools/booking/booking-guards.util';

function makeWindowJob(): JobDetail {
  return {
    basicInfo: { jobId: 1, jobName: '测试岗位' },
    interviewProcess: {
      firstInterview: {
        periodicInterviewTimes: ['一', '二', '三', '四', '五', '六', '日'].map((day) => ({
          interviewWeekday: `每周${day}`,
          interviewTimes: [{ interviewStartTime: '09:00', interviewEndTime: '18:00' }],
        })),
      },
    },
  } as unknown as JobDetail;
}

describe('runBookingScheduleAndNameGuards', () => {
  it('rejects a nickname before submission', () => {
    const result = runBookingScheduleAndNameGuards({
      job: makeWindowJob(),
      name: '测试昵称昵称',
      interviewTime: '2099-12-31 15:00:00',
    });

    expect(result?.errorType).toBe('booking.missing_fields');
  });

  it.each(['布海力其木·图拉江', '艾力•买买提'])(
    '间隔号分段的少数民族全名 %s 过姓名守卫',
    (name) => {
      expect(
        runBookingScheduleAndNameGuards({
          job: makeWindowJob(),
          name,
          interviewTime: '2099-12-31 15:00:00',
        }),
      ).toBeNull();
    },
  );

  it('纯 CJK 5 字与带称谓的间隔号写法仍被姓名守卫拦下', () => {
    for (const name of ['布买日也木', '艾力·买买提先生']) {
      expect(
        runBookingScheduleAndNameGuards({
          job: makeWindowJob(),
          name,
          interviewTime: '2099-12-31 15:00:00',
        })?.errorType,
      ).toBe('booking.missing_fields');
    }
  });

  it.each(['09:00:00', '15:00:00', '18:00:00'])(
    'accepts a real name and an in-window time: %s',
    (time) => {
      expect(
        runBookingScheduleAndNameGuards({
          job: makeWindowJob(),
          name: '兮兮',
          interviewTime: `2099-12-31 ${time}`,
        }),
      ).toBeNull();
    },
  );

  it.each(['08:00:00', '20:30:00'])('rejects a fabricated out-of-window time: %s', (time) => {
    const result = runBookingScheduleAndNameGuards({
      job: makeWindowJob(),
      name: '兮兮',
      interviewTime: `2099-12-31 ${time}`,
    });

    expect(result?.errorType).toBe('booking.invalid_interview_time');
    expect(result?._outcome).toContain('时刻不在面试窗口内');
  });

  it('does not recreate free-text screening when the live contract has no such field', () => {
    const job = {
      ...makeWindowJob(),
      hiringRequirement: {
        figure: '仅社会人士',
        basicPersonalRequirements: { genderRequirement: '女' },
        certificate: { healthCertificate: '必须先办健康证' },
      },
    } as JobDetail;

    expect(
      runBookingScheduleAndNameGuards({
        job,
        name: '兮兮',
        interviewTime: '2099-12-31 15:00:00',
      }),
    ).toBeNull();
  });
});
