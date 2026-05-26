/**
 * 给 LLM 直接念给候选人的"岗位推荐卡片"模板渲染层（Phase 1.C 文案模板化）。
 *
 * 历史 badcase 簇 ④（推荐/收尾文案 LLM 自由作文）共 20 条待修，其中 11 条
 * 直接由"班次/薪资/地址缺失"造成：
 *  - 班次 5 条（qkiygu5s / uyhffxit / bxobhhmy / 45fkfivu / nndx2ctl）：
 *    Agent 推荐时漏说"每周出勤天数 + 班次时间"
 *  - 薪资 3 条（03n3gv35 / 6b0wknts / znabv7ph）：介绍薪资偷懒/不清楚/漏阶梯
 *  - 推荐缺地址 3 条（afdxytz0 / mgqlhyd1 / x189vplh）：岗位推荐没有门店名/地址
 *
 * 当前路径：Agent 自己从 raw job 拼装推荐句子 → 频繁漏字段。
 *
 * 本层路径：从 raw job 派生"固定结构的 candidate-facing 卡片"，Agent 推荐时
 * 直接照念 candidateCard 原文（可微调连接词，但禁止删除字段）。
 *
 * 设计原则：
 *  - 信息密度优先：1 个岗位 2-3 行覆盖关键事实（地址 / 班次 / 薪资 / 硬要求）
 *  - 缺失字段优雅省略（不输出 "班次: undefined"）
 *  - 不输出"建议/可能/也许/大概"等软性措辞
 *  - 不进入决策——这一层只是把已派生事实拼装成候选人友好句子
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { hasValue } from '@tools/duliday/job-list/helpers.util';
import { normalizeStoreNameForAgent } from '@tools/duliday/job-list/sanitize.util';
import {
  extractHardRequirements,
  type HardRequirements,
} from '@tools/duliday/job-list/hard-requirements.util';
import { extractSalaryFacts } from '@tools/duliday/job-list/salary-facts.util';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';

export interface CandidateCard {
  jobId: number | string;
  /** 单行精简版（"1. KFC 服务员 - 静安寺店 | 2.3km | 周一至五 11-15 ｜ 24-29 元/时 ｜ 18-50 岁 需食品健康证"） */
  oneLine: string;
  /** 多行可读版（标题 + 班次 + 薪资 + 要求 三行格式） */
  multiLine: string;
}

function buildAddress(job: any): string {
  const bi = job?.basicInfo;
  if (!bi) return '';
  const rawStore = bi.storeInfo?.storeName;
  const store = normalizeStoreNameForAgent(rawStore, bi.storeInfo?.storeCityName);
  const distance =
    typeof job._distanceKm === 'number' ? `${Math.round(job._distanceKm * 10) / 10}km` : '';
  return [store, distance].filter(Boolean).join('，');
}

function buildShiftPart(workTime: unknown): string {
  const wt = workTime as any;
  if (!wt) return '';
  const parts: string[] = [];

  // 时间段：直接读 fixedScheduleList，不做计算
  const slots = wt?.dailyShiftSchedule?.fixedScheduleList;
  if (Array.isArray(slots) && slots.length > 0) {
    const ranges = slots
      .filter((s: any) => hasValue(s?.fixedShiftStartTime) && hasValue(s?.fixedShiftEndTime))
      .map((s: any) => `${s.fixedShiftStartTime}-${s.fixedShiftEndTime}`);
    if (ranges.length > 0) parts.push(ranges.join(' / '));
  }

  // 每日最少工时（有则展示，不推断）
  const dayMin = wt?.dayWorkTime?.perDayMinWorkHours;
  if (hasValue(dayMin)) parts.push(`每日至少 ${dayMin} 小时`);

  // 每周天数
  const week = wt?.weekWorkTime ?? {};
  if (hasValue(week.perWeekWorkDays)) parts.push(`每周 ${week.perWeekWorkDays} 天`);
  else if (hasValue(week.perWeekNeedWorkDays)) parts.push(`每周 ${week.perWeekNeedWorkDays} 天`);

  return parts.join('，');
}

function buildSalaryPart(job: any): string {
  const scenarios = Array.isArray(job?.jobSalary?.salaryScenarioList)
    ? job.jobSalary.salaryScenarioList
    : [];
  for (const s of scenarios) {
    const comp = s?.comprehensiveSalary;
    const min = comp?.minComprehensiveSalary;
    const max = comp?.maxComprehensiveSalary;
    const unit = comp?.comprehensiveSalaryUnit || '元/时';
    if (hasValue(min) && hasValue(max) && min !== max) return `${min}-${max} ${unit}`;
    if (hasValue(min)) return `${min} ${unit}`;
    if (hasValue(max)) return `${max} ${unit}`;
    const basic = s?.basicSalary?.basicSalary;
    if (hasValue(basic)) return `${basic} ${s?.basicSalary?.basicSalaryUnit || '元/月'}`;
  }
  return '';
}

