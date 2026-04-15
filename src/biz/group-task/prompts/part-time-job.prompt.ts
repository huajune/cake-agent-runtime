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

💰 薪资待遇：XX-XX元/时 / XX-XX元/月
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
12. 薪资优先展示时薪范围；如果没有明确时薪但有月薪/综合薪资，就展示月薪区间；禁止混写两种薪资口径或编造薪资
13. 不要提及不结算、不缴社保/五险一金、试工/培训无薪、辞退无薪、不接受学生等敏感政策
14. 如果输入中提供了"固定薪资行（必须原样输出）"，必须原样保留，禁止改写、取整、压缩区间或补充"工作类型"

## 禁止事项（Bad Case）
- ❌ 把所有门店按区域逐一列出形成大段文字墙
- ❌ 编造"时薪日结"、"0经验可上岗"、"节假日有补贴"、"积累服务经验"、"提升沟通能力"等未提供的信息
- ❌ 给每个门店编造不同的工作内容（如果数据里工作内容相同）
- ❌ 禁止添加"岗位优势"板块，除非数据中明确提供了福利信息
- ❌ 使用"姐妹"、"兄弟"等性别化称呼
- ❌ 出现"全职"、"兼职"等工作形式字样，薪资待遇后面不要加工作形式
- ❌ 出现"不结算"、"不缴社保"、"无薪资"、"不接受学生"等敏感或误导性表述`;

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

      const salary = extractVisibleSalaryFromJob(j);
      if (salary) parts.push(`薪资: ${salary}`);

      // 工作内容
      const jobContent = sanitizePublicText(bi.jobContent);
      if (jobContent) parts.push(`工作内容: ${jobContent}`);

      // 工作时段
      const workTime = extractWorkTime(j);
      if (workTime) parts.push(`时段: ${workTime}`);

      // 招聘人数
      if (bi.requirementNum) parts.push(`招聘人数: ${bi.requirementNum}人`);

      return parts.join('\n');
    })
    .join('\n\n');

  // 薪资：优先展示时薪，无时薪则回退到月薪/综合薪资
  const salaryStr = extractPartTimeSalary(data.jobs);
  const fixedSalaryLine = buildPartTimeSalaryLine(data.jobs);

  // 福利
  const welfareStr = extractWelfare(data.jobs[0]);

  // 汇总信息（岗位名、招聘总人数）
  const firstBi = data.jobs[0]?.basicInfo ?? ({} as JobBasicInfo);
  const jobTitle = firstBi.jobNickName || firstBi.jobName || '服务员';
  const totalRequirement = data.jobs.reduce(
    (sum: number, j: JobDetail) => sum + (j.basicInfo?.requirementNum || 0),
    0,
  );
  // 工作内容汇总（如果所有门店相同，只展示一次）
  const allJobContents = data.jobs
    .map((j: JobDetail) => sanitizePublicText(j.basicInfo?.jobContent))
    .filter(Boolean);
  const uniqueContents = [...new Set(allJobContents)];
  const commonContent = uniqueContents.length === 1 ? uniqueContents[0] : '';

  // 用人要求汇总（取第一个岗位）
  const hiringReq = extractHiringRequirement(data.jobs[0]);

  const lines = [
    `品牌: ${data.brand}`,
    `城市: ${data.city}`,
    `在招门店数: ${data.jobs.length}家`,
    `岗位: ${jobTitle}`,
    fixedSalaryLine ? `固定薪资行（必须原样输出）: ${fixedSalaryLine}` : '',
    salaryStr ? `汇总薪资范围: ${salaryStr}` : '',
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

const HOURLY_SALARY_UNITS = ['元/时', '元/小时', '/时', '/小时', '时薪'];
const MONTHLY_SALARY_UNITS = ['元/月', '/月', '月薪'];
const SENSITIVE_PUBLIC_COPY_PATTERNS = [
  /不(?:予|给)?结算/,
  /(?:已发|发放).{0,8}(?:追回|扣除)/,
  /(?:不|无)(?:薪资|工资|薪酬|工钱)/,
  /(?:不|无)(?:缴|交|买|购买|缴纳)?(?:社保|五险一金)/,
  /(?:社保|五险一金).{0,6}(?:不缴|不交|不买|不购买|无)/,
  /(?:名下|个人).{0,4}(?:不能有|不可有|不得有).{0,4}(?:社保|五险一金)/,
  /(?:不能有|不可有|不得有).{0,4}(?:社保|五险一金)/,
  /(?:不接受|谢绝|勿扰|不招|不要).{0,4}学生/,
  /学生.{0,4}(?:勿扰|不考虑|不接受|不招)/,
  /(?:培训|试工|试岗|试用).{0,12}(?:无薪|无工资|无薪资|不结算|不计薪)/,
  /(?:主动放弃|商家辞退|辞退|离职|自离).{0,12}(?:无薪|无工资|无薪资|不结算|不计薪)/,
];

function isHourlySalaryUnit(unit: unknown): boolean {
  if (typeof unit !== 'string') {
    return false;
  }

  return HOURLY_SALARY_UNITS.some((keyword) => unit.includes(keyword));
}

function isMonthlySalaryUnit(unit: unknown): boolean {
  if (typeof unit !== 'string') {
    return false;
  }

  return MONTHLY_SALARY_UNITS.some((keyword) => unit.includes(keyword));
}

function formatHourlySalary(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(2)).toString();
}

function containsSensitivePublicCopy(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return SENSITIVE_PUBLIC_COPY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sanitizePublicText(text: unknown): string {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return '';
  }

  const withoutSensitiveParentheses = text.replace(/[（(][^）)]*[）)]/g, (segment) =>
    containsSensitivePublicCopy(segment) ? '' : segment,
  );

  return withoutSensitiveParentheses
    .split(/[，,；;。！!\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !containsSensitivePublicCopy(segment))
    .join('、')
    .replace(/、{2,}/g, '、')
    .replace(/^、|、$/g, '')
    .trim();
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

/** 安全读取嵌套属性 */
function prop(obj: unknown, key: string): unknown {
  return (obj as Record<string, unknown>)?.[key];
}

/**
 * 提取单个岗位的真实时薪区间：
 * - 下限取基础时薪
 * - 上限取基础时薪和阶梯时薪中的最高值
 * - 忽略月薪、综合薪资、节假日薪资、加班薪资、补贴
 */
function extractHourlySalaryFromJob(job: JobDetail): string {
  const hourlySalaries = collectJobHourlySalaries(job);
  if (hourlySalaries.length === 0) return '';

  return formatSalaryRange({
    min: Math.min(...hourlySalaries),
    max: Math.max(...hourlySalaries),
    unit: '元/时',
  });
}

function collectJobHourlySalaries(job: JobDetail): number[] {
  const hourlySalaries: number[] = [];

  const scenarios = job?.jobSalary?.salaryScenarioList as Record<string, unknown>[] | undefined;
  if (!Array.isArray(scenarios)) return hourlySalaries;

  for (const scenario of scenarios) {
    const basic = scenario.basicSalary as Record<string, unknown> | undefined;
    const basicSalary = parsePositiveNumber(basic?.basicSalary);
    if (basicSalary !== null && isHourlySalaryUnit(basic?.basicSalaryUnit)) {
      hourlySalaries.push(basicSalary);
    }

    const stairSalaries = scenario.stairSalaries as Record<string, unknown>[] | undefined;
    if (!Array.isArray(stairSalaries)) continue;

    for (const stair of stairSalaries) {
      const stairSalary = parsePositiveNumber(stair.salary);
      if (stairSalary !== null && isHourlySalaryUnit(stair.salaryUnit)) {
        hourlySalaries.push(stairSalary);
      }
    }
  }

  return hourlySalaries;
}

function extractMonthlySalaryFromJob(job: JobDetail): string {
  const monthlySalaries = collectJobMonthlySalaries(job);
  if (monthlySalaries.length === 0) return '';

  return formatSalaryRange({
    min: Math.min(...monthlySalaries),
    max: Math.max(...monthlySalaries),
    unit: '元/月',
  });
}

function collectJobMonthlySalaries(job: JobDetail): number[] {
  const monthlySalaries: number[] = [];

  const scenarios = job?.jobSalary?.salaryScenarioList as Record<string, unknown>[] | undefined;
  if (!Array.isArray(scenarios)) return monthlySalaries;

  for (const scenario of scenarios) {
    const basic = scenario.basicSalary as Record<string, unknown> | undefined;
    const basicSalary = parsePositiveNumber(basic?.basicSalary);
    if (basicSalary !== null && isMonthlySalaryUnit(basic?.basicSalaryUnit)) {
      monthlySalaries.push(basicSalary);
    }

    const comp = scenario.comprehensiveSalary as Record<string, unknown> | undefined;
    if (isMonthlySalaryUnit(comp?.comprehensiveSalaryUnit)) {
      const minComp = parsePositiveNumber(comp?.minComprehensiveSalary);
      const maxComp = parsePositiveNumber(comp?.maxComprehensiveSalary);
      if (minComp !== null) monthlySalaries.push(minComp);
      if (maxComp !== null) monthlySalaries.push(maxComp);
    }

    const stairSalaries = scenario.stairSalaries as Record<string, unknown>[] | undefined;
    if (!Array.isArray(stairSalaries)) continue;

    for (const stair of stairSalaries) {
      const stairSalary = parsePositiveNumber(stair.salary);
      if (stairSalary !== null && isMonthlySalaryUnit(stair.salaryUnit)) {
        monthlySalaries.push(stairSalary);
      }
    }
  }

  return monthlySalaries;
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatSalaryRange(range: { min: number; max: number; unit: string }): string {
  const minStr = formatHourlySalary(range.min);
  const maxStr = formatHourlySalary(range.max);
  return range.min === range.max ? `${minStr}${range.unit}` : `${minStr}-${maxStr}${range.unit}`;
}

/**
 * 汇总所有岗位的真实时薪区间
 */
export function extractPartTimeHourlySalary(jobs: JobDetail[]): string {
  const ranges = jobs
    .map((job) => {
      const hourlySalaries = collectJobHourlySalaries(job);
      if (hourlySalaries.length === 0) return null;
      return {
        min: Math.min(...hourlySalaries),
        max: Math.max(...hourlySalaries),
      };
    })
    .filter((range): range is { min: number; max: number } => range !== null);

  if (ranges.length === 0) return '';

  return formatSalaryRange({
    min: Math.min(...ranges.map((range) => range.min)),
    max: Math.max(...ranges.map((range) => range.max)),
    unit: '元/时',
  });
}

function extractPartTimeMonthlySalary(jobs: JobDetail[]): string {
  const ranges = jobs
    .map((job) => {
      const monthlySalaries = collectJobMonthlySalaries(job);
      if (monthlySalaries.length === 0) return null;
      return {
        min: Math.min(...monthlySalaries),
        max: Math.max(...monthlySalaries),
      };
    })
    .filter((range): range is { min: number; max: number } => range !== null);

  if (ranges.length === 0) return '';

  return formatSalaryRange({
    min: Math.min(...ranges.map((range) => range.min)),
    max: Math.max(...ranges.map((range) => range.max)),
    unit: '元/月',
  });
}

function extractPartTimeSalary(jobs: JobDetail[]): string {
  return extractPartTimeHourlySalary(jobs) || extractPartTimeMonthlySalary(jobs);
}

function extractVisibleSalaryFromJob(job: JobDetail): string {
  return extractHourlySalaryFromJob(job) || extractMonthlySalaryFromJob(job);
}

export function buildPartTimeSalaryLine(jobs: JobDetail[]): string {
  const salary = extractPartTimeSalary(jobs);
  return salary ? `💰 薪资待遇：${salary}` : '';
}

export function enforcePartTimeSalaryLine(message: string, jobs: JobDetail[]): string {
  const salaryLine = buildPartTimeSalaryLine(jobs);
  const rawLines = message.split(/\r?\n/).map((line) => line.replace(/\s+$/g, ''));
  const resultLines: string[] = [];
  let insertedSalary = false;
  let skippingSalaryBlock = false;

  for (const line of rawLines) {
    const trimmed = line.trim();
    const isEmpty = trimmed.length === 0;
    const isSalaryHeader =
      /^(?:💰\s*)?(?:薪资待遇|薪资范围|时薪范围|薪资说明)[:：]?$/.test(trimmed) ||
      (/^💰/.test(trimmed) && /薪资|时薪/.test(trimmed));
    const isSalaryBullet =
      /^[-•]/.test(trimmed) && /薪资|时薪|月薪|综合薪资|工作类型|灵活时间制/.test(trimmed);
    const startsNewSection =
      /^(?:👤|👥|📋|⏰|📝|🏪|📍|💬|📞|🏆|📣|📌)/.test(trimmed) ||
      /^(?:招聘对象|招聘条件|必备条件|工作时间|工作内容|在招门店|覆盖|如何报名|联系我们|主要职责)/.test(
        trimmed,
      );

    if (skippingSalaryBlock) {
      if (startsNewSection) {
        skippingSalaryBlock = false;
      } else if (isEmpty || isSalaryBullet) {
        continue;
      } else {
        continue;
      }
    }

    if (isSalaryHeader || isSalaryBullet) {
      if (salaryLine && !insertedSalary) {
        resultLines.push(salaryLine);
        insertedSalary = true;
      }
      skippingSalaryBlock = true;
      continue;
    }

    resultLines.push(line);

    if (!insertedSalary && salaryLine && trimmed.length > 0) {
      resultLines.push('');
      resultLines.push(salaryLine);
      insertedSalary = true;
    }
  }

  if (salaryLine && !insertedSalary) {
    if (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() !== '') {
      resultLines.push('');
    }
    resultLines.push(salaryLine);
  }

  return resultLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHiringRequirement(job: JobDetail): string {
  const hr = job?.hiringRequirement;
  if (!hr) return '';

  const items: string[] = [];

  // 年龄范围统一写宽泛，避免劝退求职者
  items.push('年龄18-50岁');

  const basic = prop(hr, 'basicPersonalRequirements') as Record<string, unknown> | undefined;
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

  const remark = sanitizePublicText(prop(hr, 'remark'));
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
