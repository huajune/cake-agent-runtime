/**
 * 兼职群通知 — 真实数据 + AI 润色 + 固定尾部
 *
 * AI 负责：根据提供的岗位数据生成吸引人的通知文案
 * 代码负责：数据清洗、门店数量限制、固定尾部拼接
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const PART_TIME_JOB_SYSTEM_PROMPT = `你是一个企微兼职招聘群的岗位推送助手。根据提供的真实岗位数据，生成吸引求职者的群通知消息。

## 排版规则（根据门店数量和薪资差异自动选择）

### 门店少（<15个）且各门店薪资不同时 — 每店独立展示：
🍗【肯德基-广州】多门店招聘啦！

📍 星河山海湾店
💰 15.5元/时 | 灵工 | 全职
工作内容：餐厅服务、点餐收银、餐品制作等

📍 立白店
💰 14.6元/时 | 灵工 | 兼职
工作内容：餐厅服务、点餐收银

### 门店少（<15个）且薪资相同时 — 薪资统一，门店逐行：
🌮【塔可贝尔·上海】兼职招聘来啦！

📍 张江高科店 - 门店服务员
💰 19元/时 | 小时工
• 负责点餐收银、餐品制作、店内清洁等工作

📍 丁香国际店 - 门店服务员
💰 19元/时 | 小时工
• 负责点餐收银、餐品制作、店内清洁等工作

### 门店多（≥15个）— 薪资顶部展示，按区域分组：
📌【天津肯德基】店员招募~速来围观
💰 底薪：14.8-19.1元/时
排班：接受早中晚轮班

🏪 河西区（20家）：
•乐园道店
•爱国北里
•万科广东路餐厅
...
🏪 南开区（10家）：
•大悦城商厦店
•西南角店
...

### 门店较多但不需分区（10-15个）— 简洁清单：
🍗【肯德基·马鞍山】12家门店招兼职啦！

💰薪资：14.3元/小时
⏰岗位：普通服务员（小时工）

🏪 招聘门店：
•向山欧德福店
•印象汇店
•当涂安德利店
...

## 硬性要求
1. 标题下方紧跟汇总信息（薪资、岗位名、工作形式等），用小标题 emoji 标注
2. 如果所有门店的工作内容相同，只在汇总区展示一次，不要每个门店重复
3. 所有薪资、门店名、工作内容必须来自提供的数据，禁止编造
4. 如果没有福利数据就不要提福利
5. 门店名保持原样，不要修改
6. 适合手机阅读，不超过800字
7. 直接输出消息文案
8. 末尾加上报名引导语，包含：私聊报名 + 提示点击下方小程序卡片查看更多岗位，风格自由灵活


## 禁止事项（Bad Case）
- ❌ 把90个门店名全部堆在一起形成大段文字墙
- ❌ 编造"时薪日结"、"0经验可上岗"、"节假日有补贴"、"积累服务经验"、"提升沟通能力"等未提供的信息
- ❌ 给每个门店编造不同的工作内容（如果数据里工作内容相同）
- ❌ 禁止添加"岗位优势"板块，除非数据中明确提供了福利信息`;

interface PartTimeJobPromptData {
  brand: string;
  city: string;
  industry: string;
  jobs: any[];
}

/**
 * 构建传给 AI 的用户消息（真实数据）
 */
export function buildPartTimeJobUserMessage(data: PartTimeJobPromptData): string {
  const maxDisplay = 15;
  const displayJobs = data.jobs.slice(0, maxDisplay);
  const hasMore = data.jobs.length > maxDisplay;

  const jobList = displayJobs
    .map((j: any, i: number) => {
      const bi = j.basicInfo || {};
      const store = bi.storeInfo || {};
      const parts: string[] = [
        `【门店${i + 1}】`,
        `区域: ${store.storeRegionName || '未知'}`,
        `门店: ${cleanStoreName(store.storeName || '未知')}`,
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
  const firstBi = data.jobs[0]?.basicInfo || {};
  const jobTitle = firstBi.jobNickName || firstBi.jobName || '服务员';
  const laborForm = firstBi.laborForm || '';
  const totalRequirement = data.jobs.reduce(
    (sum: number, j: any) => sum + (j.basicInfo?.requirementNum || 0),
    0,
  );
  // 工作内容汇总（如果所有门店相同，只展示一次）
  const allJobContents = data.jobs.map((j: any) => j.basicInfo?.jobContent || '').filter(Boolean);
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
function extractWorkTime(job: any): string {
  const workTime = job.workTime;
  if (!workTime) return '';

  const timeList = workTime.workTimeList || workTime.timeList || [];
  if (Array.isArray(timeList) && timeList.length > 0) {
    return (
      timeList
        .map((t: any) => {
          const start = t.startTime || t.start || '';
          const end = t.endTime || t.end || '';
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
function extractSalary(job: any): string {
  const scenarios = job?.jobSalary?.salaryScenarioList;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return '';

  // 多个薪资方案 = 阶梯薪资
  if (scenarios.length > 1) {
    const salaries = scenarios
      .map((s: any) => {
        const basic = s.basicSalary;
        return basic?.basicSalary ? `${basic.basicSalary}` : null;
      })
      .filter(Boolean);
    if (salaries.length > 0) {
      const unit = scenarios[0].basicSalary?.basicSalaryUnit || '';
      const min = Math.min(...salaries.map(Number));
      const max = Math.max(...salaries.map(Number));
      return min === max ? `${min}${unit}` : `${min}-${max}${unit}`;
    }
  }

  // 单个薪资方案
  const salary = scenarios[0];
  const basic = salary.basicSalary;
  if (basic?.basicSalary) {
    return `${basic.basicSalary}${basic.basicSalaryUnit}`;
  }

  const comp = salary.comprehensiveSalary;
  if (comp?.minComprehensiveSalary && comp?.maxComprehensiveSalary) {
    return `${comp.minComprehensiveSalary}-${comp.maxComprehensiveSalary}${comp.comprehensiveSalaryUnit || ''}`;
  }

  return '';
}

/**
 * 提取用人要求
 */
function extractHiringRequirement(job: any): string {
  const hr = job?.hiringRequirement;
  if (!hr) return '';

  const items: string[] = [];

  // 年龄
  const basic = hr.basicPersonalRequirements;
  if (basic?.minAge && basic?.maxAge) {
    items.push(`年龄${basic.minAge}-${basic.maxAge}岁`);
  }

  // 性别
  if (basic?.genderRequirement && basic.genderRequirement !== '男性,女性') {
    items.push(`${basic.genderRequirement}`);
  }

  // 学历
  const cert = hr.certificate;
  if (cert?.education && cert.education !== '不限') {
    items.push(`学历${cert.education}`);
  }

  // 证书
  if (cert?.certificates) {
    items.push(`需${cert.certificates}`);
  }

  // 备注
  if (hr.remark) {
    items.push(hr.remark);
  }

  return items.join('、');
}

/**
 * 提取福利信息（无实际福利时返回空字符串）
 */
function extractWelfare(job: any): string {
  const welfare = job?.welfare;
  if (!welfare) return '';

  const items: string[] = [];

  if (welfare.catering) {
    const val = String(welfare.catering);
    if (!val.includes('无') && val !== '不包吃') {
      items.push(val === '包吃' ? '包一顿工作餐' : val);
    }
  }

  if (welfare.accommodation) {
    const val = String(welfare.accommodation);
    if (!val.includes('无') && val !== '不包住') {
      items.push(val);
    }
  }

  return items.join('、');
}

/* eslint-enable @typescript-eslint/no-explicit-any */
