import {
  formatJobsToMarkdown,
  inferStudentRequirement,
  ProgressiveDisclosureFlags,
} from '@tools/duliday/job-list/render.util';
import { JobPolicyAnalysis } from '@tools/utils/job-policy-parser';

describe('job-list render util', () => {
  const minimalFlags: ProgressiveDisclosureFlags = {
    includeBasicInfo: true,
    includeJobSalary: false,
    includeWelfare: false,
    includeHiringRequirement: false,
    includeWorkTime: false,
    includeInterviewProcess: false,
  };

  it('renders minimal markdown with one-line jobs and pagination hint', () => {
    const markdown = formatJobsToMarkdown([makeJob(1)], 3, 1, 1, minimalFlags);

    expect(markdown).toContain('# 在招岗位（共 3 个）');
    expect(markdown).toContain('本工具只查询岗位，**没有提交预约**');
    expect(markdown).toContain('只有 `duliday_interview_booking` 返回 success=true');
    expect(markdown).toContain('1. **肯德基 - 服务员** | 静安寺店 | 上海市静安区xx路 | 距离 2.3km');
    expect(markdown).toContain('_还有 2 个岗位未显示');
  });

  it('renders same-brand multi-store warning before detailed job sections', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeJobSalary: true,
      includeHiringRequirement: true,
      includeWorkTime: true,
    };
    const brandGroups = [
      {
        brandName: '肯德基',
        brandId: 100,
        totalStoreCount: 2,
        nearestStores: [
          {
            storeName: '静安寺店',
            jobId: 1,
            jobName: '餐饮',
            distanceKm: 2.3,
            wageRange: '24-29 元/时',
            shiftSummary: '11:00-15:00',
            requirementSummary: '18-45岁',
            displayLine: '肯德基（静安寺店，2.3km，11:00-15:00，24-29 元/时，18-45岁）',
          },
          {
            storeName: '日月光店',
            jobId: 2,
            jobName: '餐饮',
            distanceKm: 5.1,
            wageRange: '24-29 元/时',
            shiftSummary: '11:00-15:00',
            requirementSummary: null,
            displayLine: '肯德基（日月光店，5.1km，11:00-15:00，24-29 元/时）',
          },
        ],
      },
    ];

    const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, flags, brandGroups);

    expect(markdown).toContain('⚠️ 同品牌多门店');
    expect(markdown).toContain('肯德基（静安寺店，2.3km，11:00-15:00，24-29 元/时，18-45岁）');
    expect(markdown).toContain('### 约面重点');
    expect(markdown).toContain('- **工作班次**:');
    expect(markdown).toContain('### 薪资信息');
    expect(markdown).toContain('### 招聘要求');
    expect(markdown).toContain('### 工作时间');
    expect(markdown.indexOf('⚠️ 同品牌多门店')).toBeLessThan(markdown.indexOf('## 1. 服务员'));
  });

  it('treats missing student restriction as no extra student hard gate', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeHiringRequirement: true,
    };
    const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, flags);

    expect(markdown).toContain('未标注学生限制（按无额外学生硬限制处理）');
    expect(markdown).not.toContain('需确认');
  });

  it('marks insurance as sensitive in welfare markdown instead of ordinary active welfare', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeWelfare: true,
    };
    const job = makeJob(1) as ReturnType<typeof makeJob> & { welfare?: unknown };
    job.welfare = {
      haveInsurance: '公司购买',
      catering: '包吃',
    };

    const markdown = formatJobsToMarkdown([job], 1, 1, 10, flags);

    expect(markdown).toContain('保险/社保严禁主动提及');
    expect(markdown).toContain(
      '- **保险（敏感，仅候选人主动问时可答；主动推荐/福利介绍严禁提）**: 公司购买',
    );
    expect(markdown).toContain('- **餐饮**: 包吃');
    expect(markdown).not.toContain('- **保险**: 公司购买');
  });

  // badcase umkgixpq：拉瓦萨咖啡师实际要求 3 个月经验，海绵下发
  // minWorkTime=3 / minWorkTimeUnit=1（数字枚举 id），旧渲染拼成 "3 1"，
  // 模型读不懂就忽略了该条件，对候选人答"这家接受无经验"。
  describe('minimum work experience rendering', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeHiringRequirement: true,
    };

    const jobWithExperience = (unit: unknown) => {
      const job = makeJob(1) as Record<string, unknown>;
      const hiring = job.hiringRequirement as Record<string, unknown>;
      hiring.competencyRequirements = { minWorkTime: 3, minWorkTimeUnit: unit };
      return job;
    };

    it('never renders a bare numeric unit id as if it were a unit', () => {
      const markdown = formatJobsToMarkdown([jobWithExperience(1)], 1, 1, 10, flags);

      expect(markdown).not.toContain('最低工作经验**: 3 1');
      expect(markdown).toContain('最低工作经验');
      expect(markdown).toContain('单位未下发');
      // 关键：经验门槛存在这个事实必须传达给模型，否则会答"无经验也可以"。
      expect(markdown).toContain('不得对候选人称"无经验也可以"');
    });

    it('renders a readable text unit as-is without the caveat', () => {
      const markdown = formatJobsToMarkdown([jobWithExperience('个月')], 1, 1, 10, flags);

      expect(markdown).toContain('- **最低工作经验**: 3 个月');
      expect(markdown).not.toContain('单位未下发');
    });

    it('omits the line entirely when no experience requirement is set', () => {
      const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, flags);

      expect(markdown).not.toContain('最低工作经验');
    });
  });

  // 海绵 2026-08-06 新增 basicInfo.cooperationMode（BPO/RPO），决定发薪主体与签约主体。
  // 渲染层只输出结论、不让模型自己记映射；裸值仅作 🔒 内部标注。
  describe('合作模式 → 发薪/签约主体结论', () => {
    // 只开 includeBasicInfo 会命中 isMinimalMode（走一行式摘要，不渲染基本信息段），
    // 所以再开一个开关强制进详情模式。
    const basicFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: true,
      includeWelfare: false,
      includeHiringRequirement: false,
      includeWorkTime: false,
      includeInterviewProcess: false,
    };

    const withMode = (mode: unknown) => {
      const job = makeJob(1);
      (job.basicInfo as Record<string, unknown>).cooperationMode = mode;
      return formatJobsToMarkdown([job], 1, 1, 10, basicFlags);
    };

    it('BPO：发薪与签约都可自答', () => {
      const markdown = withMode('BPO');
      expect(markdown).toContain('**发薪主体**: 由独立客发薪');
      expect(markdown).toContain('可直接答，不必转人工');
      expect(markdown).toContain('与独立客签约，形式是**灵活用工协议**');
      expect(markdown).not.toContain('无法自答');
    });

    it('RPO：签约主体可答但发薪主体必须转人工（两条规则的 RPO 分支不同）', () => {
      const markdown = withMode('RPO');
      expect(markdown).toContain('发薪方两种都有可能');
      expect(markdown).toContain('request_handoff(reasonCode="salary_admin_inquiry")');
      expect(markdown).toContain('与**客户（品牌方）**签约');
      expect(markdown).toContain('是协议还是合同取决于客户');
      // 不得把 BPO 的独立客结论泄漏到 RPO
      expect(markdown).not.toContain('由独立客发薪');
    });

    it('两种模式都标 🔒 禁止对候选人提及术语', () => {
      for (const mode of ['BPO', 'RPO']) {
        const markdown = withMode(mode);
        expect(markdown).toContain('严禁对候选人提及 "BPO/RPO/合作模式" 字样');
      }
    });

    it('大小写/空格容错', () => {
      expect(withMode(' bpo ')).toContain('由独立客发薪');
      expect(withMode('rpo')).toContain('发薪方两种都有可能');
    });

    it('字段缺失/空/未知值时整段不渲染（海绵发布前老数据）', () => {
      // 发布前岗位没有该键，此时不得输出任何发薪/签约结论，
      // 由 candidate-consultation.md 的兜底规则转人工。
      for (const mode of [undefined, null, '', '   ', 'UNKNOWN']) {
        const markdown = withMode(mode);
        expect(markdown).not.toContain('合作模式');
        expect(markdown).not.toContain('发薪主体');
        expect(markdown).not.toContain('签约主体');
      }
    });
  });

  // 2026-08-06 运营口径：发薪日默认「次月发上月」，没有当月发当月的情况。
  // 候选人高频追问"X 号上班当月能不能发薪"，裸"15号发薪"会被读成当月。
  describe('月结发薪日归属月份标注', () => {
    const salaryFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: true,
      includeWelfare: false,
      includeHiringRequirement: false,
      includeWorkTime: false,
      includeInterviewProcess: false,
    };

    const withSalary = (scenario: Record<string, unknown>) => {
      const job = makeJob(1);
      job.jobSalary = { salaryScenarioList: [scenario] } as typeof job.jobSalary;
      return formatJobsToMarkdown([job], 1, 1, 10, salaryFlags);
    };

    it('月结 + 具体几号时标注次月发上月', () => {
      const markdown = withSalary({ salaryType: '小时工', salaryPeriod: '月结算', payday: '15号' });
      expect(markdown).toContain('15号发薪（次月15号发上月工资，无当月发当月）');
    });

    it('周结不加标注（该口径只适用月结）', () => {
      const markdown = withSalary({
        salaryType: '小时工',
        salaryPeriod: '周结算',
        payday: '每周三',
      });
      expect(markdown).toContain('每周三发薪');
      expect(markdown).not.toContain('发上月工资');
    });

    it('月结但 payday 非"N号"形态时不臆造归属月份', () => {
      const markdown = withSalary({
        salaryType: '小时工',
        salaryPeriod: '月结算',
        payday: '月底',
      });
      expect(markdown).toContain('月底发薪');
      expect(markdown).not.toContain('发上月工资');
    });

    it('缺 salaryPeriod 时不标注（无法判定是否月结）', () => {
      const markdown = withSalary({ salaryType: '小时工', payday: '10号' });
      expect(markdown).toContain('10号发薪');
      expect(markdown).not.toContain('发上月工资');
    });
  });

  describe('hard-requirements banner', () => {
    const detailFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: true,
      includeWorkTime: false,
      includeInterviewProcess: false,
    };

    it('does not render banner when all hard requirements unspecified/any', () => {
      const job = makeJob(1);
      // makeJob 默认 cert.healthCertificate="食品健康证" 会触发 before_onboard banner，
      // 这里覆盖为空，验证 unspecified 路径不渲染。
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);
      expect(markdown).not.toContain('候选人硬性约束');
    });

    it('renders banner for gender + household exclude + health cert before_interview', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '女' },
        requirementsForHometown: {
          nativePlaceRequirementType: '不要',
          nativePlaces: ['东三省', '河南'],
        },
        certificate: { healthCertificate: '必须先办健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('候选人硬性约束');
      expect(markdown).toContain('仅限女');
      expect(markdown).toContain('不接受 东三省/河南');
      expect(markdown).toContain('面试前必须持有健康证');
      const bannerIdx = markdown.indexOf('候选人硬性约束');
      const titleIdx = markdown.indexOf('## 1.');
      expect(bannerIdx).toBeGreaterThan(titleIdx);
    });

    // 2026-08-06 badcase（chat 6a744a86，记录 249939）：banner 里写着"不掌握候选人户籍时
    // 按敏感门槛话术委婉了解后内部判断"，模型照做，发出「这家对户籍有要求，方便问一下你
    // 老家是哪里的吗」。banner 与岗位数据同在当轮上下文、比系统提示词更贴近决策，敏感门槛
    // 文案只准写禁令、不准派采集动作——这条钉死该边界，防止后人再把"先确认"写回来。
    it('户籍 banner 只给禁令，不得指派任何向候选人采集籍贯的动作', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        requirementsForHometown: {
          nativePlaceRequirementType: '不要',
          nativePlaces: ['上海市'],
        },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('不接受 上海市');
      expect(markdown).toContain('严禁外显');
      // 采集动作的历史措辞与其近亲，一个都不许再出现
      for (const directive of ['委婉了解', '先确认', '确认后再', '问清楚', '了解后内部判断']) {
        expect(markdown).not.toContain(directive);
      }
      // 反向要求必须在场：明确告诉模型"不要追问"，并指出兜底在别处
      expect(markdown).toContain('不要追问');
    });

    it('renders only health cert before_onboard when nothing else specified', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('候选人硬性约束');
      expect(markdown).toContain('入职前必须办妥健康证');
      expect(markdown).not.toContain('仅限女');
      expect(markdown).not.toContain('仅限男');
    });
  });

  describe('sensitive screening free-text notice', () => {
    const detailFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: true,
      includeWorkTime: false,
      includeInterviewProcess: true,
    };

    it('appends 🔒 notice when requirement free-text embeds household exclusion', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
        remark: '能吃苦耐劳，不要新疆西藏籍',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('不要新疆西藏籍');
      expect(markdown).toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('appends 🔒 notice when interview supplement embeds sensitive screening label', () => {
      const job = makeJob(1) as ReturnType<typeof makeJob> & { interviewProcess?: unknown };
      job.interviewProcess = {
        interviewSupplement: [{ interviewSupplement: '户籍（不要新疆西藏）' }],
      };
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      const interviewSection = markdown.slice(markdown.indexOf('### 面试流程'));
      expect(interviewSection).toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('does not duplicate notice when structured hometown warning already rendered', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        requirementsForHometown: {
          nativePlaceRequirementType: '不要',
          nativePlaces: ['东三省', '河南'],
        },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('上述民族/籍贯条件🔒仅供内部筛选');
      expect(markdown).not.toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('does not append notice for ordinary jobs', () => {
      const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, detailFlags);
      expect(markdown).not.toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('marks structured marriage and childbearing requirements as internal-only', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        marriageBearingAndSocialSecurity: {
          marriageBearingType: '限制',
          marriageBearing: '已婚已育',
        },
        certificate: { healthCertificate: '' },
        figure: '不限',
      } as typeof job.hiringRequirement;

      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('- **婚育要求**: 限制');
      expect(markdown).toContain('- **婚育状态**: 已婚已育');
      expect(markdown).toContain('户籍/籍贯/民族/专业/婚育等敏感筛选信息');
      expect(markdown).toContain('严禁向候选人展示或转述');
    });
  });

  describe('progressive disclosure (full-detail cap)', () => {
    const detailFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: true,
      includeWelfare: false,
      includeHiringRequirement: true,
      includeWorkTime: true,
      includeInterviewProcess: false,
    };

    it('renders full detail for all jobs when count <= cap (6)', () => {
      const jobs = [1, 2, 3, 4, 5, 6].map((id) => makeJob(id));
      const markdown = formatJobsToMarkdown(jobs, 6, 1, 10, detailFlags);

      // 6 个全文标题（## 1. ~ ## 6.），无摘要尾
      expect(markdown).toContain('## 1. 服务员');
      expect(markdown).toContain('## 6. 服务员');
      expect(markdown).not.toContain('### 更远的');
    });

    it('caps full detail to nearest 6 and summarizes the rest with jobId', () => {
      const jobs = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => makeJob(id));
      const markdown = formatJobsToMarkdown(jobs, 8, 1, 10, detailFlags);

      // 前 6 家全文
      expect(markdown).toContain('## 6. 服务员');
      // 第 7 家不再有全文详情标题
      expect(markdown).not.toContain('## 7. 服务员');
      // 摘要尾出现，带数量与 jobId 重查引导
      expect(markdown).toContain('### 更远的 2 家');
      expect(markdown).toContain('jobId:7');
      expect(markdown).toContain('jobId:8');
      // 摘要行带薪资（来自 formatSalarySummary）
      expect(markdown).toMatch(/7\. \*\*肯德基 - 服务员\*\*.*jobId:7/);
    });
  });

  it('infers student requirement from normalized policy text and field signals', () => {
    expect(inferStudentRequirement(makePolicy({ remark: '仅限非学生，需要已毕业' }))).toBe(
      '不接受学生',
    );
    expect(inferStudentRequirement(makePolicy({ demand: '学生优先报名' }))).toBe('学生优先');
    expect(
      inferStudentRequirement(makePolicy({ fieldSignalEvidence: '是否学生：学生也可报名' })),
    ).toBe('可接受学生');
    expect(inferStudentRequirement(makePolicy({}))).toBeNull();
  });
});

