import {
  renderCandidateCard,
  renderCandidateCardsBanner,
} from '@tools/job-list/candidate-card.util';

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    basicInfo: {
      jobId: 101,
      brandName: '肯德基',
      jobName: '肯德基-静安寺店-服务员-小时工',
      jobNickName: '服务员',
      storeInfo: {
        storeName: '上海静安寺店',
        storeCityName: '上海',
        storeRegionName: '静安区',
      },
    },
    _distanceKm: 2.31,
    workTime: {
      dayWorkTime: {
        arrangementType: '满足其中一个时段即可安排上岗',
        combinedArrangement: [
          { combinedArrangementStartTime: '11:00', combinedArrangementEndTime: '15:00' },
        ],
        fixedTime: null,
      },
      weekAndMonthWorkTime: { perWeekWorkDays: 4 },
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

/** 两段班次的 workTime；arrangementType 决定"两段都要上"还是"可上一个班次"。 */
function twoShifts(arrangementType: string, slots: Array<[string, string]>) {
  return {
    dayWorkTime: {
      arrangementType,
      combinedArrangement: slots.map(([start, end]) => ({
        combinedArrangementStartTime: start,
        combinedArrangementEndTime: end,
      })),
      fixedTime: null,
    },
  };
}

function ageAndHealthCert(minAge: number, maxAge: number) {
  return {
    basicPersonalRequirements: { minAge, maxAge, genderRequirement: '不限' },
    certificate: { healthCertificate: '入职前办好健康证' },
  };
}

describe('renderCandidateCard', () => {
  it('returns null when basicInfo missing', () => {
    expect(renderCandidateCard({})).toBeNull();
    expect(renderCandidateCard(null)).toBeNull();
  });

  it('includes brand + store + position + distance in head', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.multiLine.split('\n')[0]).toBe('1. **肯德基（静安寺店） - 服务员，2.3km**');
  });

  it('includes shift + weekly day count', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toContain('11:00-15:00');
    expect(card.oneLine).toContain('每周 4 天');
  });

  it('renders 做一休一 as a rotation instead of 每周 1 天', () => {
    const job = makeJob({
      workTime: { weekAndMonthWorkTime: { perWeekWorkDays: 1, perWeekRestDays: 1 } },
    });
    const card = renderCandidateCard(job, 0)!;
    expect(card.oneLine).not.toContain('每周 1 天');
    expect(card.oneLine).toContain('做1休1轮换（平均每周约 3 天，工作日也要排班）');
  });

  it('includes salary range without 综合薪资 prefix when laborForm is absent', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toContain('薪资：24-29元/时');
    expect(card.oneLine).not.toContain('综合薪资');
  });

  it('includes age + healthCert in requirement', () => {
    const card = renderCandidateCard(makeJob(), 0)!;
    expect(card.oneLine).toMatch(/要求：18-50/);
    expect(card.oneLine).toContain('入职前办食品健康证');
  });

  describe('salary line by job type (产品需求三类模板)', () => {
    it('兼职 & 有阶梯：基础时薪 + 各档门槛 + 括注口径 + 结算，不带节假日/加班', () => {
      const job = makeJob({
        basicInfo: {
          jobId: 529410,
          brandName: '必胜客',
          jobNickName: '内场/外场',
          laborForm: '兼职',
          partTimeJobType: '小时工',
          storeInfo: { storeName: '马驹桥店', storeCityName: '北京' },
        },
        _distanceKm: 3.7,
        workTime: twoShifts('组合排班制', [
          ['08:00', '14:00'],
          ['15:00', '23:00'],
        ]),
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              salaryPeriod: '日结算',
              payday: '当日结',
              hasStairSalary: '有阶梯薪资',
              basicSalary: { basicSalary: 19, basicSalaryUnit: '元/时' },
              comprehensiveSalary: {
                minComprehensiveSalary: 2000,
                maxComprehensiveSalary: 4000,
                comprehensiveSalaryUnit: '元/月',
              },
              stairSalaries: [
                {
                  description: '超出后所有工时按照新的薪资标准计算',
                  perTimeUnit: '不限',
                  fullWorkTime: 100,
                  fullWorkTimeUnit: '累计工作小时',
                  salary: 21,
                  salaryUnit: '元/时',
                },
                {
                  description: '超出后所有工时按照新的薪资标准计算',
                  perTimeUnit: '不限',
                  fullWorkTime: 190,
                  fullWorkTimeUnit: '累计工作小时',
                  salary: 23,
                  salaryUnit: '元/时',
                },
              ],
              holidaySalary: {
                holidaySalaryType: '固定薪资',
                holidayFixedSalary: 38,
                holidayFixedSalaryUnit: '元/时',
              },
              overtimeSalary: { overtimeSalaryType: '无薪资' },
            },
          ],
        },
        hiringRequirement: ageAndHealthCert(18, 55),
      });
      const card = renderCandidateCard(job, 0)!;
      const lines = card.multiLine.split('\n').map((l) => l.trim());
      expect(lines[0]).toBe('1. **必胜客（马驹桥店） - 内场/外场，3.7km**');
      expect(lines[1]).toBe('班次：08:00-14:00 / 15:00-23:00');
      expect(lines[2]).toBe(
        '薪资：基础19元/时，满100小时21元/时，满190小时23元/时，超出后所有工时按照新的薪资标准计算，日结，当日结',
      );
      expect(lines[3]).toBe('要求：18-55岁，入职前办食品健康证');
      expect(card.oneLine).not.toContain('2000-4000');
      expect(card.oneLine).not.toContain('法定节假日');
      expect(card.oneLine).not.toContain('累计工作小时');
    });

    it('兼职 & 无阶梯：时薪 + 法定节假日 + 结算，无薪资的加班项省略', () => {
      const job = makeJob({
        basicInfo: {
          jobId: 2,
          brandName: '达美乐',
          jobNickName: '兼职服务员',
          laborForm: '兼职',
          storeInfo: { storeName: '总部三路店', storeCityName: '杭州' },
        },
        _distanceKm: 3.7,
        workTime: twoShifts('固定排班', [
          ['08:00', '14:00'],
          ['15:00', '23:00'],
        ]),
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              salaryPeriod: '月结算',
              payday: '5号',
              hasStairSalary: '无阶梯薪资',
              basicSalary: { basicSalary: 13.8, basicSalaryUnit: '元/时' },
              comprehensiveSalary: {
                minComprehensiveSalary: 1000,
                maxComprehensiveSalary: 3000,
                comprehensiveSalaryUnit: '元/月',
              },
              holidaySalary: {
                holidaySalaryType: '固定薪资',
                holidayFixedSalary: 34.5,
                holidayFixedSalaryUnit: '元/时',
              },
              overtimeSalary: { overtimeSalaryType: '无薪资' },
            },
          ],
        },
        hiringRequirement: ageAndHealthCert(20, 38),
      });
      const lines = renderCandidateCard(job, 0)!
        .multiLine.split('\n')
        .map((l) => l.trim());
      expect(lines[2]).toBe('薪资：13.8元/时，法定节假日34.5元/时，月结，5号发薪');
      expect(lines[3]).toBe('要求：20-38岁，入职前办食品健康证');
    });

    it('全职：综合薪资 + 法定节假日倍数 + 加班倍数 + 结算', () => {
      const job = makeJob({
        basicInfo: {
          jobId: 529402,
          brandName: '奥乐齐',
          jobNickName: '全职店员',
          laborForm: '全职',
          storeInfo: { storeName: '杭州庆春银泰', storeCityName: '杭州' },
        },
        _distanceKm: 3.7,
        workTime: twoShifts('组合排班制', [
          ['05:00', '14:00'],
          ['14:00', '23:00'],
        ]),
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              salaryPeriod: '月结算',
              payday: '15号',
              hasStairSalary: '无阶梯薪资',
              basicSalary: { basicSalary: 5500, basicSalaryUnit: '元/月' },
              comprehensiveSalary: {
                minComprehensiveSalary: 5000,
                maxComprehensiveSalary: 7000,
                comprehensiveSalaryUnit: '元/月',
              },
              holidaySalary: { holidaySalaryType: '多倍薪资', holidaySalaryMultiple: 3 },
              overtimeSalary: { overtimeSalaryType: '多倍薪资', overtimeSalaryMultiple: 1.5 },
              otherSalary: { commission: '', attendanceSalary: null, performance: '' },
            },
          ],
        },
        hiringRequirement: ageAndHealthCert(20, 40),
      });
      const lines = renderCandidateCard(job, 0)!
        .multiLine.split('\n')
        .map((l) => l.trim());
      expect(lines[2]).toBe(
        '薪资：综合薪资5000-7000元/月，法定节假日3倍，加班1.5倍，月结，15号发薪',
      );
      expect(lines[3]).toBe('要求：20-40岁，入职前办食品健康证');
      expect(lines[2]).not.toContain('5500');
    });

    it('全职奖金项只上标签，四个来源（提成/全勤/绩效/奖金说明）都认', () => {
      const job = makeJob({
        basicInfo: { jobId: 3, brandName: '奥乐齐', laborForm: '全职', storeInfo: {} },
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              comprehensiveSalary: {
                minComprehensiveSalary: 5000,
                maxComprehensiveSalary: 7000,
                comprehensiveSalaryUnit: '元/月',
              },
              otherSalary: { commission: '按销售额 2%', attendanceSalary: 200, performance: '' },
              bonusDesc: '季度奖金另计',
            },
          ],
        },
      });
      const card = renderCandidateCard(job, 0)!;
      expect(card.oneLine).toContain('另有提成、全勤奖、奖金');
      expect(card.oneLine).not.toContain('2%');
      expect(card.oneLine).not.toContain('200');
    });

    it('全职 & 有阶梯（兜底象限）：全职模板后接阶梯段', () => {
      const job = makeJob({
        basicInfo: { jobId: 4, brandName: '某品牌', laborForm: '全职', storeInfo: {} },
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              hasStairSalary: '有阶梯薪资',
              comprehensiveSalary: {
                minComprehensiveSalary: 5000,
                maxComprehensiveSalary: 6000,
                comprehensiveSalaryUnit: '元/月',
              },
              stairSalaries: [
                {
                  fullWorkTime: 100,
                  fullWorkTimeUnit: '累计工作小时',
                  salary: 21,
                  salaryUnit: '元/时',
                },
              ],
            },
          ],
        },
      });
      expect(renderCandidateCard(job, 0)!.oneLine).toContain(
        '综合薪资5000-6000元/月，满100小时21元/时',
      );
    });

    it('兼职基础缺失时回落综合区间', () => {
      const job = makeJob({
        basicInfo: { jobId: 5, brandName: '必胜客', laborForm: '兼职', storeInfo: {} },
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              basicSalary: null,
              comprehensiveSalary: {
                minComprehensiveSalary: 2000,
                maxComprehensiveSalary: 4000,
                comprehensiveSalaryUnit: '元/月',
              },
            },
          ],
        },
      });
      expect(renderCandidateCard(job, 0)!.oneLine).toContain('2000-4000元/月');
    });

    it('正式方案优先于排在前面的培训期方案', () => {
      const job = makeJob({
        basicInfo: { jobId: 6, brandName: '必胜客', laborForm: '兼职', storeInfo: {} },
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '培训期',
              salaryPeriod: '月结算',
              payday: '10号',
              basicSalary: { basicSalary: 15, basicSalaryUnit: '元/时' },
            },
            {
              salaryType: '正式',
              salaryPeriod: '日结算',
              payday: '次日结',
              basicSalary: { basicSalary: 19, basicSalaryUnit: '元/时' },
            },
          ],
        },
      });
      const card = renderCandidateCard(job, 0)!;
      expect(card.oneLine).toContain('19元/时，日结，次日结');
      expect(card.oneLine).not.toContain('15元/时');
      expect(card.oneLine).not.toContain('10号');
    });

    it('周结发薪日拼"发薪"，节假日固定薪资保留原单位（元/日）', () => {
      const job = makeJob({
        basicInfo: { jobId: 7, brandName: '肯德基', laborForm: '兼职', storeInfo: {} },
        jobSalary: {
          salaryScenarioList: [
            {
              salaryType: '正式',
              salaryPeriod: '周结算',
              payday: '每周三',
              hasStairSalary: '无阶梯薪资',
              basicSalary: { basicSalary: 13.2, basicSalaryUnit: '元/时' },
              holidaySalary: {
                holidaySalaryType: '固定薪资',
                holidayFixedSalary: 50,
                holidayFixedSalaryUnit: '元/日',
              },
            },
          ],
        },
      });
      expect(renderCandidateCard(job, 0)!.oneLine).toContain(
        '13.2元/时，法定节假日50元/日，周结，每周三发薪',
      );
    });
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
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('肯德基');
    expect(lines[1]).toContain('班次：11:00-15:00');
    expect(lines[2]).toContain('薪资：24-29元/时');
    expect(lines[3]).toContain('要求：');
  });

  it('appends remarks as an extra line when welfare memo exists', () => {
    const card = renderCandidateCard(makeJob({ welfare: { memo: '提供员工餐' } }), 0)!;
    const lines = card.multiLine.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain('福利备注：提供员工餐');
  });
});

describe('renderCandidateCardsBanner', () => {
  it('returns empty when jobs array empty', () => {
    expect(renderCandidateCardsBanner([])).toBe('');
  });

  it('renders all jobs as quoted candidate-safe cards without internal template metadata', () => {
    const banner = renderCandidateCardsBanner([
      makeJob(),
      makeJob({
        basicInfo: {
          jobId: 102,
          brandName: '麦当劳',
          jobName: '服务员',
          storeInfo: { storeName: '日月光店' },
        },
      }),
    ]);
    expect(banner).not.toContain('模板');
    expect(banner).not.toContain('固定格式');
    expect(banner).not.toContain('示例');
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