function buildStairPart(job: any): string {
  const facts = extractSalaryFacts(job?.jobSalary);
  if (!facts.hasStairSalary) return '';
  const scenarios = Array.isArray(job?.jobSalary?.salaryScenarioList)
    ? job.jobSalary.salaryScenarioList
    : [];
  for (const s of scenarios) {
    const stairs = Array.isArray(s?.stairSalaries) ? s.stairSalaries : [];
    if (stairs.length === 0) continue;
    const parts = stairs
      .map((stair: any) => {
        if (!hasValue(stair?.salary)) return null;
        const unit = stair?.salaryUnit || '元/时';
        const threshold = hasValue(stair?.fullWorkTime)
          ? `满 ${stair.fullWorkTime}${stair?.fullWorkTimeUnit || ''}→${stair.salary}${unit}`
          : `${stair.salary}${unit}`;
        return threshold;
      })
      .filter(Boolean);
    if (parts.length > 0) return `阶梯：${parts.join(' / ')}`;
  }
  return '';
}

function buildRequirementPart(hr: HardRequirements, ageText: string | null): string {
  const parts: string[] = [];
  if (ageText && ageText !== '不限') parts.push(ageText);
  if (hr.gender === 'female') parts.push('仅限女');
  else if (hr.gender === 'male') parts.push('仅限男');
  if (hr.healthCert === 'required_before_interview') parts.push('面试前需食品健康证');
  else if (hr.healthCert === 'required_before_onboard') parts.push('入职前办食品健康证');
  if (hr.household) {
    const verb = hr.household.mode === 'include' ? '仅' : '不要';
    parts.push(`${verb}${hr.household.regions.join('/')}`);
  }
  return parts.join('，');
}

/**
 * 派生单个岗位的候选人推荐卡片。
 *
 * 输入：raw job（jobs 数组单元素），需包含 basicInfo / workTime / jobSalary / hiringRequirement。
 * 输出：oneLine + multiLine 两种 ready-to-send 模板字符串。
 */
export function renderCandidateCard(job: any, index?: number): CandidateCard | null {
  if (!job?.basicInfo) return null;
  const bi = job.basicInfo;
  const jobName = bi.jobName || bi.jobNickName || '岗位';
  const brand = bi.brandName || '';
  const address = buildAddress(job);

  const policy = buildJobPolicyAnalysis(job);
  const hr = extractHardRequirements(job, policy);

  const shift = buildShiftPart(job?.workTime);
  const salary = buildSalaryPart(job);
  const stair = buildStairPart(job);
  const requirement = buildRequirementPart(hr, policy.normalizedRequirements.ageRequirement);

  // 单行：紧凑、用 "｜" 分隔字段，省略空字段
  const title = [brand, jobName].filter(Boolean).join(' ');
  const head = address ? `${title} - ${address}` : title;
  const oneParts = [
    typeof index === 'number' ? `${index + 1}. **${head}**` : `**${head}**`,
    shift && `班次：${shift}`,
    salary && `薪资：${salary}${stair ? '，' + stair : ''}`,
    requirement && `要求：${requirement}`,
  ].filter(Boolean);
  const oneLine = oneParts.join(' ｜ ');

  // 多行：标题独立成行，其余字段一行一条
  const multiLines: string[] = [
    typeof index === 'number' ? `${index + 1}. **${head}**` : `**${head}**`,
  ];
  if (shift) multiLines.push(`   班次：${shift}`);
  if (salary) multiLines.push(`   薪资：${salary}${stair ? '，' + stair : ''}`);
  if (requirement) multiLines.push(`   要求：${requirement}`);
  const multiLine = multiLines.join('\n');

  return {
    jobId: bi.jobId,
    oneLine,
    multiLine,
  };
}

/**
 * 渲染插在 markdown 顶部的"推荐用模板"banner——固定结构的卡片合集，
 * 让 LLM 推荐岗位时直接照念，不要自己重新拼装字段。
 *
 * 返回空字符串表示 jobs 为空，调用方跳过插入。
 */
export function renderCandidateCardsBanner(jobs: any[]): string {
  if (!Array.isArray(jobs) || jobs.length === 0) return '';
  const cards = jobs
    .map((job, idx) => renderCandidateCard(job, idx))
    .filter((c): c is CandidateCard => c !== null);
  if (cards.length === 0) return '';

  const lines: string[] = [];
  lines.push(
    '> 📣 **推荐对话用模板**（向候选人介绍岗位时直接引用以下卡片，可微调连接词/语气，但**不得删除班次/薪资/地址/要求字段**）',
  );
  for (const card of cards) {
    for (const line of card.multiLine.split('\n')) {
      lines.push(`> ${line}`);
    }
  }
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

/* eslint-enable @typescript-eslint/no-explicit-any */