function makeJob(jobId: number) {
  return {
    basicInfo: {
      jobId,
      brandId: 100,
      brandName: '肯德基',
      jobName: '服务员',
      jobCategoryName: '餐饮',
      laborForm: '兼职',
      storeInfo: {
        storeId: 88,
        storeName: '上海静安寺店',
        storeCityName: '上海',
        storeRegionName: '静安区',
        storeAddress: '上海市静安区xx路',
      },
    },
    _distanceKm: 2.3,
    jobSalary: {
      salaryScenarioList: [
        {
          salaryType: '小时工',
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
      certificate: { healthCertificate: '食品健康证' },
      figure: '不限',
    },
    workTime: {
      employmentForm: '长期用工',
      weekAndMonthWorkTime: {
        arrangementCycleType: '每周',
        weekMonthArrangementMode: '做几休几',
        perWeekWorkDays: 6,
        perWeekRestDays: 1,
      },
      dayWorkTime: {
        arrangementType: '满足其中一个时段即可安排上岗',
        combinedArrangement: [
          { combinedArrangementStartTime: '18:00', combinedArrangementEndTime: '22:00' },
        ],
        fixedTime: null,
      },
    },
  };
}

function makePolicy(input: {
  remark?: string;
  interviewRemark?: string;
  demand?: string;
  fieldSignalEvidence?: string;
}): JobPolicyAnalysis {
  return {
    interviewWindows: [],
    fieldGuidance: {
      screeningFields: [],
      bookingSubmissionFields: [],
      bookingSubmissionSource: 'api_submission_contract',
      deferredSubmissionFields: [],
      recommendedAskNowFields: [],
      fieldSignals: input.fieldSignalEvidence
        ? [
            {
              field: '是否学生',
              sourceField: 'interview_supplement',
              evidence: input.fieldSignalEvidence,
              confidence: 'high',
            },
          ]
        : [],
    },
    normalizedRequirements: {
      genderRequirement: '不限',
      ageRequirement: '不限',
      educationRequirement: '未明确要求',
      healthCertificateRequirement: '未明确要求',
      healthCertGate: 'unknown',
      remark: input.remark ?? null,
      interviewRemark: input.interviewRemark ?? null,
      interviewSupplements: [],
    },
    interviewMeta: {
      method: null,
      address: null,
      demand: input.demand ?? null,
      timeHint: null,
      registrationDeadlineHint: null,
    },
    highlights: {
      requirementHighlights: [],
      timingHighlights: [],
    },
  };
}
