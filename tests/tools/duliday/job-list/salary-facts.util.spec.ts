import {
  extractSalaryFacts,
  renderSalaryFactsBanner,
} from '@tools/duliday/job-list/salary-facts.util';

describe('extractSalaryFacts', () => {
  it('returns all-false when salary missing/null/empty object', () => {
    expect(extractSalaryFacts(null).hasBaseSalary).toBe(false);
    expect(extractSalaryFacts(undefined).hasOvertimeBonus).toBe(false);
    expect(extractSalaryFacts({}).hasHolidayBonus).toBe(false);
    expect(extractSalaryFacts({ salaryScenarioList: [] }).hasComprehensiveSalary).toBe(false);
  });

  describe('comprehensive + base detection', () => {
    it('flags comprehensive when min or max present', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [
          {
            comprehensiveSalary: { minComprehensiveSalary: 24, maxComprehensiveSalary: 29 },
          },
        ],
      });
      expect(facts.hasComprehensiveSalary).toBe(true);
      expect(facts.hasBaseSalary).toBe(false);
    });

    it('flags base when basicSalary.basicSalary present', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ basicSalary: { basicSalary: 3200 } }],
      });
      expect(facts.hasBaseSalary).toBe(true);
    });
  });

  describe('stair salary detection', () => {
    it('flags when hasStairSalary=是', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ hasStairSalary: '是' }],
      });
      expect(facts.hasStairSalary).toBe(true);
    });

    it('flags when stairSalaries non-empty array', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ stairSalaries: [{ salary: 20 }] }],
      });
      expect(facts.hasStairSalary).toBe(true);
    });

    it('does not flag when hasStairSalary=否 and array empty', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ hasStairSalary: '否', stairSalaries: [] }],
      });
      expect(facts.hasStairSalary).toBe(false);
    });
  });

  describe('holiday/overtime bonus detection', () => {
    it('flags holiday when holidaySalaryType ≠ 无薪资', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ holidaySalary: { holidaySalaryType: '多倍薪资' } }],
      });
      expect(facts.hasHolidayBonus).toBe(true);
    });

    it('does not flag holiday when 无薪资', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ holidaySalary: { holidaySalaryType: '无薪资' } }],
      });
      expect(facts.hasHolidayBonus).toBe(false);
    });

    it('flags overtime independently', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [{ overtimeSalary: { overtimeSalaryType: '固定薪资' } }],
      });
      expect(facts.hasOvertimeBonus).toBe(true);
      expect(facts.hasHolidayBonus).toBe(false);
    });
  });

  describe('other bonuses', () => {
    it('flags commission/attendance/performance independently', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [
          {
            otherSalary: { commission: '5%', attendanceSalary: 200, performance: '月度评估' },
          },
        ],
      });
      expect(facts.hasCommission).toBe(true);
      expect(facts.hasAttendanceBonus).toBe(true);
      expect(facts.hasPerformance).toBe(true);
    });
  });

  describe('probation salary', () => {
    it('flags when probationSalary has salary or description', () => {
      expect(
        extractSalaryFacts({ probationSalary: { salary: 18, salaryUnit: '元/时' } })
          .hasProbationSalary,
      ).toBe(true);
      expect(
        extractSalaryFacts({ probationSalary: { salaryDescription: '前两周 18 元/时' } })
          .hasProbationSalary,
      ).toBe(true);
    });

    it('does not flag when probationSalary empty/null', () => {
      expect(extractSalaryFacts({ probationSalary: {} }).hasProbationSalary).toBe(false);
      expect(extractSalaryFacts({ probationSalary: null }).hasProbationSalary).toBe(false);
    });
  });

  describe('negotiable hint detection', () => {
    it('flags 面议/电议/详谈 anywhere in salary text fields', () => {
      expect(
        extractSalaryFacts({
          salaryScenarioList: [{ basicSalary: { basicSalary: '面议' } }],
        }).hasNegotiableHint,
      ).toBe(true);
      expect(
        extractSalaryFacts({
          salaryScenarioList: [{ otherSalary: { commission: '详谈' } }],
        }).hasNegotiableHint,
      ).toBe(true);
      expect(
        extractSalaryFacts({
          probationSalary: { salaryDescription: '电议确定' },
        }).hasNegotiableHint,
      ).toBe(true);
    });

    it('does not flag normal numeric salaries', () => {
      const facts = extractSalaryFacts({
        salaryScenarioList: [
          {
            comprehensiveSalary: { minComprehensiveSalary: 24, maxComprehensiveSalary: 29 },
            otherSalary: { commission: '5%' },
          },
        ],
      });
      expect(facts.hasNegotiableHint).toBe(false);
    });
  });
});

describe('renderSalaryFactsBanner', () => {
  it('returns empty string when all flags false', () => {
    const banner = renderSalaryFactsBanner(extractSalaryFacts({}));
    expect(banner).toBe('');
  });

  it('renders 速览 with present / absent split', () => {
    const banner = renderSalaryFactsBanner(
      extractSalaryFacts({
        salaryScenarioList: [
          {
            comprehensiveSalary: { minComprehensiveSalary: 24, maxComprehensiveSalary: 29 },
            otherSalary: { attendanceSalary: 200 },
          },
        ],
      }),
    );
    expect(banner).toContain('薪资字段速览');
    expect(banner).toContain('基础/综合薪资');
    expect(banner).toContain('全勤奖');
    expect(banner).toContain('节假日薪资差异');
    expect(banner).toContain('加班费');
    expect(banner).toContain('不得在 reply 里声称');
  });

  it('emits negotiable warning when hasNegotiableHint=true', () => {
    const banner = renderSalaryFactsBanner(
      extractSalaryFacts({
        salaryScenarioList: [{ basicSalary: { basicSalary: '面议' } }],
      }),
    );
    expect(banner).toContain('面议');
  });

  it('emits banner when only stair salary present', () => {
    const banner = renderSalaryFactsBanner(
      extractSalaryFacts({
        salaryScenarioList: [{ hasStairSalary: '是', stairSalaries: [{ salary: 20 }] }],
      }),
    );
    expect(banner).toContain('阶梯薪资');
  });
});
