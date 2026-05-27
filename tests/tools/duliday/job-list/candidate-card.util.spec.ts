import {
  renderCandidateCard,
  renderCandidateCardsBanner,
} from '@tools/duliday/job-list/candidate-card.util';

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    basicInfo: {
      jobId: 101,
      brandName: '肯德基',
      jobName: '服务员',
      storeInfo: {
        storeName: '上海静安寺店',
        storeCityName: '上海',
        storeRegionName: '静安区',
      },
    },
    _distanceKm: 2.31,
    workTime: {
      dailyShiftSchedule: {
        arrangementType: '固定排班制',
        fixedScheduleList: [{ fixedShiftStartTime: '11:00', fixedShiftEndTime: '15:00' }],
      },
      weekWorkTime: { perWeekWorkDays: 4 },
    },
    jobSalary: {
      salaryScenarioList: [
        {
          comprehensiveSalary: {
            minComprehensiveSalary: 24,
            maxComprehensiveSalary: 29,
            comprehensiveSalaryUnit: '元/时',
          },
        },
      ],
    },
    hiringRequirement: {
      basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
      certificate: { healthCertificate: '入职前办好健康证' },
    },
    ...overrides,
  };
}

describe('renderCandidateCard', () => {
  it('returns null when basicInfo missing', () => {
    expect(renderCandidateCard({})).toBeNull();
    expect(renderCandidateCard(null)).toBeNull();
  });

  it('includes brand + store + distance in head', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toContain('肯德基（静安寺店）');
    expect(card.oneLine).toContain('2.3km');
  });

  it('includes shift + weekly day count', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toContain('班次');
    expect(card.oneLine).toContain('每周 4 天');
  });

  it('includes salary range', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toContain('24-29 元/时');
  });

  it('includes age + healthCert in requirement', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toContain('18-50');
    expect(card.oneLine).toContain('入职前办食品健康证');
  });

  it('emits stair salary when hasStairSalary=是', () => {
    const job = makeJob({
      jobSalary: {
        salaryScenarioList: [
          {
            comprehensiveSalary: {
              minComprehensiveSalary: 24,
              maxComprehensiveSalary: 29,
              comprehensiveSalaryUnit: '元/时',
            },
            hasStairSalary: '是',
            stairSalaries: [
              { salary: 25, salaryUnit: '元/时', fullWorkTime: 40, fullWorkTimeUnit: '小时' },
            ],
          },
        ],
      },
    });
    const card = renderCandidateCard(job, 0)!;
    expect(card.oneLine).toContain('阶梯');
    expect(card.oneLine).toContain('满 40小时→25元/时');
  });

  it('emits 仅限女 when gender=female', () => {
    const job = makeJob({
      hiringRequirement: {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '女' },
        certificate: { healthCertificate: '入职前办好健康证' },
      },
    });
    const card = renderCandidateCard(job, 0)!;
    expect(card.oneLine).toContain('仅限女');
  });

  it('emits household exclude when 不要 type set', () => {
    const job = makeJob({
      hiringRequirement: {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        requirementsForHometown: {
          nativePlaceRequirementType: '不要',
          nativePlaces: ['东三省'],
        },
        certificate: { healthCertificate: '入职前办好健康证' },
      },
    });
    const card = renderCandidateCard(job, 0)!;
    expect(card.oneLine).toContain('不要东三省');
  });

  it('omits absent fields gracefully (no "undefined" string)', () => {
    const job = {
      basicInfo: {
        jobId: 99,
        brandName: '麦当劳',
        jobName: '服务员',
        storeInfo: { storeName: '日月光店' },
      },
    };
    const card = renderCandidateCard(job, 0)!;
    expect(card.oneLine).not.toContain('undefined');
    expect(card.oneLine).not.toContain('null');
    expect(card.oneLine).toContain('麦当劳（日月光店）');
  });

  it('numbers card index from 1 when index provided', () => {
    const card = renderCandidateCard(makeJob(), 2)!;
    expect(card.oneLine.startsWith('3.')).toBe(true);
    expect(card.multiLine.startsWith('3.')).toBe(true);
  });

  it('multiLine has shift / salary / requirement each on own line', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    const lines = card.multiLine.split('\n');
    expect(lines[0]).toContain('肯德基');
    expect(lines.some((l) => l.includes('班次：'))).toBe(true);
    expect(lines.some((l) => l.includes('薪资：'))).toBe(true);
    expect(lines.some((l) => l.includes('要求：'))).toBe(true);
  });
});

describe('renderCandidateCardsBanner', () => {
  it('returns empty when jobs array empty', () => {
    expect(renderCandidateCardsBanner([])).toBe('');
  });

  it('renders all jobs as quoted block with header', () => {
    const banner = renderCandidateCardsBanner([makeJob(), makeJob({ basicInfo: { jobId: 102, brandName: '麦当劳', jobName: '服务员', storeInfo: { storeName: '日月光店' } } })]);
    expect(banner).toContain('推荐对话用模板');
    expect(banner).toContain('不得删除或合并');
    expect(banner).toMatch(/> .*1\..*肯德基/);
    expect(banner).toMatch(/> .*2\..*麦当劳/);
  });

  it('quotes each card line with leading "> "', () => {
    const banner = renderCandidateCardsBanner([makeJob()]);
    const lines = banner.split('\n').filter(Boolean);
    // 除头部说明行 + 卡片行外，每行都应以 "> " 开头
    expect(lines.every((l) => l.startsWith('>'))).toBe(true);
  });
});
