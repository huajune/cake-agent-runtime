/**
 * 兼职群通知 — 真实数据 + AI 润色 + 固定尾部
 *
 * AI 负责：根据提供的岗位数据生成吸引人的通知文案
 * 代码负责：数据清洗、门店数量限制、固定尾部拼接
 */

import { JobDetail, JobBasicInfo } from '@sponge/sponge.types';

export const PART_TIME_JOB_SYSTEM_PROMPT = `你是一个企微兼职招聘群的岗位推送助手。根据提供的真实岗位数据，生成吸引求职者的群通知消息。

## 排版规则

采用「汇总信息 + 精选热招门店 + 区域覆盖汇总」结构，无论门店多少都使用统一格式：

### 结构模板：
🍲【品牌·城市】N家门店招聘啦！

💰 薪资待遇：XX元/时 | 工作形式
👤 招聘对象：年龄、学历等要求
📋 必备条件：证件、稳定性等要求（如有）
⏰ 工作时间：时段信息（如有）

📝 工作内容：
• 具体工作内容1
• 具体工作内容2

🏪 在招门店（部分）：
📍 XX区（N家）
• 门店名 — 岗位
• 门店名 — 岗位
• 门店名 — 岗位

📍 XX区（N家）
• 门店名 — 岗位
• 门店名 — 岗位
• 门店名 — 岗位
（精选3-4个区域，每个区域展示3-4家代表性门店，标注岗位/工种）

📍 覆盖XX、XX、XX等N个区，N家门店持续招聘中！

💬 如何报名？
感兴趣的小伙伴请私聊我报名！点击下方小程序卡片查看更多门店详情~

### 各门店薪资不同时
在热招门店中标注各自薪资：
• 区域·门店名 — 岗位 | XX元/时

## 硬性要求
1. 标题用食物 emoji 开头，品牌和城市用「·」分隔
2. 汇总信息紧跟标题（薪资、招聘对象、工作内容等），用 emoji 小标题标注
3. 如果所有门店的工作内容相同，只在汇总区展示一次，热招门店不重复
4. 精选3-4个区域，每个区域展示3-4家代表性门店，用「📍 区域（N家）」分组
5. 区域覆盖汇总一行展示，列出所有有门店的区域名 + 总门店数
6. 所有薪资、门店名、工作内容必须来自提供的数据，禁止编造
7. 如果没有福利数据就不要提福利
8. 门店名保持原样，不要修改
9. 适合手机阅读，不超过500字
10. 直接输出消息文案
11. 称呼用"小伙伴、朋友"，不要用"姐妹"等有性别倾向的称呼

## 禁止事项（Bad Case）
- ❌ 把所有门店按区域逐一列出形成大段文字墙
- ❌ 编造"时薪日结"、"0经验可上岗"、"节假日有补贴"、"积累服务经验"、"提升沟通能力"等未提供的信息
- ❌ 给每个门店编造不同的工作内容（如果数据里工作内容相同）
- ❌ 禁止添加"岗位优势"板块，除非数据中明确提供了福利信息
- ❌ 使用"姐妹"、"兄弟"等性别化称呼`;

interface PartTimeJobPromptData {
  brand: string;
  city: string;
  industry: string;
  jobs: JobDetail[];
}

/**
 * 构建传给 AI 的用户消息（真实数据）
 */
export function buildPartTimeJobUserMessage(data: PartTimeJobPromptData): string {
  const maxDisplay = 15;
  const displayJobs = data.jobs.slice(0, maxDisplay);
  const hasMore = data.jobs.length > maxDisplay;

  const jobList = displayJobs
    .map((j: JobDetail, i: number) => {
      const bi = j.basicInfo ?? ({} as JobBasicInfo);
      const store = (bi.storeInfo ?? {}) as Record<string, unknown>;
      const parts: string[] = [
        `【门店${i + 1}】`,
        `区域: ${store.storeRegionName || '未知'}`,
        `门店: ${cleanStoreName(String(store.storeName || '未知'))}`,
      ];

      // 岗位名
      if (bi.jobNickName) parts.push(`岗位: ${bi.jobNickName}`);

      // 工作内容
      if (bi.jobContent) parts.push(`工作内容: ${bi.jobContent}`);

      // 工作时段
      const workTime = extractWorkTime(j);
      if (workTime) parts.push(`时段: ${workTime}`);

      // 工作形式
      if (bi.laborForm) parts.push(`形式: ${bi.laborForm}`);

      // 招聘人数
      if (bi.requirementNum) parts.push(`招聘人数: ${bi.requirementNum}人`);

      // 年龄要求
      if (bi.minAge && bi.maxAge) parts.push(`年龄: ${bi.minAge}-${bi.maxAge}岁`);

      return parts.join('\n');
    })
    .join('\n\n');

  // 薪资（取第一个岗位）
  const salaryStr = extractSalary(data.jobs[0]);

  // 福利
  const welfareStr = extractWelfare(data.jobs[0]);

  // 汇总信息（岗位名、工作形式、招聘总人数）
  const firstBi = data.jobs[0]?.basicInfo ?? ({} as JobBasicInfo);
  const jobTitle = firstBi.jobNickName || firstBi.jobName || '服务员';
  const laborForm = firstBi.laborForm || '';
  const totalRequirement = data.jobs.reduce(
    (sum: number, j: JobDetail) => sum + (j.basicInfo?.requirementNum || 0),
    0,
  );
  // 工作内容汇总（如果所有门店相同，只展示一次）
  const allJobContents = data.jobs
    .map((j: JobDetail) => j.basicInfo?.jobContent || '')
    .filter(Boolean);
  const uniqueContents = [...new Set(allJobContents)];
  const commonContent = uniqueContents.length === 1 ? uniqueContents[0] : '';

  // 用人要求汇总（取第一个岗位）
  const hiringReq = extractHiringRequirement(data.jobs[0]);

  const lines = [
    `品牌: ${data.brand}`,
    `城市: ${data.city}`,
    `在招门店数: ${data.jobs.length}家`,
    `岗位: ${jobTitle}（${laborForm}）`,
    salaryStr ? `薪资: ${salaryStr}` : '',
    welfareStr ? `福利: ${welfareStr}` : '',
    totalRequirement > 0 ? `总招聘人数: ${totalRequirement}人` : '',
    hiringReq ? `用人要求: ${hiringReq}` : '',
    commonContent ? `工作内容（所有门店相同）: ${commonContent}` : '',
    '',
    jobList,
  ].filter(Boolean);

  if (hasMore) {
    lines.push('', `（还有${data.jobs.length - maxDisplay}个门店在招，未全部列出）`);
  }

  return lines.join('\n');
}

