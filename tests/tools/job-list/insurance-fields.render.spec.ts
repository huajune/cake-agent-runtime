import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobDetailSchema } from '@sponge/sponge.types';
import { formatJobsToMarkdown, ProgressiveDisclosureFlags } from '@tools/job-list/render.util';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/sponge-jobs/insurance-fields.json'), 'utf8'),
) as { jobs: unknown[] };
const jobs = fixture.jobs.map((job) => JobDetailSchema.parse(job));
const flags: ProgressiveDisclosureFlags = {
  includeBasicInfo: true,
  includeJobSalary: false,
  includeWelfare: true,
  includeHiringRequirement: true,
  includeWorkTime: false,
  includeInterviewProcess: false,
};
const render = (job: unknown) => formatJobsToMarkdown([job], 1, 1, 1, flags);

describe('海绵真实保险字段到模型可见岗位文本', () => {
  it('保留独立日不购买与六项五险一金，不能压成无保险', () => {
    const job = jobs.find((j) => j.basicInfo?.jobId === 527946)!;
    const markdown = render(job);
    const items = ['公积金', '养老保险', '医疗保险', '失业保险', '工伤保险', '生育保险'];
    // 接口 schema 透传后，明细与速览必须都保留完整项目。
    expect(markdown).toContain(`五险一金明细（仅候选人主动问时可答）：${items.join('、')}`);
    expect(markdown).toContain(`**五险一金明细（仅候选人主动问时可答）**: ${items.join('、')}`);
    expect(markdown).toContain('不代表五险一金）：独立日不购买');
    expect(markdown).toContain('**社保准入要求**: 不限');
    expect(markdown).not.toContain('内部事实：无');
    // 新字段不进入“可直接转述”的推荐卡片，仍只供回答主动追问。
    expect(markdown.split('### 福利信息')[0]).not.toContain('公积金');
  });

  it.each([529782, 514952])('岗位 %i 的空明细不从购买设置或准入要求补成有/无', (id) => {
    const job = jobs.find((j) => j.basicInfo?.jobId === id)!;
    const markdown = render(job);
    expect(markdown).toContain('五险一金明细（仅候选人主动问时可答）：未明确（不能据此断言没有）');
    expect(markdown).toContain(String(job.welfare?.haveInsurance));
    expect(markdown).toContain(
      id === 529782 ? '**社保准入要求**: 不限' : '**社保准入要求**: 公司缴纳本地社保',
    );
    expect(markdown).not.toContain('内部事实：无');
  });

  it('只返回部分项目时不补全五险一金', () => {
    const job = jobs.find((j) => j.basicInfo?.jobId === 527946)!;
    const markdown = render({
      ...job,
      welfare: { ...job.welfare, insuranceFundList: ['医疗保险'] },
    });
    expect(markdown).toContain('**五险一金明细（仅候选人主动问时可答）**: 医疗保险');
    expect(markdown).not.toContain('养老保险');
    expect(markdown).not.toContain('公积金');
  });

  it('关闭福利分区时不泄漏明细，招聘要求仍是独立准入信息', () => {
    const job = jobs.find((j) => j.basicInfo?.jobId === 527946)!;
    const markdown = formatJobsToMarkdown([job], 1, 1, 1, { ...flags, includeWelfare: false });
    expect(markdown).not.toContain('公积金');
    expect(markdown).not.toContain('保险购买设置');
    expect(markdown).toContain('**社保准入要求**: 不限');
  });
});
