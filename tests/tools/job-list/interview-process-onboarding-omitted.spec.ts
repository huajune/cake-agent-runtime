import { buildJobPolicyAnalysis } from '@tools/job-list/job-policy-parser';
import { formatJobsToMarkdown, type ProgressiveDisclosureFlags } from '@tools/job-list/render.util';
import type { JobDetail } from '@sponge/sponge.types';

/**
 * 2026-09-16 裁定（生产 chat 6a9f7db6ce406a6aee13b137）：面试结束之后的环节不归 Agent。
 * 海绵「试工培训与上岗」区块（processDesc / probationWork / training）不得进入模型可见的岗位卡片，
 * 「面试备注」只保留一轮面试描述；确定性抽取仍能读到 processDesc 全文。
 */
const FLAGS: ProgressiveDisclosureFlags = {
  includeBasicInfo: true,
  includeJobSalary: false,
  includeWelfare: false,
  includeHiringRequirement: false,
  includeWorkTime: false,
  includeInterviewProcess: true,
};

function buildJob(): JobDetail {
  return {
    basicInfo: {
      jobId: 526380,
      jobName: '必胜客-新辰里-内场/外场-小时工',
      brandName: '必胜客',
      storeInfo: { storeName: '新辰里', storeCityName: '北京市', storeAddress: '北辰东路8号院' },
    },
    interviewProcess: {
      interviewTotal: 1,
      firstInterview: {
        firstInterviewWay: 'AI面试',
        firstInterviewDesc: 'AI面试，请让候选人提前一天完成AI面试',
        interviewTimeMode: '周期',
      },
      processDesc:
        '线下面试通过后，店长会直接加微信与员工沟通试工时间，试工通过后+琪琪微信办理入职',
      probationWork: {
        probationWorkPeriod: 2,
        probationWorkPeriodUnit: '小时',
        probationWorkAssessment: '实操',
      },
      training: { trainingPeriod: 1, trainingPeriodUnit: '天', trainingDesc: '岗前培训' },
    },
  } as unknown as JobDetail;
}

describe('岗位卡片不渲染面试后环节（试工/培训/入职流程）', () => {
  it('omits processDesc / probation / training from the model-visible card and the 面试备注 line', () => {
    const md = formatJobsToMarkdown([buildJob()], 1, 1, 10, FLAGS);

    expect(md).toContain('AI面试');
    expect(md).not.toContain('流程说明');
    expect(md).not.toContain('试工信息');
    expect(md).not.toContain('培训信息');
    expect(md).not.toContain('办理入职');
    expect(md).not.toContain('琪琪');
  });

  it('keeps processDesc inside the deterministic interviewRemark but not in the display variant', () => {
    const policy = buildJobPolicyAnalysis(buildJob());

    expect(policy.normalizedRequirements.interviewRemark).toContain('办理入职');
    expect(policy.normalizedRequirements.interviewRemarkDisplay).toContain('AI面试');
    expect(policy.normalizedRequirements.interviewRemarkDisplay).not.toContain('办理入职');
  });
});
