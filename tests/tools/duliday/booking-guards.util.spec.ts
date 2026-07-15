import { runBookingGuards } from '@tools/duliday/booking/booking-guards.util';
import type { JobDetail } from '@sponge/sponge.types';

/**
 * Booking guard 单元测试 —— 重点覆盖 hard-requirements 新增的 gender / healthCert 校验。
 * 其它 guard（真名 / 时段 / 筛选答案）已经在 duliday-interview-booking.tool.spec 里走过集成。
 */

function makeJob(overrides: Record<string, unknown> = {}): JobDetail {
  // 提供面试 schedule 才能跳过时段校验，不然 interview window 那一关会先拦下，
  // 但本测试要的是后置的 hard-requirements 报错。给一个宽松的 schedule。
  const baseInterviewProcess = {
    interviewMethod: '到店面试',
    interviewTimeSchedule: {
      interviewTimeSlotList: [
        {
          beginTime: '09:00:00',
          endTime: '18:00:00',
          weekDayList: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
    },
  };
  return {
    basicInfo: { jobId: 1, jobName: 'demo' },
    interviewProcess: baseInterviewProcess,
    hiringRequirement: {},
    ...overrides,
  } as unknown as JobDetail;
}

const realName = '张三';
// 远期日期 + 弱时段窗口，确保 interview-window 校验过得去
const interviewTime = '2099-12-31 10:00:00';

describe('runBookingGuards · hard-requirements', () => {
  describe('gender conflict', () => {
    it('blocks booking when 岗位限女 but candidate male', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '女' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateGenderId: 1,
      });
      expect(result).not.toBeNull();
      expect(result?._outcome).toContain('性别');
      expect(result?.errorType).toBe('booking.rejected');
    });

    it('blocks booking when 岗位限男 but candidate female', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '限男性' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateGenderId: 2,
        candidateHasHealthCertificate: 1,
      });
      expect(result).not.toBeNull();
      expect(result?._outcome).toContain('性别');
    });

    it('passes when gender matches', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '女' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateGenderId: 2,
        candidateHasHealthCertificate: 1,
      });
      expect(result).toBeNull();
    });

    it('passes when 岗位 gender unspecified/any', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '不限' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateGenderId: 1,
        candidateHasHealthCertificate: 1,
      });
      expect(result).toBeNull();
    });

    it('passes when candidate genderId missing', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '女' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 1,
      });
      expect(result).toBeNull();
    });
  });

  describe('health cert conflict', () => {
    it('blocks when 面试前必须有 + 候选人 hasHealthCertificate=2 (无但接受办理)', () => {
      // 使用 policy parser HEALTH_CERT_TIGHT_KEYWORDS 收录的"硬"措辞，触发 before_interview gate
      const job = makeJob({
        hiringRequirement: {
          certificate: { healthCertificate: '必须先办健康证' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 2,
      });
      expect(result).not.toBeNull();
      expect(result?._outcome).toContain('健康证');
    });

    it('blocks when 入职前必须办 + 候选人 hasHealthCertificate=3 (无且不接受办理)', () => {
      const job = makeJob({
        hiringRequirement: {
          certificate: { healthCertificate: '入职前办好即可' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 3,
      });
      expect(result).not.toBeNull();
      expect(result?._outcome).toContain('健康证');
    });

    it('passes when 入职前办即可 + 候选人接受办理 (hasHealthCertificate=2)', () => {
      const job = makeJob({
        hiringRequirement: {
          certificate: { healthCertificate: '入职前办好即可' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 2,
      });
      expect(result).toBeNull();
    });

    it('passes when 候选人持证 (hasHealthCertificate=1)', () => {
      const job = makeJob({
        hiringRequirement: {
          certificate: { healthCertificate: '必须先办健康证' },
        },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 1,
      });
      expect(result).toBeNull();
    });

    it('passes when job healthCert is unspecified', () => {
      const job = makeJob({
        hiringRequirement: { certificate: {} },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 3,
      });
      expect(result).toBeNull();
    });

    it('blocks when the required health certificate value is missing', () => {
      const job = makeJob({
        hiringRequirement: { certificate: { healthCertificate: '食品健康证' } },
      });
      const result = runBookingGuards({ job, name: realName, interviewTime });
      expect(result).not.toBeNull();
      expect(result?._replyInstruction).toContain('本地健康证');
    });

    it('blocks a forged value 1 when the candidate fact says non-local certificate', () => {
      const job = makeJob({
        hiringRequirement: { certificate: { healthCertificate: '食品健康证' } },
      });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateHasHealthCertificate: 1,
        candidateHealthCertificateFact: '非本地健康证',
      });
      expect(result).not.toBeNull();
      expect(result?._replyInstruction).toContain('异地健康证');
    });
  });

  describe('household conflict · guardrail review record 589', () => {
    const restrictedJob = () =>
      makeJob({
        hiringRequirement: {
          requirementsForHometown: {
            nativePlaceRequirementType: '不要',
            nativePlaces: ['天津市', '江西省'],
          },
        },
      });

    it('blocks before booking when candidate province is explicitly excluded', () => {
      const result = runBookingGuards({
        job: restrictedJob(),
        name: realName,
        interviewTime,
        candidateHouseholdProvinceId: 120000,
      });

      expect(result).not.toBeNull();
      expect(result?.errorType).toBe('booking.rejected');
      expect(result?._outcome).toContain('内部硬性条件');
      expect(result?._replyInstruction).not.toContain('天津');
      expect(result?._replyInstruction).not.toContain('江西');
      expect(result?._replyInstruction).toContain('禁止透露');
    });

    it('passes when candidate province is not excluded or is unknown', () => {
      expect(
        runBookingGuards({
          job: restrictedJob(),
          name: realName,
          interviewTime,
          candidateHouseholdProvinceId: 310000,
          candidateHasHealthCertificate: 1,
        }),
      ).toBeNull();
      expect(
        runBookingGuards({
          job: restrictedJob(),
          name: realName,
          interviewTime,
          candidateHasHealthCertificate: 1,
        }),
      ).toBeNull();
    });
  });

  describe('student conflict · batch_6a559b7ace406a6aeedf1f8b_1783995721291', () => {
    it('blocks booking when 岗位仅接受社会人士 but candidate is student', () => {
      const job = makeJob({ hiringRequirement: { figure: '社会人士' } });
      const result = runBookingGuards({
        job,
        name: realName,
        interviewTime,
        candidateIsStudent: true,
        candidateHasHealthCertificate: 1,
      });

      expect(result).not.toBeNull();
      expect(result?._outcome).toContain('学生身份');
      expect(result?.errorType).toBe('booking.rejected');
    });

    it('passes when candidate is social or job accepts both identities', () => {
      expect(
        runBookingGuards({
          job: makeJob({ hiringRequirement: { figure: '社会人士' } }),
          name: realName,
          interviewTime,
          candidateIsStudent: false,
          candidateHasHealthCertificate: 1,
        }),
      ).toBeNull();
      expect(
        runBookingGuards({
          job: makeJob({ hiringRequirement: { figure: '学生,社会人士' } }),
          name: realName,
          interviewTime,
          candidateIsStudent: true,
          candidateHasHealthCertificate: 1,
        }),
      ).toBeNull();
    });
  });

  it('combines: blocks on gender conflict before reaching healthCert check', () => {
    const job = makeJob({
      hiringRequirement: {
        basicPersonalRequirements: { genderRequirement: '女' },
        certificate: { healthCertificate: '必须先办健康证' },
      },
    });
    const result = runBookingGuards({
      job,
      name: realName,
      interviewTime,
      candidateGenderId: 1,
      candidateHasHealthCertificate: 1,
    });
    expect(result).not.toBeNull();
    expect(result?._outcome).toContain('性别');
  });
});