/**
 * 清洗门店名称
 * 去掉编码（如 GZ4200、KFC-GZ4175）和多余的人名前缀
 */
function cleanStoreName(name: string): string {
  return (
    name
      // 去掉末尾的编码 -GZ4200、-SH1234 等
      .replace(/-[A-Z]{2,}\d{3,}$/i, '')
      // 去掉 KFC-GZ4200 这种
      .replace(/KFC-[A-Z]{2,}\d{3,}/i, 'KFC')
      // 去掉中间的人名（如 "广州-张晓馥-星河山海湾"）
      .replace(/^(.+?)-[\u4e00-\u9fa5]{2,3}-/, '$1-')
      .trim()
  );
}

/**
 * 提取工作时段
 */
function extractWorkTime(job: JobDetail): string {
  const workTime = job.workTime;
  if (!workTime) return '';

  const timeList = (workTime.workTimeList as unknown[]) || (workTime.timeList as unknown[]) || [];
  if (Array.isArray(timeList) && timeList.length > 0) {
    return (
      timeList
        .map((t: unknown) => {
          const e = t as Record<string, string>;
          const start = e.startTime || e.start || '';
          const end = e.endTime || e.end || '';
          return start && end ? `${start}-${end}` : '';
        })
        .filter(Boolean)
        .join(';') + ';'
    );
  }

  return '';
}

/**
 * 提取薪资信息（支持阶梯薪资）
 */
/** 安全读取嵌套属性 */
function prop(obj: unknown, key: string): unknown {
  return (obj as Record<string, unknown>)?.[key];
}

function extractSalary(job: JobDetail): string {
  const scenarios = job?.jobSalary?.salaryScenarioList as Record<string, unknown>[] | undefined;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return '';

  // 多个薪资方案 = 阶梯薪资
  if (scenarios.length > 1) {
    const salaries = scenarios
      .map((s) => {
        const basic = s.basicSalary as Record<string, unknown> | undefined;
        return basic?.basicSalary ? `${basic.basicSalary}` : null;
      })
      .filter(Boolean);
    if (salaries.length > 0) {
      const firstBasic = scenarios[0].basicSalary as Record<string, unknown> | undefined;
      const unit = firstBasic?.basicSalaryUnit || '';
      const min = Math.min(...salaries.map(Number));
      const max = Math.max(...salaries.map(Number));
      return min === max ? `${min}${unit}` : `${min}-${max}${unit}`;
    }
  }

  // 单个薪资方案
  const salary = scenarios[0];
  const basic = salary.basicSalary as Record<string, unknown> | undefined;
  if (basic?.basicSalary) {
    return `${basic.basicSalary}${basic.basicSalaryUnit}`;
  }

  const comp = salary.comprehensiveSalary as Record<string, unknown> | undefined;
  if (comp?.minComprehensiveSalary && comp?.maxComprehensiveSalary) {
    return `${comp.minComprehensiveSalary}-${comp.maxComprehensiveSalary}${comp.comprehensiveSalaryUnit || ''}`;
  }

  return '';
}

function extractHiringRequirement(job: JobDetail): string {
  const hr = job?.hiringRequirement;
  if (!hr) return '';

  const items: string[] = [];

  const basic = prop(hr, 'basicPersonalRequirements') as Record<string, unknown> | undefined;
  if (basic?.minAge && basic?.maxAge) {
    items.push(`年龄${basic.minAge}-${basic.maxAge}岁`);
  }
  if (basic?.genderRequirement && basic.genderRequirement !== '男性,女性') {
    items.push(`${basic.genderRequirement}`);
  }

  const cert = prop(hr, 'certificate') as Record<string, unknown> | undefined;
  if (cert?.education && cert.education !== '不限') {
    items.push(`学历${cert.education}`);
  }
  if (cert?.certificates) {
    items.push(`需${cert.certificates}`);
  }

  const remark = prop(hr, 'remark') as string | undefined;
  if (remark) items.push(remark);

  return items.join('、');
}

function extractWelfare(job: JobDetail): string {
  const welfare = job?.welfare;
  if (!welfare) return '';

  const items: string[] = [];

  const catering = prop(welfare, 'catering');
  if (catering) {
    const val = String(catering);
    if (!val.includes('无') && val !== '不包吃') {
      items.push(val === '包吃' ? '包一顿工作餐' : val);
    }
  }

  const accommodation = prop(welfare, 'accommodation');
  if (accommodation) {
    const val = String(accommodation);
    if (!val.includes('无') && val !== '不包住') {
      items.push(val);
    }
  }

  return items.join('、');
}
