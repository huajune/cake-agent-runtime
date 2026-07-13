/**
 * DuLiDay 岗位查询工具（LLM 优化版）
 *
 * 渐进式数据返回：通过 6 个布尔开关控制返回的数据字段。
 * 支持 markdown / rawData 两种输出格式。
 *
 * markdown 模式：对每个岗位按 6 个模块（基本信息/薪资/福利/招聘要求/
 * 工作时间/面试流程）进行"语义投影"——把原始 JSON 字段按业务语义
 * 合并成可读中文文本（value+unit 合并、min/max 区间合并、名称+ID、
 * 坐标、身高区间、排班多变体等），null/空值字段自动隐藏。
 *
 * 导出 buildJobListTool 供注册表使用
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import type { RecommendedJobSummary } from '@memory/types/session-facts.types';
import { isValidLaborForm, stripLaborFormFromCategories } from '@memory/facts/labor-form';
import { ToolBuilder, ToolBuildContext } from '@shared-types/tool.types';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { buildNoMatchScript } from '@tools/duliday/job-list/no-match-script.util';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';
import { sanitizeBrandName } from '@tools/utils/sanitize-brand-name.util';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import { COUNTY_LEVEL_CITY_TO_PREFECTURE } from '@memory/facts/geo-mappings';
import {
  applyLaborFormConstraint,
  applyScheduleConstraint,
  collectLaborFormAnomalies,
  filterJobsByRequestedCategories,
  filterJobsToRequestedBrands,
  formatScheduleConstraintLabel,
  haversineDistance,
} from '@tools/duliday/job-list/search.util';
import { findBrandFuzzyMatches } from '@tools/duliday/job-list/brand-fuzzy-match.util';
import {
  buildBrandNearestStoreSummary,
  formatSalarySummary,
  getMultiStoreBrandGroups,
} from '@tools/duliday/job-list/brand-stores.util';
import {
  formatJobsToMarkdown,
  inferStudentRequirement,
  type ProgressiveDisclosureFlags,
} from '@tools/duliday/job-list/render.util';
import { composeShiftTimeText } from '@tools/utils/format-shift-time.util';
import { extractWelfareFacts } from '@tools/duliday/job-list/welfare-facts.util';
import {
  AGE_BOUNDARY_HANDOFF_FLOOR,
  AGE_BOUNDARY_LOWER_TOLERANCE_YEARS,
  AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
  detectAgeBoundary,
  parseAgeRange,
  parseCandidateAge,
  type AgeScreeningSignal,
} from '@tools/duliday/precheck/age.util';

// ==================== 常量 ====================

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DISTANCE_SCAN_MAX_PAGES = 10;

function normalizeBrandEvidenceText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

/**
 * 拦截模型从普通微信昵称臆测出的品牌。
 *
 * 仅在品牌库对 contactName 完全无命中时启用；候选人当轮确实明说了同一个名称时保留，
 * 避免误伤“用户主动询问一个尚未入库品牌”的场景。
 */
function rejectUnverifiedNicknameBrandAliases(
  aliases: string[],
  context: ToolBuildContext,
): { accepted: string[]; rejected: string[] } {
  if (!context.contactName || (context.contactBrandAliases?.length ?? 0) > 0) {
    return { accepted: aliases, rejected: [] };
  }

  const nickname = normalizeBrandEvidenceText(context.contactName);
  const currentMessage = normalizeBrandEvidenceText(context.currentUserMessage);
  if (!nickname) return { accepted: aliases, rejected: [] };

  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const alias of aliases) {
    const normalizedAlias = normalizeBrandEvidenceText(alias);
    const looksCopiedFromNickname =
      normalizedAlias.length >= 2 &&
      (normalizedAlias === nickname || nickname.includes(normalizedAlias));
    const candidateExplicitlySaidIt =
      normalizedAlias.length >= 2 && currentMessage.includes(normalizedAlias);
    if (looksCopiedFromNickname && !candidateExplicitlySaidIt) rejected.push(alias);
    else accepted.push(alias);
  }
  return { accepted, rejected };
}

// ==================== 输入 Schema ====================

const inputSchema = z.object({
  cityNameList: z.array(z.string()).optional().default([]).describe('城市列表'),
  regionNameList: z.array(z.string()).optional().default([]).describe('区域列表'),
  brandAliasList: z.array(z.string()).optional().default([]).describe('品牌别名列表'),
  storeNameList: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      '门店名称列表。注意：上游 API 按门店名**精确匹配**（不支持模糊），口语或运营备注里的门店名常与库内实名对不上，极易落空，**强烈不建议用**——按门店名找岗位时改用 searchJobName 做模糊匹配。',
    ),
  searchJobName: z
    .string()
    .optional()
    .describe(
      '岗位名称模糊匹配（子串匹配整条 jobName，jobName 形如「品牌-门店-工种-用工形式」，如「M Stand-上海长泰广场店-店员-小时工」）。**想按门店/地标找岗位时填这里**（如候选人说"想去长泰广场那家"就填"长泰广场"），比 storeNameList（精确匹配易落空）宽容得多。建议配合 cityNameList/brandIdList 收窄；不要把工种/用工形式词塞进来（那些用 jobCategoryList）。\n**也不要把品类/行业词（"咖啡""奶茶""茶饮""火锅"等）塞进来**——品类词是品牌指向、不会出现在 jobName 子串里（如咖啡品牌的 jobName 是「M Stand-…-店员-小时工」，不含"咖啡"），按品类词查 searchJobName 必然落空；品类词应展开为相关品牌走 brandIdList/brandAliasList 召回，或直接留空按位置召回。',
    ),
  jobCategoryList: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      '岗位工种/职位类目，描述这份岗位具体做什么工作。例如：["服务员"]、["理货员"]、["分拣员"]、["收银员"]、["骑手"]。\n【默认留空】这是一个会大幅收窄结果的强过滤，默认不要填——优先靠城市/区域 + 品牌(brandIdList/brandAliasList)召回。只有候选人**明确点名某个具体工种**(如"我只做收银""想干分拣")时才填。\n禁止：不要从品类/行业词或品牌意向反推工种(如"咖啡""奶茶"是品类，指相关品牌，不要转成"咖啡师"；说某品牌不代表只做某工种)。\n严禁填入"全职"、"兼职"、"小时工"、"寒假工"、"暑假工"、"临时工"等用工形式词——用工形式是岗位的 laborForm 属性、不是岗位工种，按工具的用工形式过滤处理（候选人意向已从会话事实自动读取），不要塞进 jobCategoryList。若召回为空，先清空 jobCategoryList 放宽重查。',
    ),
  brandIdList: z
    .array(z.number().int())
    .optional()
    .default([])
    .describe(
      '品牌ID列表；Boss直聘岗位标题中形如 "[10239]" 的方括号纯数字是品牌ID，应填为 brandIdList=[10239]，不要当作 jobId/薪资/编号',
    ),
  projectNameList: z.array(z.string()).optional().default([]).describe('项目名称列表'),
  projectIdList: z.array(z.number().int()).optional().default([]).describe('项目ID列表'),
  jobIdList: z.array(z.number().int()).optional().default([]).describe('岗位ID列表'),
  settlementPeriodList: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      '结算周期筛选（取 salary_period 字典名称，如 "日结算"、"周结算"、"月结算"、"半月结"）。仅当候选人**明确点名要某种结算周期**（如"想找日结的""有没有日结岗"）时填；平时留空。注意结算周期是薪资属性，不是岗位工种，不要塞进 jobCategoryList。',
    ),

  location: z
    .object({
      longitude: z.number().optional().describe('经度（通过 geocode 工具或位置分享获取）'),
      latitude: z.number().optional().describe('纬度（通过 geocode 工具或位置分享获取）'),
      range: z
        .number()
        .int()
        .optional()
        .describe(
          '位置筛选范围，单位米。' +
            '若不传，工具会按业务阈值 max_recommend_distance_km 自动兜底（×1000 转米）；' +
            '需要更小或更大的查询半径时显式传值',
        ),
    })
    .optional()
    .describe('位置筛选条件'),

  responseFormat: z
    .array(z.enum(['markdown', 'rawData']))
    .optional()
    .default(['markdown'])
    .describe('返回格式，可多选。默认 ["markdown"]'),

  includeBasicInfo: z.boolean().optional().default(true).describe('返回基本信息 - 默认true'),
  // 默认 true 的三类（badcase #15 北京必胜客日结/月结、#22 六姐没主动报薪、
  // #izoyiy16/9c49atl7/tkozzsp1 三连未介绍班次）：
  // - includeJobSalary：薪资是候选人最关心的事实，缺薪资的推荐易被竞品挖走；阶梯
  //   薪资和发薪周期（日结/月结）也都靠这个开关返回。默认 false 时模型常忘开。
  // - includeHiringRequirement：首次推荐就该让候选人看到关键要求自行判断（已在
  //   prompt 写明），默认 false 等于把"模型记得开"当兜底，不可靠。
  // - includeWorkTime：班次/上班时间是岗位三件套（地点+薪资+班次）之一；只在候选人
  //   显式追问时才开 → 模型常给"早班/开档/前厅"这类岗位名却没具体时间，甚至反问
  //   "班次能不能接受"自己却没给。默认 true 把数据备齐，配合 prompt 强制写进推荐文案。
  includeJobSalary: z.boolean().optional().default(true).describe('返回薪资信息 - 默认true'),
  // 福利和薪资/班次一样属于候选人高频追问事实。默认取回后写入精简岗位记忆，
  // 避免下一轮追问包吃住时，模型因 compact summary 丢字段而凭常识脑补。
  includeWelfare: z.boolean().optional().default(true).describe('返回福利信息 - 默认true'),
  includeHiringRequirement: z
    .boolean()
    .optional()
    .default(true)
    .describe('返回招聘要求 - 默认true'),
  includeWorkTime: z.boolean().optional().default(true).describe('返回工作时间/班次 - 默认true'),
  includeInterviewProcess: z.boolean().optional().default(false).describe('返回面试流程'),

  candidateScheduleConstraint: z
    .object({
      onlyWeekends: z.boolean().optional().describe('候选人只能周末上班'),
      onlyEvenings: z.boolean().optional().describe('候选人只做晚班/晚上有空'),
      onlyMornings: z.boolean().optional().describe('候选人只做早班'),
      maxDaysPerWeek: z.number().int().min(1).max(7).optional().describe('候选人每周最多 N 天'),
    })
    .optional()
    .describe(
      '候选人班次硬约束。传入后，工具会按岗位 workTime 语义判定是否兼容；不兼容岗位会从结果中移除并在 queryMeta.scheduleFilter 里说明剔除数量。候选人明确表达"只能周末/只做晚班/每周最多两天"等班次硬约束时必须传，避免推荐工作日强排班/全周岗位。注意方向：候选人解释"为什么某班次做不了"（如"我七点才下班赶不上晚班""上晚班影响睡眠"）是对该班次的**排除**，不是"只做该班次"，不得据此传 onlyEvenings/onlyMornings；"找周六/周末的活"= onlyWeekends: true。班次约束跨轮累积：候选人早前说过"只周六/只周末"，本轮只是补充其他限制时，onlyWeekends 必须继续带上，不得用新约束替换。',
    ),
});

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapJobsToSummaries(jobs: any[]): RecommendedJobSummary[] {
  return jobs.map((job) => {
    const policy = buildJobPolicyAnalysis(job);
    const ageRequirement = policy.normalizedRequirements.ageRequirement;
    const educationRequirement = policy.normalizedRequirements.educationRequirement;
    const healthCertificateRequirement = policy.normalizedRequirements.healthCertificateRequirement;
    const hasWelfarePayload =
      job.welfare !== null && typeof job.welfare === 'object' && !Array.isArray(job.welfare);
    const welfare = hasWelfarePayload ? extractWelfareFacts(job.welfare) : null;

    return {
      jobId: job.basicInfo.jobId,
      brandName: job.basicInfo.brandName ?? null,
      jobName: job.basicInfo.jobName ?? null,
      storeName: job.basicInfo.storeInfo?.storeName ?? null,
      storeAddress: job.basicInfo.storeInfo?.storeAddress ?? null,
      cityName: job.basicInfo.storeInfo?.storeCityName ?? null,
      regionName: job.basicInfo.storeInfo?.storeRegionName ?? null,
      laborForm: job.basicInfo.laborForm ?? null,
      partTimeJobType: job.basicInfo.partTimeJobType ?? null,
      salaryDesc: formatSalarySummary(job),
      shiftSummary: composeShiftTimeText(job.workTime),
      jobCategoryName: job.basicInfo.jobCategoryName ?? null,
      ageRequirement: ageRequirement && ageRequirement !== '不限' ? ageRequirement : null,
      educationRequirement:
        educationRequirement && educationRequirement !== '不限' ? educationRequirement : null,
      healthCertificateRequirement:
        healthCertificateRequirement && healthCertificateRequirement !== '未明确要求'
          ? healthCertificateRequirement
          : null,
      studentRequirement: inferStudentRequirement(policy),
      distanceKm: job._distanceKm != null ? Math.round(job._distanceKm * 10) / 10 : null,
      welfareFacts: welfare
        ? {
            meals: welfare.meals,
            accommodation: welfare.accommodation,
            hasTrafficAllowance: welfare.hasTrafficAllowance,
            hasPromotionWelfare: welfare.hasPromotionWelfare,
            otherWelfareItems: welfare.otherWelfareItems
              .slice(0, 5)
              .map((item) => item.slice(0, 120)),
          }
        : null,
    };
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 海绵的 city/region 按地级/县级行政区分层；候选人却常把县级市直接称作“城市”。
 * 这里只剥最末级的通用后缀，用于判断 location-only 召回是否仍属于用户点名的行政区，
 * 不用于改写实际查询参数。
 */
function normalizeAdministrativeMatchKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\s+/g, '')
    .replace(/[市区县旗]$/, '');
}

function filterJobsToRequestedAdministrativeArea<T>(jobs: T[], requestedCities: string[]): T[] {
  const requestedKeys = new Set(
    requestedCities.map(normalizeAdministrativeMatchKey).filter(Boolean),
  );
  if (requestedKeys.size === 0) return [];

  return jobs.filter((job) => {
    if (!isRecord(job) || !isRecord(job.basicInfo)) return false;
    const storeInfo = job.basicInfo.storeInfo;
    if (!isRecord(storeInfo)) return false;
    return [storeInfo.storeCityName, storeInfo.storeRegionName].some((label) =>
      requestedKeys.has(normalizeAdministrativeMatchKey(label)),
    );
  });
}

interface SpongeCityFilterNormalization {
  cityNameList: string[];
  derivedRegionNameList: string[];
  mappings: Array<{ requestedCity: string; spongeCity: string; spongeRegion: string }>;
}

/** 把明确的县级市工具参数转换为海绵的“地级 city + 县级 region”口径。 */
function normalizeSpongeCityFilters(cityNames: string[]): SpongeCityFilterNormalization {
  const cityNameList: string[] = [];
  const derivedRegionNameList: string[] = [];
  const mappings: SpongeCityFilterNormalization['mappings'] = [];

  for (const requestedCity of cityNames) {
    const countyCity = requestedCity.endsWith('市') ? requestedCity : `${requestedCity}市`;
    const spongeCity = COUNTY_LEVEL_CITY_TO_PREFECTURE[countyCity];
    if (!spongeCity) {
      cityNameList.push(requestedCity);
      continue;
    }
    cityNameList.push(spongeCity);
    derivedRegionNameList.push(countyCity);
    mappings.push({ requestedCity, spongeCity, spongeRegion: countyCity });
  }

  return {
    cityNameList: [...new Set(cityNameList)],
    derivedRegionNameList: [...new Set(derivedRegionNameList)],
    mappings,
  };
}

function readFactValue(value: unknown): unknown {
  if (isRecord(value) && 'value' in value) return value.value;
  return value;
}

function readHighConfidenceFactValue(value: unknown): unknown {
  if (!isRecord(value)) return null;
  return value.confidence === 'high' ? value.value : null;
}

function resolveCandidateAge(context: ToolBuildContext): number | null {
  const sources = [
    readHighConfidenceFactValue(context.highConfidenceFacts?.interview_info?.age),
    readFactValue(context.sessionFacts?.interview_info?.age),
    context.profile?.age,
  ];

  for (const source of sources) {
    const parsed = parseCandidateAge(source == null ? null : String(source));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * 解析候选人想要的用工形式。
 *
 * 只从已确定性提取的会话事实读取（高置信线索优先，其次会话事实），
 * 不依赖 LLM 入参——保证用工形式过滤始终生效，避免模型忘传。
 * 返回合法用工形式（全职/兼职/小时工/寒假工/暑假工）；"正式工/临时工" 等
 * 不同轴噪音词视为无效。
 */
function resolveCandidateLaborForm(context: ToolBuildContext): string | null {
  const sources = [
    readHighConfidenceFactValue(context.highConfidenceFacts?.preferences?.labor_form),
    readFactValue(context.sessionFacts?.preferences?.labor_form),
  ];
  if (context.currentLaborFormIntent?.kind === 'set') {
    return context.currentLaborFormIntent.value;
  }
  for (const source of sources) {
    if (typeof source !== 'string' || !isValidLaborForm(source)) continue;
    if (
      context.currentLaborFormIntent?.kind === 'clear' &&
      context.currentLaborFormIntent.clearedValues.some((value) => value === source)
    ) {
      return null;
    }
    return source;
  }
  return null;
}

interface JobAgeScreeningSummary {
  markdown: string;
  meta: {
    candidateAge: number;
    tolerance: {
      upperYears: number;
      lowerYears: number;
      lowerFloor: number;
    };
    counts: Record<AgeScreeningSignal['severity'], number>;
    boundaryExamples: Array<{
      jobId: number | null;
      label: string;
      ageRequirement: string;
      reason: string;
    }>;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildJobAgeScreeningSummary(
  jobs: any[],
  candidateAge: number | null,
): JobAgeScreeningSummary | null {
  if (candidateAge === null || jobs.length === 0) return null;

  const counts: Record<AgeScreeningSignal['severity'], number> = {
    pass: 0,
    boundary: 0,
    hard_reject: 0,
    unknown: 0,
  };
  const boundaryExamples: JobAgeScreeningSummary['meta']['boundaryExamples'] = [];

  for (const job of jobs) {
    const policy = buildJobPolicyAnalysis(job);
    const ageRequirement = policy.normalizedRequirements.ageRequirement;
    const signal = detectAgeBoundary({
      candidateAge,
      range: parseAgeRange(ageRequirement),
    });
    counts[signal.severity] += 1;

    if (signal.severity === 'boundary' && boundaryExamples.length < 3) {
      const basic = job.basicInfo ?? {};
      const storeName = basic.storeInfo?.storeName;
      const label = [basic.brandName, storeName, basic.jobNickName ?? basic.jobName]
        .filter(Boolean)
        .join('-');
      boundaryExamples.push({
        jobId: typeof basic.jobId === 'number' ? basic.jobId : null,
        label: label || '未命名岗位',
        ageRequirement,
        reason: signal.reason,
      });
    }
  }

  const lines = [
    '## 候选人年龄筛选提示',
    `- 候选人年龄：${candidateAge} 岁；年龄弹性口径与 precheck ageBoundary 一致：超岗位上限 ≤${AGE_BOUNDARY_UPPER_TOLERANCE_YEARS} 岁，或低于岗位下限 ≤${AGE_BOUNDARY_LOWER_TOLERANCE_YEARS} 岁且候选人 ≥${AGE_BOUNDARY_HANDOFF_FLOOR} 岁，属于 boundary，可继续推进并在约面前用 duliday_interview_precheck 复核。`,
    `- 本次结果年龄筛选：pass ${counts.pass} 个，boundary ${counts.boundary} 个，hard_reject ${counts.hard_reject} 个，unknown ${counts.unknown} 个。`,
  ];

  if (boundaryExamples.length > 0) {
    lines.push(
      `- boundary 示例（仍可推进，不得按严格年龄视同无岗）：${boundaryExamples
        .map((example) => `${example.label}（${example.ageRequirement}；${example.reason}）`)
        .join('；')}`,
    );
    lines.push(
      `- 只有 hard_reject 才算年龄硬拦截；存在 pass/boundary 时，禁止回复"没有一个接受 ${candidateAge} 岁"或直接拉群。`,
    );
  }

  return {
    markdown: lines.join('\n'),
    meta: {
      candidateAge,
      tolerance: {
        upperYears: AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
        lowerYears: AGE_BOUNDARY_LOWER_TOLERANCE_YEARS,
        lowerFloor: AGE_BOUNDARY_HANDOFF_FLOOR,
      },
      counts,
      boundaryExamples,
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ==================== 构建函数 ====================

const logger = new Logger('duliday_job_list');

const DESCRIPTION = `查询在招岗位列表。支持渐进式数据返回，按需获取岗位信息。

## 适用场景
- 候选人在问品牌、岗位、门店、距离、工资、排班、要求、福利、面试流程
- 你需要校验候选人刚提到的品牌、门店或岗位是否真实在招
- 你要回答"某品牌在某城市/区域有岗、没岗、最近在哪个区有岗"这类分布判断

## 检索机制（必读）
- 后端只做关键字精确匹配，**不做语义理解、不做拼写纠正、不做模糊改写**
- 传入的字段值必须命中数据库真实字符串，否则直接返回 0 条；与"该候选人意向不存在"完全不是一回事
- "上海大宁音乐广场店" 这种带城市前缀的口语化门店名很可能匹配不上真实门店名

## 筛选字段稳定性分级（决定该选哪个 filter）
- **高稳定（首选）**：jobIdList / brandIdList / projectIdList（数字主键，命中率最高）
- **中稳定**：cityNameList / regionNameList（标准行政区划，几乎不会拼错）
- **低稳定（易踩坑）**：storeNameList / projectNameList / brandAliasList（用户口语 vs 数据库实名常对不上）
- 选 filter 时 **从高稳定到低稳定**：能用 jobIdList 就不用 storeNameList；能用 regionNameList 拿候选集再筛门店，就不要直接 storeNameList

## 查询路径模板（覆盖 90% 场景）

| 用户场景 | 标准查询路径 |
| --- | --- |
| 问某具体岗位详情 | 优先 jobIdList 直查，不叠加其他 filter |
| 问"某区域有什么" / 候选人说自己在某区（"我在浦东""浦东这边"） | **默认按就近处理**：把区/县名传给 geocode 拿坐标 → 走 location 距离召回（这样能召回跨区但更近的门店，不会被区级边界卡掉）；未确认城市时你有高置信通识就把 city 一起传，没把握就 city 留空让工具按 unique/ambiguous 三态判定，不要先反问候选人。**只有**候选人明确要"只在某区内"的硬约束时，才用 cityNameList + regionNameList 精确过滤，按需补 jobCategoryList / brandIdList |
| 问"附近有什么" / 给了商圈/地标 | 先 geocode 拿坐标 → 传 location 半径；若结果 ≤ 1 条**必须**去掉 location 重查全市 |
| 用户接受了某门店但要换条件 | **先在 [会话记忆] 里查这门店所在的 region**，用 regionNameList 重查；不要直接拿口语门店名传 storeNameList |
| 用户问"还有别的品牌吗" | **不带 brandIdList 重查**当前区域，对比之前已展示的 brand 集合，告诉用户除了已推过的还有什么 |

## 结果数处理（必须遵守）
- **0 条**：本次查询失败。检查是否用了 storeNameList / brandAliasList 等低稳定字段；若是，立即换成 regionNameList / brandIdList 重试一次；若已经是稳定字段且仍为 0，**如实告知候选人"暂时没找到"**，不要再换条件硬试
- **1 条** 且候选人在问"还有别的吗 / 什么品牌 / 其他选择"：把这视为反常信号，**必须再放宽 1 个维度重查**——去掉 location，或扩大半径到全市，或去掉某个 brand/category filter。直接用 1 条结果回答"暂时没空缺"是错误的
- **≥ 2 条**：可以基于结果回复，无需扩面
- **同一轮内本工具调用次数硬上限 = 3**：第 4 次系统会直接拒绝。第 3 次仍未拿到可用数据时，应基于已有结果如实告知候选人，不要再继续猜 filter
- **结果只对最近 6 家给全文，更远的列在「### 更远的 N 家」里只有摘要行（店名/距离/薪资/年龄/jobId）**：推荐时优先用全文的最近几家；候选人明确问到摘要区某家的班次/福利/详细要求时，用该行的 jobId 走 jobIdList 单独重查拿全文，不要凭摘要行编造其未列出的字段

## 必须考虑的硬约束
- 本轮 system prompt 中若出现 [本轮查询硬约束] 段落，列出的字段都要在本轮查询里体现——要么作为 filter 参数，要么打开对应 include 开关后在结果集中自行排除
- 硬约束清单里每一项会注明如何处理（例如「填到 cityNameList」「开 includeHiringRequirement」等），以该注释为准；注释里没说"填到 XxxList"的字段不要硬塞进 filter
- 缺少任一硬约束的查询结果不得用于"该候选人场景下无空缺"的结论
- 候选人说"只周末"、"平时下班后"、"只能晚班"、"每周最多两天"、"做一休一"、"不上夜班"、"周四最早 19:30"这类班次/出勤限制时，必须把工作时间当硬约束；岗位结果里的"每天"、"周一至周日"、"做六休一"、"每周四/六/日都要给班"、"早开晚结全天时段/05:00-23:00"表示强排班要求，不能解释成任选一天、任选晚班或可只做周末
- "只周末/纯周末/每周最多两天/做一休一"都是比"每天/做六休一"更窄的约束；除非岗位明确写着"只周末/仅周末/可只排周末/每周可两天/可做一休一"，否则看到"每天/周一至周日/做六休一"必须视为不匹配，不得回复"周末能排"或"可以协调"

## 参数要点
- 至少提供一个有效筛选条件：城市、区域、品牌、门店、岗位类型、项目ID、岗位ID。根据 [会话记忆] 中候选人意向填入
- responseFormat 只能用 ["markdown"]，禁止 rawData
- 传 regionNameList 时必须同时传 cityNameList；系统已有高置信城市时直接使用，否则先追问城市。候选人只说"房山/合川/某区县附近"时，不能凭通识补"北京/重庆"等城市
- **regionNameList 是"区级行政区精确过滤"，不是"就近召回"——别拿候选人所在的区当它用**：后端对该字段做精确字符串匹配（库里存区级 storeRegionName），传 ["浦东新区"] 只返回注册地在浦东新区的店，**离候选人更近但在隔壁区的店会被整批漏掉**（badcase 6a3356e2：候选人在浦东，最近的店在宝山/杨浦 8km 内，传 regionNameList:["浦东新区"] 后查不到，实际按距离有 113 个在招岗）。所以候选人说"我在某区/某区这边"是**就近信号**，应 geocode 成坐标走 location；regionNameList 仅用于 ① 候选人明确"只在某区内"的硬约束，或 ② 从已知门店扩展回它所在区重查。
- **regionNameList 只接受能精确命中后端的"区/县级行政区名"（静安区、浦东新区、闵行区、朝阳区 等）**：后端对该字段做精确字符串匹配，库里存的是区级 storeRegionName。三档地名区别对待：
  - **乡镇/街道/新镇/新城/片区级地名（川沙、周浦、九亭、航头、唐镇、曹路、安亭、马陆 等）绝对不能直接塞进 regionNameList**——它们不是区级行政区名，精确匹配必然返回 0 条，而这绝不代表该片区没岗。必须先用 geocode 把它解析成"区级 district + 经纬度"，再用返回的 district 填 regionNameList，或用返回坐标走 location
  - 商圈/地标/街道门牌/详细地址（人民广场、陆家嘴、XX路123号 等）同理：**不得**直接当 regionNameList，先 geocode 或用位置分享坐标
  - 候选人只给了区名简称（"浦东""静安"）时，可先 geocode 拿到规范全称（浦东新区）再查，避免简称对不上后端区级实名
- **未确认城市禁默认**：[本轮高置信线索] 与 [会话记忆] 都未给出城市时，禁止默认任何城市做查岗或品牌承诺；候选人明确品牌但未给城市时，必须先简短确认"您想找哪个城市的岗位"，避免出现把"北京必胜客"默认按上海查的事故

## 按候选人当前问题精确开启数据开关（不要全部打开）

| 候选人当前在问什么                   | 开启的开关                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| 哪些门店、哪里近、位置方便吗         | 先 geocode，再把城市/区域/品牌连同 location.longitude / location.latitude 一起传；需要 10km / 5km 内筛选时补 location.range |
| 工资多少、薪资怎么样                 | includeJobSalary                                                              |
| 怎么排班、上班时间、能不能兼职       | includeWorkTime                                                               |
| 有什么要求、我符不符合、要不要健康证 | includeHiringRequirement                                                      |
| 福利待遇、包吃住、补贴政策           | includeWelfare                                                                |
| 怎么面试、什么时候面试、面试流程     | includeInterviewProcess                                                       |

## 回复展示要求
- 推荐 2 个及以上岗位时，每个岗位必须单独成行或成段，至少保留门店/岗位、核心薪资、**工作班次时间**、关键要求；禁止把多个岗位压缩在同一句中用顿号、逗号或"。、"串起来
- 多个岗位同品牌时，必须用门店名、区域/地址或距离把它们区分开；不能只说"有奥乐齐/肯德基"让候选人分不清是哪家
- **薪资必须主动展示**：本轮要做具体岗位推荐时，每条岗位都必须带上薪资数字/范围；工具返回阶梯薪资字段时，必须保留基础薪资 + 阶梯规则原文（如"基础 25/小时，做满 4 小时再加 5"），禁止简化为"约 X 元"或只说基础时薪。候选人没问也要给薪资，不主动给薪资容易让候选人转去竞品
- **工作班次时间必须主动展示**：本轮要做具体岗位推荐时，每条岗位都必须带上**具体上班时间段**（如"早班 7:30-9:30 / 中班 11:30-14:30"、"上班时间 09:00-18:00"），不得只用"早班/晚班/开档/前厅/后厨"等岗位名或时段名替代，也不得把"面试时间"误当成"上班班次"。**严禁**反问"距离和班次能不能接受？""你看这班次方便吗？"自己却没把班次时间说出来。工具返回的工作时间字段缺失/为空时，必须如实告知"班次门店再确认"，不得编造
- **福利信息主动展示**：本轮要做具体岗位推荐时，必须开 includeWelfare=true；工具返回的普通福利字段（员工餐/包吃住/餐补/补贴/转正机会/节假日加薪等，**不含保险/社保/五险一金**）若非空，必须在岗位介绍中按工具原文展示。候选人没问也要给——这些是候选人决策的重要因素，藏着等候选人问才答的"偷懒式介绍"会显著降低报名率。**保险/社保/五险一金属于敏感政策，主动推荐和福利介绍时严禁提及；只有候选人主动问到保险/社保时，才按工具返回字段如实回答，且不得把意外险/雇主责任险含糊说成社保或五险。** 福利字段为空时按"空头承诺禁忌"如实说"这个我再确认"
- **挑选式开场禁忌**：直接展示 1~2 个最匹配岗位的完整详情，不要先发"有 A/B/C 三个岗位/门店你想看哪个"再等候选人选；候选人挑选式开场容易直接放弃
- **岗位卡片必须紧凑**：单个岗位的"门店名/距离/薪资/班次/要求/工作内容"应**集中在 1-2 段**内描述（行内可用顿号/逗号/空格分隔），不要把同一岗位的各字段用"段间空行（即两个连续换行符）"拆成 5-8 个独立段落——后置的消息切分器（MessageSplitter）按段间空行拆成独立微信消息发出，会导致候选人几秒内连续收到 6-8 条同岗位碎片消息，体验"轰炸式人机"
- **薪资字段必须带单位**：所有薪资数字必须明示单位（如"元/小时""元/月""元/单"）；**严禁**把月薪和时薪并排展示而不带单位（反例：把"X 元/月"和"X 元/小时"写成"X、X"形式，候选人会误读单位）。多岗位混合展示时，所有岗位的薪资单位都要一并标出
- **同会话内同岗位不重复介绍**：同一会话内已经介绍过的岗位（同 jobId 或同门店名），后续轮**不要**重复发"薪资 X 元/班次 X 时间"等已说过的字段；后续轮只补新信息或推进流程，候选人追问某具体字段时再单独答
- 工作内容里出现"清洗灶台/打荷/收档/拖盘/出货"等行业短语时，必须用一句口语化解释展开，让候选人明白具体做什么；不要原样复读简短关键词

## 硬规则
- **福利追问必须用 jobId 实时重查**：候选人追问员工餐/工作餐/包吃住/餐补/住宿/交通补贴/晋升福利等具体福利时，即使 [会话记忆] 已带福利摘要，也必须用当前明确岗位的 jobId 传 jobIdList，并带 includeWelfare=true 重新调用本工具；记忆只用于定位 jobId，禁止直接据记忆回答。当前岗位不唯一时先确认具体门店，禁止拿另一门店福利代答
- **品牌/区域分布判断必须基于本工具结果**：候选人说出品牌不得用"XX是吧"直接确认，需先在当前已知范围验证在招；"杨浦没岗、虹口有岗"这类分布结论也必须先查。未查前只能说"我先帮你查下"
- **具体岗位/门店推荐必须带位置**：候选人给了商圈/地标/街道/详细地址/位置分享/经纬度等具体位置线索、且本轮要输出具体岗位或门店推荐时，必须先 geocode 或使用位置分享经纬度再调用本工具；不要因对方没明说"附近/离我近"就跳过。学校、校区、学院、小学部等地点名只代表位置，不代表学历
- **候选人给了 2 个及以上位置（多个位置分享/多个地标）**：对每个位置**各调用一次**本工具（可并行），分别传各自的 location 坐标；推荐时按位置分组展示，让候选人清楚各自附近有哪些岗位；**禁止**只查其中一个位置然后合并描述
- **推荐距离是硬约束**：只要本轮在推荐具体岗位/门店，结果必须满足业务距离阈值；超出阈值即使其他条件匹配也不得推荐。无有效 location 时只能回答在招情况或区域分布，不得输出具体推荐
- **距离数字只能引用本轮工具结果，严禁编造**："离你大概 X 公里"等距离数字只能来自本轮结果的距离字段（推荐模板卡片 / brandNearestStores 的 km 数）。本轮查询没传 location、结果里没有距离数据时，**禁止**凭地名印象/通识估算任何公里数；[会话记忆] 或历史 geocode 已有候选人坐标时应带 location 重查拿真实距离，拿不到就不提距离数字，改说"具体距离我帮你再确认下"。编造的距离会被候选人当场识破并引发投诉（badcase 6a266b51536c9654027cbf40：重查时丢了 location，结果无距离数据，Agent 编出"大概 5 公里"，实际 10km+，候选人怒斥"说话不算话"）
- **同品牌按距离最近优先**：候选人有 brand intent 时（明确说出品牌名 / 反复指代某品牌），先看 queryMeta.brandNearestStores 同品牌最近门店列表；同品牌返回多家时，必须按 brandNearestStores 的距离升序展示，不得跳过更近的同品牌门店转推更远的同品牌门店
- **明确品牌意向时不静默换品牌**：候选人明确说出"找成都你六姐 / 我想去肯德基"时，brand 必须进 brandIdList；**不得**主动反问"看看其他品牌吗"，更不得默默换成其他品牌推荐。本工具会在 brandAliasList 非空时硬过滤结果到该品牌；如果你想跨品牌推就别把 brandAliasList 填上去——但候选人明确品牌意向时禁止省略该字段
- **点名品牌豁免距离上限——0 条时先放宽距离复查再下结论**：候选人主动点名的品牌不受 max_recommend_distance_km（约 10km）约束（该阈值只约束 Agent 主动推荐）。按候选人位置在距离上限内查该品牌得 **0 条**时，**禁止**直接说"暂时没有 X 品牌的岗位"或拉群收口，必须**对该品牌放宽距离再查一次**（去掉 location.range 或放大到 30000，仅保留 brand 过滤 + 城市/坐标）：
  - 放宽后查到较远门店 → 如实告知最近门店大致距离让候选人决定（"X 最近的门店离你大概 14 公里，稍远，能接受吗"），**严禁**把"超距离"说成"没有/暂无在招"——候选人常在 BOSS 等平台已看到该品牌，谎称没有会直接流失
  - 只有放宽后该品牌在**整个城市**仍 0 条，才告知"X 品牌目前你所在城市暂无在招"，再按"无岗时的动作链"收口
- **缺位置不要直接返回 0 条**：调本工具前必须确认候选人位置（cityNameList 或 location 坐标）。**禁止**在候选人没明示位置时直接把工具结果当"无岗"收口拉群——候选人的真实意图可能是"还没说位置"而不是"没岗"。无位置上下文时先回复一句中性询问"请问您方便面试的城市/区域是哪里？"再决定下一步，不要把"工具 0 条"等同于"候选人无意向"
- **跨城市无岗禁反问扩张**：当候选人所在城市的结果为 0 条时，按 noMatchScript 原文照念给候选人，**严禁**反问"那看看其他城市吗 / 北京没有看看上海吗"等扩张式追问；候选人未来主动提其他城市才重查，否则一律走拉群兜底
- **禁止推断品牌地理分布**：工具返回 0 条不代表该品牌只在其他城市运营。**严禁**用"这个品牌目前主要在 XX 开店 / XX 才有"等措辞——本工具只能确认当前查询范围内有无在招岗位，不掌握品牌全国门店分布。0 条时只能说"暂时没查到 XX 品牌的在招岗位"
- **Agent 自推岗位不适用品牌锁死**：如果候选人并未主动指定品牌，而是你上一轮先推荐了某品牌/门店，候选人只是说"可以"或补收资资料，则该品牌不是硬性 brand intent。后续发现该岗位年龄/性别/班次/学历等条件不匹配时，必须先去掉 jobIdList / brandIdList / brandAliasList，保留候选人的位置、年龄、身份、时间窗等硬约束重查，并基于新结果推荐可匹配岗位；不要直接 request_handoff，也不要用"明确品牌意向"规则阻止换岗自救
- **工时长度反查**：候选人说"时间长一点的 / 工时长 / 全天班 / 想做半天以上"等工时偏好时，必须开 includeWorkTime=true 并基于工作时间字段重新筛选；若结果集仍以短班为主，先告知"附近主要是短班"再问是否扩大区域，不要继续把短班包装成"差不多"
- **首次推荐必须开 includeHiringRequirement + includeWorkTime**，把关键要求 + 工作班次时间随岗位信息一起告知让候选人自行判断；严禁推完岗位再逐个追问个人条件去做比对，更严禁反问"班次能不能接受"自己却没说班次时间
- **推荐文案必须严格按"📣 推荐对话用模板"卡片的固定格式输出**：每个岗位四行（标题 = 品牌（门店）- 岗位，距离；班次行；薪资行；要求行），**不得删除或合并任一行**。每行的具体取值须结合该岗位下方详情和备注组织完整信息——例如薪资行须包含备注中的阶梯/节假日等补充薪资，而非只写结构化字段的基础时薪。漏掉班次行、薪资行或门店行都属于不合格推荐
- **班次行必须列全工具返回的所有档位，不得只报候选人偏好的那一档**：含多档时连同排班关系（可选其一 / 全部需出勤等）原样转述，排班方式以工具为准、不自行假定；只挑一档会让候选人误以为是纯某班岗，报名后被排到没告知的班次
- **无岗时的动作链**：候选人范围内 0 条结果时，按以下顺序收口：
   1. 第一次 0 条 → 在合理范围内放宽一次（同城邻区 / 同品牌邻店 / 放宽距离阈值），且本轮直接执行放宽查询，不向候选人多问一句
   2. 放宽后仍 0 条 = "无替代"，必须直接告知候选人"暂时没有合适岗位"并调用 invite_to_group 拉群维护
   3. 严禁继续反问候选人"那别的区域 / 别的品牌 / 别的城市看看吗"；候选人主动表达扩张意愿前不再继续扩查，否则会陷入"反复问位置→反复无岗"的空转
   4. **候选人主动追问"别的地区有吗 / 别的品牌呢 / 还有其他吗"时本规则同样适用**——必须基于本轮工具结果直接告知"该品牌/城市暂时无岗 + 拉群维护"，不得借候选人的追问继续展开"其他品牌可以吗 / 看看长沙吗 / 上海杭州看看"等扩张推荐
   5. **历史轨迹打破**：即使 [会话记忆] 或对话历史里 Agent 自己上一轮提议过"换品牌/换地区/看看其他城市"，本轮一旦工具结果证实无岗，也必须打破这条轨迹直接收口，不得顺承延续旧的反问思路
   6. **结果非空但全部不匹配**：返回的岗位全部与候选人当前硬约束冲突（如候选人要白天班但结果全是夜班、候选人年龄对所有结果都是 ageBoundary.severity="hard_reject"），视同"0 条有效结果"，必须至少放宽一个维度（优先清空 jobCategoryList）重查一次；仅在放宽后仍无有效匹配时，才走上面的兜底路径。年龄判断必须沿用 precheck 弹性口径：超岗位上限 ≤3 岁、或低于下限 ≤2 岁且候选人 ≥23 岁，属于 boundary，可继续推进；例如候选人 52 岁遇到 20-50 岁 / 40-50 岁岗位，不得说"没有一个接受 52 岁"、不得按无岗拉群，后续用 duliday_interview_precheck 复核
   7. **回看候选岗位池**：新搜索无有效匹配时，必须回看 [会话记忆] 的「上轮候选岗位池」，检查是否有之前未推荐但可能匹配候选人新约束的岗位（如岗位名含"早班/晚班/开档"等班次关键词、年龄范围更宽的岗位）；候选池中有潜在匹配时，用 jobIdList 精确查询这些岗位的详情再推荐，不得仅凭本轮搜索结果就判定"附近无合适岗位"
- **包餐/工作餐/餐补硬偏好**：候选人说"没饭吃不去了 / 拉倒了 / 不考虑 / 必须包饭"等，视为硬性拒绝或强偏好；不要安慰成"附近吃饭方便"，也不要继续收面试资料。若要继续推荐，必须本轮调用本工具且带 includeWelfare=true 查包餐/餐补/福利信息；没有匹配就说明暂时没有合适的包餐岗位，并调用 invite_to_group 维护
- **面试相关字段**：推进面试时优先读工具结果中的「约面重点」；工具没明确时间不得编造；相对当前时间已过期的日期限制视为历史备注，不得当作当前规则输出

## 空头承诺禁忌
- 工具未返回某福利字段（工作餐/包餐/餐补/班车/补贴等）时，不得说"有 / 没有 该福利"；只能说"这个我再帮你确认下"
- 阶梯薪资必须保留基础时薪 + 阶梯规则原文（例如"基础 25/小时，做满 4 小时再加 5"），禁止简化为"约 X 元"或"固定 X 元/小时"
- **阶梯薪资的累计周期禁止说成"永久累计"**：阶梯档位（如"满 40 小时 26 元、满 80 小时 28 元"）的工时累计是**按月结算、每个自然月清零重新累计**，不是一次升档以后就永远按最高档。候选人问"是一直累计吗 / 下个月也按最高档吗 / 后面一直 28 吗"时，必须明确告知"每月重新累计、次月从基础档起算"，**严禁**回答"对，以后一直按 28"或含糊成"看门店、有的按月有的按季度"——按月清零是平台口径，说错会导致候选人结算时工资对不上
- 历史助手回复说过的门店事实不能当本轮事实复述；本轮要给候选人新的具体推荐时，必须以本轮工具结果为准；只有 [当前焦点岗位] 等记忆字段是稳定的，可以直接承接
- **工具未返回的业务事实禁止用训练知识/通识补充**：候选人追问"日结具体哪天到账 / 这家面试是线上还是线下 / 同品牌能不能跨店 / 全职岗还是兼职岗 / 排班是固定还是灵活 / 试用期多久 / 经验要求"等业务规则时，若本轮工具结果没明示该字段，必须说"这个我再帮你确认下"或按 request_handoff 转人工，**严禁**用"一般日结当天结 / 同品牌跨店没问题 / 应该是全职"等通识/经验性回答
- **学生身份不能由缺省反推**：候选人是学生/在读/准研究生时，只有工具明确写"学生可/接受学生/学生兼职和社会兼职都可"才能说接受学生；figure=不限、学历够、未写学生限制、工具未返回学生字段，都不能说"身份没限制/没问题"，必须说"这个身份我再确认下"。
- **门店运营状态禁编造**：候选人问"X 店关了吗 / 是不是搬了 / 撤店了"等门店状态问题时，本工具只能确认"是否有在招岗位"（jobs 数组是否为空），**不掌握**门店实际营业 / 装修 / 关店 / 搬迁 / 招满 等运营状态。本轮工具结果为空时只能答"目前查不到 X 在招岗位"，**严禁**用"可能关店调整了 / 应该是搬了 / 估计招满了 / 可能在装修"等推测措辞。候选人坚持要门店实际状态时，按 request_handoff 转人工。
- **同会话同字段多次查询结果不一致时相信最新一次**：本会话先后多次调用本工具，若同一门店/品牌/区域的"是否在招/班次/薪资/年龄要求"等字段前后返回不同，必须以**最新一次**结果为准，并自洽地回复；不得既承认上轮的"在招"又承认本轮的"无空缺"造成人格分裂。同时必须用一句衔接（"刚再核了一下，这家目前看下来确实没空缺了"），不要让候选人在前后矛盾间困惑`;

export function buildJobListTool(
  spongeService: SpongeService,
  opsEventsRecorder: OpsEventsRecorderService,
  geocodingService: GeocodingService,
): ToolBuilder {
  return (context) => {
    const spongeTokenContext = buildSpongeTokenContext(context);
    const fetchJobs = (params: Parameters<SpongeService['fetchJobs']>[0]) =>
      spongeTokenContext
        ? spongeService.fetchJobs(params, spongeTokenContext)
        : spongeService.fetchJobs(params);
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        cityNameList = [],
        regionNameList = [],
        brandAliasList: brandAliasListInput = [],
        brandIdList = [],
        projectNameList = [],
        projectIdList = [],
        storeNameList = [],
        searchJobName,
        jobCategoryList = [],
        jobIdList = [],
        settlementPeriodList = [],
        location,
        responseFormat = ['markdown'],
        includeBasicInfo = true,
        includeJobSalary = true,
        includeWelfare = true,
        includeHiringRequirement = true,
        includeWorkTime = false,
        includeInterviewProcess = false,
        candidateScheduleConstraint,
      }) => {
        const normalizedCityNameList = cityNameList.map((city) => city.trim()).filter(Boolean);
        const normalizedRegionNameList = regionNameList
          .map((region) => region.trim())
          .filter(Boolean);

        // 备注品牌确定性兜底：模型本轮没传任何品牌（brandAliasList/brandIdList 均空）时，
        // 用 prep 从企微备注解析出的目标品牌兜底为 brandAliasList，实现「备注品牌优先召回」
        // （纯提示词驱动经实测不可靠，模型会忽略备注按距离推）。候选人本轮点名了别的品牌时
        // 模型会自己把 brand 传进来，brandAliasList 非空就不会触发兜底。
        const nicknameAliasValidation = rejectUnverifiedNicknameBrandAliases(
          brandAliasListInput,
          context,
        );
        let brandAliasList = nicknameAliasValidation.accepted;
        if (nicknameAliasValidation.rejected.length > 0) {
          logger.warn(
            `拦截未经品牌库验证的昵称品牌参数: ${JSON.stringify(nicknameAliasValidation.rejected)}`,
          );
        }
        let brandAliasSource: 'input' | 'contact_remark' | 'session_facts' | 'none' =
          brandAliasList.length > 0 ? 'input' : 'none';
        const contactBrandAliases = context.contactBrandAliases ?? [];
        if (
          brandAliasList.length === 0 &&
          brandIdList.length === 0 &&
          contactBrandAliases.length > 0
        ) {
          brandAliasList = contactBrandAliases;
          brandAliasSource = 'contact_remark';
          logger.log(`从企微备注自动兜底 brandAliasList: ${JSON.stringify(brandAliasList)}`);
        }
        // 会话品牌事实兜底（badcase recvjFFKcZPsiC 想找大米先生却被跨品牌推荐）：
        // 候选人早前轮次点名的品牌已被 fact-extraction 持久化到 sessionFacts.preferences.brands，
        // 模型本轮忘带品牌入参时确定性拉回，与 Phase 3.1 的 schedule_constraint 兜底同模式。
        // 备注品牌优先级更高（引流来源，已实测校准）；候选人本轮点名新品牌时模型会自己传参，不触发兜底。
        const sessionBrands = (context.sessionFacts?.preferences?.brands ?? []).filter(
          (brand): brand is string => typeof brand === 'string' && brand.trim().length > 0,
        );
        if (brandAliasList.length === 0 && brandIdList.length === 0 && sessionBrands.length > 0) {
          brandAliasList = sessionBrands;
          brandAliasSource = 'session_facts';
          logger.log(`从会话品牌事实自动兜底 brandAliasList: ${JSON.stringify(brandAliasList)}`);
        }
        // Phase 3.1：候选人在更早轮次表达过的班次硬约束已经被 fact-extraction 持久化到
        // sessionFacts.preferences.schedule_constraint。Agent 本轮调本工具时若没显式
        // 传 candidateScheduleConstraint，自动从 sessionFacts 兜底，避免 Agent 忘了
        // 拉回候选人原话（badcase 簇 schedule_constraint_forgotten）。
        // 升级（badcase batch_6a4e430dce406a6aee7a3421）：模型传了约束也不再整体采信——
        // 候选人要"周六的兼职"，模型却传 {onlyEvenings:true} 把"周六"弄丢。持久化约束
        // 是候选人原话的高置信沉淀，改为与模型入参逐字段合并：模型显式传的字段保留
        // （本轮新信息优先），漏传的字段由持久化约束补齐；空对象 {} 视同未传
        // （此前 {} 是 truthy，会绕过兜底）。
        const persistedConstraint = context.sessionFacts?.preferences?.schedule_constraint ?? null;
        if (persistedConstraint) {
          const persistedInput = {
            ...(persistedConstraint.onlyWeekends && { onlyWeekends: true }),
            ...(persistedConstraint.onlyEvenings && { onlyEvenings: true }),
            ...(persistedConstraint.onlyMornings && { onlyMornings: true }),
            ...(persistedConstraint.maxDaysPerWeek !== null && {
              maxDaysPerWeek: persistedConstraint.maxDaysPerWeek,
            }),
          };
          if (Object.keys(persistedInput).length > 0) {
            const modelInput = candidateScheduleConstraint ?? {};
            const merged = { ...persistedInput, ...modelInput };
            const addedFields = Object.keys(persistedInput).filter((key) => !(key in modelInput));
            if (addedFields.length > 0) {
              logger.log(
                `sessionFacts 班次约束合并：模型入参 ${JSON.stringify(modelInput)} 缺 [${addedFields.join(',')}]，` +
                  `由持久化约束补齐 → ${JSON.stringify(merged)}`,
              );
            }
            candidateScheduleConstraint = merged;
          }
        }

        // 缺城市上下文兜底：用户给了区/门店/商圈级位置线索，但既没传 cityNameList
        // 也没有 location 坐标（geocode 拿到的经纬度）。badcase 簇 missing_city_context
        // （v3nexby8/spen553o/o1intrqf/jqhr3kku）：Agent 在没有城市的情况下直接预设
        // "是上海吗" 或脑补"合川=重庆"，导致跨城误判。
        const hasCity = normalizedCityNameList.length > 0;
        const hasCoordinates = location?.longitude != null && location?.latitude != null;
        const hasRegionalIntent =
          normalizedRegionNameList.length > 0 ||
          storeNameList.length > 0 ||
          projectNameList.length > 0;

        if (hasRegionalIntent && !hasCity && !hasCoordinates) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.JOB_LIST_MISSING_CITY_CONTEXT,
            outcome: '查询前置缺城市',
            replyInstruction:
              '查询前必须先确定候选人所在城市，按下面顺序处理：' +
              '(1) 先检查 [会话记忆] / [历史对话] 中候选人是否已明示城市；' +
              '(2) 候选人提到的地点不是通用后缀类（万达广场/天街/火车站/购物中心 等跨城同名）时，' +
              '优先调用 `geocode` 工具——你对地名→城市映射有高置信通识就把城市传给 geocode，' +
              '没把握就 city 留空让 geocode 自己判定；geocode 返回 unique 即可拿到 city 重调本工具；' +
              '(3) 仅当 geocode 报 GEOCODE_AMBIGUOUS_SUFFIX 或 ambiguous 多候选时，才中性反问候选人所在城市；' +
              '反问必须中性，不得带具体城市名（"是 X 城市吗"会构成诱导）。',
          });
        }

        // 兜底：剔除 jobCategoryList 中的用工形式词（兼职/全职/小时工/寒假工/暑假工 等）。
        // 用工形式是岗位 laborForm 属性，不是岗位工种，不应作为 category 查询条件。
        const { cleaned: sanitizedJobCategoryList, removed: removedCategoryWords } =
          stripLaborFormFromCategories(jobCategoryList);
        if (removedCategoryWords.length > 0) {
          logger.warn(
            `jobCategoryList 兜底剔除用工形式词: ${removedCategoryWords.join('、')}（原始: ${JSON.stringify(jobCategoryList)}）`,
          );
        }

        const options = {
          includeBasicInfo,
          includeJobSalary,
          includeWelfare,
          includeHiringRequirement,
          includeWorkTime,
          includeInterviewProcess,
        };

        // 当前轮高置信事实会覆盖旧会话事实。提前解析一次，除了成功结果过滤外，
        // 查询异常时也要禁止“暑假工意向 → 回退历史普通兼职岗”的绕过路径。
        const candidateLaborForm = resolveCandidateLaborForm(context);

        // 兜底：传了 lng/lat 但漏传 range 时，从业务阈值 max_recommend_distance_km 派生。
        // 上游 API 在 location.longitude/latitude 存在而 range 缺失时返回 code=10000，
        // 必须在请求前补齐，避免静默退化为 total=0。
        const maxKmThreshold = context.thresholds?.find(
          (t) => t.flag === 'max_recommend_distance_km',
        );
        const effectiveLocation =
          location?.longitude != null && location?.latitude != null && location.range == null
            ? {
                ...location,
                range:
                  maxKmThreshold?.max != null ? Math.round(maxKmThreshold.max * 1000) : undefined,
              }
            : location;

        // 点名品牌意向：品牌查询有独立的"距离豁免 + 0 条放宽"逻辑（line 425-427），区级兜底
        // 一律绕开，避免给品牌结果套上 maxKm 距离帽把远处的品牌门店藏掉。brandAliasList 已含
        // 企微备注兜底，故备注品牌也走品牌豁免。
        const hasBrandIntent = brandAliasList.length > 0 || brandIdList.length > 0;

        // 旧会话事实或模型仍可能传 cityNameList=["延吉"]。在工具边界再次规范化，
        // 确保无坐标的全城查询也能命中，而不只依赖下方 location-only 恢复。
        const cityFilterNormalization = normalizeSpongeCityFilters(normalizedCityNameList);
        const normalizedQueryRegionNameList = [
          ...new Set([
            ...normalizedRegionNameList,
            ...cityFilterNormalization.derivedRegionNameList,
          ]),
        ];

        // 有坐标时丢弃 regionNameList：坐标（候选人真实位置）才是就近信号，区级精确过滤
        // 与坐标 AND 在一起只会把隔壁区更近的门店排除掉（badcase 6a3356e2 同源）。模型偶尔
        // 同时传 region+location，此处统一归一成纯距离召回，坐标比区中心更精确。
        // 品牌意向不动（品牌豁免距离上限，交由品牌专属逻辑处理）。
        let regionDroppedForCoords = false;
        if (hasCoordinates && normalizedQueryRegionNameList.length > 0 && !hasBrandIntent) {
          regionDroppedForCoords = true;
          logger.log(
            `已传坐标，丢弃 regionNameList=[${normalizedQueryRegionNameList.join(',')}] 改纯距离召回，避免区级过滤排除跨区更近门店`,
          );
        }
        const regionNameListForQuery = regionDroppedForCoords ? [] : normalizedQueryRegionNameList;

        let fetchBaseParams = {
          cityNameList: cityFilterNormalization.cityNameList,
          regionNameList: regionNameListForQuery,
          brandAliasList,
          brandIdList,
          projectNameList,
          projectIdList,
          storeNameList,
          searchJobName: searchJobName?.trim() || undefined,
          jobCategoryList: sanitizedJobCategoryList,
          jobIdList,
          salaryPeriodNameList: settlementPeriodList.map((p) => p.trim()).filter(Boolean),
          location: effectiveLocation,
          options,
        };
        try {
          let storeMatchStrategy: 'api_exact' | 'local_fuzzy_match' = 'api_exact';
          let jobCategoryMatchStrategy: 'api_exact' | 'local_keyword_match' = 'api_exact';
          let distanceScanPages = 1;
          let distanceScanTruncated = false;
          // 观测：区级兜底是否尝试过（命中触发条件并跑了 geocode/距离召回），
          // 与是否最终采纳（regionRelaxedToLocation 非空）区分开——便于判断"没采纳"是
          // 因为没触发，还是触发了但距离召回没找到更优结果（如带工种过滤后范围内 0 条）。
          let regionRelaxAttempted = false;
          let regionRelaxedToLocation: null | {
            region: string;
            longitude: number;
            latitude: number;
            beforeCount: number;
            afterCount: number;
          } = null;
          let cityFilterRecovery: null | {
            attempted: true;
            applied: boolean;
            requestedCities: string[];
            candidateCount: number;
            recoveredCount: number;
          } = null;

          // 首次请求
          let { jobs, total } = await fetchJobs(fetchBaseParams);

          // 县级市行政层级兜底（生产 badcase 6a4f83a5ce406a6aeeeab4b2）：
          // 候选人说“延吉市铁南”，确定性提取曾把“延吉”强制放进 cityNameList；但海绵
          // 存的是 city=延边朝鲜族自治州、region=延吉市，导致正确坐标与错误 city 做 AND
          // 后返回 0。已有精确坐标时，0 条后去掉 city 做一次 location-only 召回；为了避免
          // 边界坐标把邻市岗位带回来，只采纳 storeCityName/storeRegionName 仍能匹配原城市名
          // 的岗位。恢复查询失败不覆盖原始“0 条”语义。
          if (jobs.length === 0 && hasCoordinates && normalizedCityNameList.length > 0) {
            try {
              const locationOnly = await fetchJobs({ ...fetchBaseParams, cityNameList: [] });
              const recoveredJobs = filterJobsToRequestedAdministrativeArea(
                locationOnly.jobs,
                normalizedCityNameList,
              );
              cityFilterRecovery = {
                attempted: true,
                applied: recoveredJobs.length > 0,
                requestedCities: normalizedCityNameList,
                candidateCount: locationOnly.jobs.length,
                recoveredCount: recoveredJobs.length,
              };
              if (recoveredJobs.length > 0) {
                jobs = recoveredJobs;
                total = recoveredJobs.length;
                // 后续分页若触发，不能重新带回已证实错误的 city filter。
                fetchBaseParams = { ...fetchBaseParams, cityNameList: [] };
                logger.warn(
                  `城市层级过滤兜底命中：cityNameList=${JSON.stringify(normalizedCityNameList)} 原查询 0 条，` +
                    `location-only 候选 ${locationOnly.jobs.length} 条，行政区复核后恢复 ${recoveredJobs.length} 条`,
                );
              }
            } catch (error: unknown) {
              const reason = error instanceof Error ? error.message : String(error);
              logger.warn(`城市层级过滤兜底查询失败，保留原始 0 条结果: ${reason}`);
            }
          }

          // 门店名模糊匹配回退：去掉 storeNameList 后在同范围（城市/区域/品牌等）宽查，
          // 再按门店名本地模糊过滤。不能查全量（{ options }）——上游要求至少一个筛选
          // 条件，无筛选请求会被拒（"查询岗位时至少提供一个筛选条件"），把"该门店已
          // 无在招岗位"这一合法结果污染成接口故障（badcase 6a266b51536c9654027cbf40）。
          if (jobs.length === 0 && storeNameList.length > 0) {
            const fallback = await fetchJobs({ ...fetchBaseParams, storeNameList: [] });
            if (fallback.jobs.length > 0) {
              /* eslint-disable @typescript-eslint/no-explicit-any */
              const lowerKeywords = storeNameList.map((s) => s.toLowerCase());
              const filtered = fallback.jobs.filter((job: any) => {
                const storeName = (job.basicInfo?.storeInfo?.storeName || '').toLowerCase();
                return lowerKeywords.some((kw) => storeName.includes(kw));
              });
              /* eslint-enable @typescript-eslint/no-explicit-any */
              if (filtered.length > 0) {
                storeMatchStrategy = 'local_fuzzy_match';
                jobs = filtered;
                total = filtered.length;
              }
            }
          }

          // 岗位类型本地兜底：当 API 对岗位类型检索不稳定时，退回到同条件宽查后，
          // 仅基于真实岗位字段做本地匹配，不依赖手写别名字典。
          if (jobs.length === 0 && sanitizedJobCategoryList.length > 0) {
            // 必须复用已经过县级市映射、坐标/区域归一化的基础请求，只放宽岗位类型。
            // 重新从原始 city/region 组装会让“延吉 → 延边州 + 延吉市”等映射失效。
            const fallback = await fetchJobs({ ...fetchBaseParams, jobCategoryList: [] });

            /* eslint-disable @typescript-eslint/no-explicit-any */
            const filtered = filterJobsByRequestedCategories(
              fallback.jobs as any[],
              sanitizedJobCategoryList,
            );
            /* eslint-enable @typescript-eslint/no-explicit-any */
            if (filtered.length > 0) {
              jobCategoryMatchStrategy = 'local_keyword_match';
              jobs = filtered;
              total = filtered.length;
            }
          }

          // 区级精确过滤 → 距离召回 确定性兜底（修复生产 badcase 6a3356e2）。
          // 模型把"候选人所在的区"塞进 regionNameList 时，后端做区级 storeRegionName 精确匹配，
          // 会把离候选人更近但注册地在隔壁区的门店整批漏掉（候选人在浦东，最近的店在宝山/杨浦
          // 8km 内，被 regionNameList:["浦东新区"] 卡没；而浦东本区岗位数并不低，靠"结果数偏低"
          // 阈值兜不住）。纯提示词不可靠（实测 qwen3.7-plus 仍 ~15-20% 退回 region）。
          // 策略：只要模型用区级精确过滤、却没给坐标（=没有就近信号、结果无法按距离排），
          // 就 geocode 区中心 → 去掉 regionNameList 改走 location 距离召回，跨区按真实距离找
          // 最近门店；距离召回拿到结果即采纳。少数"只在某区内"的硬约束会因此带出区界外几公里的
          // 门店，属可接受取舍（概率低、距离仍受 maxKm 约束、文案可注明）。仅在距离召回为空时
          // 保留原区级结果，不把情况改差。
          // 触发面收窄到只命中真实 bug 形态，避免误伤其他场景：
          // - 仅单区（多区无法用一个区中心代表，保持区级精确，不动）
          // - 非品牌意向（品牌走豁免逻辑，见 hasBrandIntent）
          // - 已配距离阈值（无 maxKm 时 range 缺失会被后端拒，宁可不兜底）
          // 注意：不限制"必须以 区/县/旗 结尾"——区名简称（宝山/浦东/静安）和乡镇名（川沙/九亭）
          // 同样是就近信号且精确匹配易漏/落空，geocode(name, city) 在城市已知时能稳妥拿到坐标，
          // 自动改距离召回优于让模型再走一轮 NEEDS_GEOCODE 引导；geocode 失败则不采纳、自然回落。
          const eligibleForRegionRelax =
            normalizedRegionNameList.length === 1 && // 仅单区
            !hasBrandIntent && // 非点名品牌（品牌豁免距离上限）
            maxKmThreshold?.max != null && // 已配距离阈值
            hasCity && // 有城市才能精准 geocode 区中心/地名坐标
            !hasCoordinates && // 模型没自己传坐标（=没有就近信号）
            jobIdList.length === 0 && // 不是主键精确查询
            storeNameList.length === 0 && // 不是按门店查（有独立兜底）
            !searchJobName?.trim(); // 不是按门店/地标模糊查
          if (eligibleForRegionRelax) {
            regionRelaxAttempted = true;
            const targetRegion = normalizedRegionNameList[0];
            const center = await geocodingService.geocode(targetRegion, normalizedCityNameList[0]);
            if (center?.longitude != null && center?.latitude != null) {
              const relaxedLocation = {
                longitude: center.longitude,
                latitude: center.latitude,
                range:
                  maxKmThreshold?.max != null ? Math.round(maxKmThreshold.max * 1000) : undefined,
              };
              const relaxed = await fetchJobs({
                ...fetchBaseParams,
                regionNameList: [],
                location: relaxedLocation,
              });
              if (relaxed.jobs.length > 0) {
                regionRelaxedToLocation = {
                  region: targetRegion,
                  longitude: center.longitude,
                  latitude: center.latitude,
                  beforeCount: jobs.length,
                  afterCount: relaxed.jobs.length,
                };
                jobs = relaxed.jobs;
                total = relaxed.total;
                // 让下游距离计算/排序 + 后续分页扫描都用区中心坐标、不再带区级过滤
                location = relaxedLocation;
                fetchBaseParams.regionNameList = [];
                fetchBaseParams.location = relaxedLocation;
                logger.log(
                  `区级精确过滤兜底：regionNameList=[${targetRegion}] 原 ${regionRelaxedToLocation.beforeCount} 条，` +
                    `已 geocode 区中心(${center.longitude},${center.latitude})改走 location 距离召回，得 ${relaxed.jobs.length} 条`,
                );
              }
            }
          }

          // 距离计算 + 阈值过滤
          const locationLatitude = location?.latitude;
          const locationLongitude = location?.longitude;
          const hasUserCoords = locationLatitude != null && locationLongitude != null;
          const distanceThreshold = context.thresholds?.find(
            (t) => t.flag === 'max_recommend_distance_km',
          );
          const maxKm = distanceThreshold?.max;

          // 关键优化：在距离过滤前补抓后续页，避免“第一页只有1条近距离岗位”
          if (hasUserCoords && maxKm != null && total > jobs.length) {
            const totalPages = Math.ceil(total / DEFAULT_PAGE_SIZE);
            const maxPagesToScan = Math.min(totalPages, DISTANCE_SCAN_MAX_PAGES);
            distanceScanTruncated = maxPagesToScan < totalPages;

            if (maxPagesToScan > 1) {
              const mergedJobs = [...jobs];
              const seenJobIds = new Set<number>();
              for (const job of mergedJobs) {
                const jobId = job?.basicInfo?.jobId;
                if (typeof jobId === 'number') seenJobIds.add(jobId);
              }

              for (let pageNum = 2; pageNum <= maxPagesToScan; pageNum += 1) {
                const pageResult = await fetchJobs({
                  ...fetchBaseParams,
                  pageNum,
                  pageSize: DEFAULT_PAGE_SIZE,
                });
                distanceScanPages = pageNum;

                if (!pageResult.jobs.length) break;
                for (const job of pageResult.jobs) {
                  const jobId = job?.basicInfo?.jobId;
                  if (typeof jobId === 'number') {
                    if (seenJobIds.has(jobId)) continue;
                    seenJobIds.add(jobId);
                  }
                  mergedJobs.push(job);
                }
              }

              jobs = mergedJobs;
              total = mergedJobs.length;
            }
          }

          if (hasUserCoords) {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            for (const job of jobs as any[]) {
              const store = job.basicInfo?.storeInfo;
              if (store?.latitude != null && store?.longitude != null) {
                job._distanceKm = haversineDistance(
                  locationLatitude!,
                  locationLongitude!,
                  Number(store.latitude),
                  Number(store.longitude),
                );
              }
            }

            if (maxKm != null) {
              const beforeCount = jobs.length;
              jobs = (jobs as any[]).filter(
                (job) => job._distanceKm == null || job._distanceKm <= maxKm,
              );
              total = jobs.length;
              if (beforeCount > 0 && jobs.length === 0) {
                return buildToolError({
                  errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
                  outcome: `附近 ${maxKm}km 内无符合岗位`,
                  replyInstruction:
                    '附近半径内已过滤为空。先尝试一次合理范围内的扩面（同城邻区 / 放宽距离 / 同品牌邻店），' +
                    '本轮直接执行，不要向候选人多问。' +
                    '若扩面后仍无结果，**严格按 noMatchScript.candidateMessage 原文照念给候选人，再调 invite_to_group 拉群**——' +
                    '不要自己改写承接句，不要跨品牌推荐。',
                  details: {
                    maxKm,
                    noMatchScript: buildNoMatchScript({
                      brandLabels: brandAliasList,
                      storeLabels: storeNameList,
                      cityLabels: normalizedCityNameList,
                      regionLabels: normalizedRegionNameList,
                      maxKm,
                      scheduleConstraintLabel: candidateScheduleConstraint
                        ? formatScheduleConstraintLabel(candidateScheduleConstraint)
                        : null,
                    }),
                  },
                });
              }
            }

            // 按距离排序（有坐标的在前，无坐标的在后）
            (jobs as any[]).sort((a, b) => {
              if (a._distanceKm == null && b._distanceKm == null) return 0;
              if (a._distanceKm == null) return 1;
              if (b._distanceKm == null) return -1;
              return a._distanceKm - b._distanceKm;
            });
            /* eslint-enable @typescript-eslint/no-explicit-any */
          }

          // Phase 1.C.3：候选人明确品牌意向（brandAliasList 非空）时硬过滤到该品牌，
          // 杜绝跨品牌乱推（badcase bb012h5c：找大米先生推史伟莎销售/消杀员）。
          // 过滤后 0 条 fall through 到下方 no-match 路径，触发 noMatchScript 拉群兜底。
          if (brandAliasList.length > 0) {
            const beforeBrandFilter = jobs.length;
            jobs = filterJobsToRequestedBrands(jobs, brandAliasList);
            if (jobs.length !== beforeBrandFilter) {
              total = jobs.length;
              logger.log(
                `品牌硬过滤：brandAliasList=${JSON.stringify(brandAliasList)} 剔除非匹配品牌 ${beforeBrandFilter - jobs.length} 条`,
              );
            }
          }

          if (jobs.length === 0) {
            // 乡镇/街道/新镇/地标级地名被误当 regionNameList（川沙、九亭、周浦 等）：后端只精确
            // 匹配区级 storeRegionName，这类地名必然命中 0 ≠ 该片区无岗（badcase
            // batch_6a2fabf0536c9654020e6683：候选人答"川沙"，Agent 直接 regionNameList=["川沙"]
            // 查 0 条就拉群收口）。无坐标、无高稳定主键、无品牌别名兜底时，引导 Agent 先 geocode
            // 把地名规范成区级 district + 经纬度再重查，而不是照 noMatchScript 拉群。
            // 判定：规范县级行政区名以 区/县/旗/市 结尾；裸地名（川沙）或区名简称（浦东）视为需 geocode。
            const suspectedTownshipRegions = normalizedRegionNameList.filter(
              (region) => !/[区县旗市]$/.test(region),
            );
            const hasHighStabilityFilter =
              jobIdList.length > 0 || brandIdList.length > 0 || projectIdList.length > 0;
            if (
              suspectedTownshipRegions.length > 0 &&
              !hasCoordinates &&
              brandAliasList.length === 0 &&
              !hasHighStabilityFilter
            ) {
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.JOB_LIST_REGION_NEEDS_GEOCODE,
                outcome: '区域名疑似乡镇/街道级，需先 geocode 规范化再重查',
                replyInstruction:
                  `本轮 regionNameList=${JSON.stringify(normalizedRegionNameList)} 查询命中 0 条，但其中` +
                  `${JSON.stringify(suspectedTownshipRegions)} 看起来是乡镇/街道/新镇/地标级地名（或区名简称），` +
                  '不是后端能精确匹配的区级行政区名——后端只精确匹配区级 storeRegionName，' +
                  '这类地名命中 0 ≠ 该片区无岗。**先调用 geocode 把它解析成区级 district + 经纬度，' +
                  '再用返回的 district 重填 regionNameList、或用返回坐标走 location，重查一次本工具**；' +
                  '不要据此判定无岗、不要照念 noMatchScript、不要直接 invite_to_group 拉群。' +
                  '若 geocode 仍无法解析或返回多城歧义，再按其 _replyInstruction 处理。',
                details: {
                  suspectedRegions: suspectedTownshipRegions,
                  cityLabels: normalizedCityNameList,
                },
              });
            }

            // brandAliasList 命中 0 时，先和会话最近推荐过的品牌池做同音/字形回指匹配，
            // 识别"刘姐妹"实指上轮推过的"成都你六姐"这类候选人口误（badcase
            // batch_6a0c074c536c9654029b6930：Agent 把口误"刘姐妹"当全新品牌判 0 拉群）。
            const fuzzySuggestions =
              brandAliasList.length > 0 && (context.recentBrandPool?.length ?? 0) > 0
                ? findBrandFuzzyMatches(brandAliasList, context.recentBrandPool ?? [])
                : [];

            // 匹配分歧度判定：
            // - 单一候选 / top1 比 top2 高 0.15 分以上 → 高置信，Agent 直接沿用该品牌
            //   （回复时用一句轻带过即可，不再单独反问，避免无谓 friction）
            // - 多个分数接近 → 低置信，反问澄清
            const topMatch = fuzzySuggestions[0] ?? null;
            const margin =
              fuzzySuggestions.length >= 2
                ? topMatch!.score - fuzzySuggestions[1].score
                : Number.POSITIVE_INFINITY;
            const fuzzyConfidence: 'high' | 'low' | 'none' = !topMatch
              ? 'none'
              : margin >= 0.15
                ? 'high'
                : 'low';

            let replyInstruction: string;
            let outcome: string;
            if (fuzzyConfidence === 'high') {
              outcome = '品牌别名疑似口误，已自动回指最近推荐品牌';
              replyInstruction =
                'brandAliasList 字面命中 0，但候选人输入与会话最近推荐的 **' +
                topMatch!.brandName +
                '** 高度同音回指（见 aliasFuzzyMatch.suggestions[0]）。**直接按该品牌继续推进**，' +
                '回复时用一句轻确认带过（如"成都你六姐这家…"）让候选人自然听到正确品牌名；' +
                '**不要单独反问"你是说 X 吗"，不要照念 noMatchScript，不要调 invite_to_group。' +
                '若需要重新拿岗位详情，从 [会话记忆] 已展示岗位里取 jobId 直查，避免重复 brandAliasList。' +
                '候选人后续若否认这个品牌，再按 noMatchScript 收口。';
            } else if (fuzzyConfidence === 'low') {
              outcome = '品牌别名疑似口误，候选品牌多个分数接近，需反问澄清';
              replyInstruction =
                'brandAliasList 字面命中 0，会话最近品牌池里存在多个同音/字形候选（见 aliasFuzzyMatch.suggestions），' +
                '分数差 < 0.15 无法判定指代哪一个。**用一句反问澄清**："你说的是 X 还是 Y？"——' +
                '不要直接答"没查到"，不要照念 noMatchScript，不要调 invite_to_group。';
            } else {
              outcome = '未找到符合条件的岗位';
              replyInstruction =
                '本次查询无匹配岗位。先核对是否用了 storeNameList / brandAliasList 等低稳定字段；' +
                '是则换 regionNameList / brandIdList 重试一次。' +
                '若已是高稳定字段仍为 0，**严格按 noMatchScript.candidateMessage 原文照念给候选人，再调 invite_to_group 拉群**——' +
                '不得自行改写承接句、不得跨品牌推荐、不得反问"换品牌 / 换城市 / 别的区域"；' +
                '候选人主动追问扩张时同样按此动作链处理。';
            }

            return buildToolError({
              errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
              outcome,
              replyInstruction,
              details: {
                cityFilterRecovery,
                noMatchScript: buildNoMatchScript({
                  brandLabels: brandAliasList,
                  storeLabels: storeNameList,
                  cityLabels: normalizedCityNameList,
                  regionLabels: normalizedRegionNameList,
                  maxKm: maxKm ?? null,
                  scheduleConstraintLabel: candidateScheduleConstraint
                    ? formatScheduleConstraintLabel(candidateScheduleConstraint)
                    : null,
                }),
                aliasFuzzyMatch:
                  fuzzyConfidence !== 'none'
                    ? {
                        brandAliasList,
                        confidence: fuzzyConfidence,
                        suggestions: fuzzySuggestions,
                      }
                    : null,
              },
            });
          }

          // 候选人班次硬约束过滤（同时给保留岗位标 _scheduleSemantic）。
          // 即使候选人没传约束，也要给所有岗位标语义，便于上层信号使用。
          const scheduleFilterResult = applyScheduleConstraint(jobs, candidateScheduleConstraint);
          jobs = scheduleFilterResult.jobs;
          total = jobs.length;
          if (
            candidateScheduleConstraint &&
            scheduleFilterResult.excluded.length > 0 &&
            jobs.length === 0
          ) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.JOB_LIST_SCHEDULE_FILTER_EMPTY,
              outcome: '班次约束过滤后无匹配岗位',
              replyInstruction:
                '本轮工具结果经候选人班次硬约束过滤后为空。' +
                '**严格按 noMatchScript.candidateMessage 原文照念给候选人**，再询问是否可以放宽时段；' +
                '若候选人不愿放宽，调用 invite_to_group 拉群维护。' +
                '禁止把被剔除的岗位再以"差不多"包装回去。',
              details: {
                queryMeta: {
                  scheduleFilter: {
                    applied: true,
                    excludedCount: scheduleFilterResult.excluded.length,
                    excludedExamples: scheduleFilterResult.excluded.slice(0, 3),
                  },
                },
                candidateConstraintLabel: formatScheduleConstraintLabel(
                  candidateScheduleConstraint,
                ),
                noMatchScript: buildNoMatchScript({
                  brandLabels: brandAliasList,
                  storeLabels: storeNameList,
                  cityLabels: normalizedCityNameList,
                  regionLabels: normalizedRegionNameList,
                  maxKm: maxKm ?? null,
                  scheduleConstraintLabel: formatScheduleConstraintLabel(
                    candidateScheduleConstraint,
                  ),
                }),
              },
            });
          }

          // 契约异常暴露：laborForm/partTimeJobType 不符合新契约的岗位数据不做兼容兜底，
          // 记 warn 并随 queryMeta 落库（message_processing_records），推动上游改数据本身。
          const laborFormAnomalies = collectLaborFormAnomalies(jobs);
          if (laborFormAnomalies.length > 0) {
            logger.warn(
              `岗位用工形式数据不符合契约（不做兼容，需修数据）: ${JSON.stringify(laborFormAnomalies.slice(0, 10))}` +
                (laborFormAnomalies.length > 10 ? ` ...共 ${laborFormAnomalies.length} 条` : ''),
            );
          }

          // 用工形式过滤：候选人想要任一合法用工形式时，按岗位 laborForm/partTimeJobType 结构化字段硬过滤。
          // 避免把别的用工形式包装成候选人想要的类型。
          // 候选人意向从确定性提取的会话事实读取，不依赖 LLM 入参，保证始终生效。
          const laborFormFilterResult = applyLaborFormConstraint(jobs, candidateLaborForm);
          const laborFormRelaxNotice = laborFormFilterResult.relaxedToFamily
            ? `⚠️ 附近暂无结构化字段严格标注为「${candidateLaborForm}」的岗位；以下是同为兼职形态` +
              '（兼职类型不同，如小时工/寒假工或未标细分）的岗位。介绍时**必须按每个岗位真实的用工形式/兼职类型说明**，' +
              `不得把它们统称或包装成「${candidateLaborForm}」；可向候选人说明工作形态相近、由其自行决定。`
            : null;
          const summerWorkerStrictNotice =
            candidateLaborForm === '暑假工'
              ? '⚠️ 候选人已明确只要暑假工：下方结果已经按岗位结构化字段（`兼职类型(partTimeJobType)=暑假工`）严格过滤。' +
                '**只能推荐下方暑假工岗位**；禁止引用历史候选池、当前焦点岗位或本轮被剔除的普通兼职/小时工/全职岗位，' +
                '也禁止主动询问候选人是否愿意改做其他用工形式。'
              : null;
          if (laborFormFilterResult.applied) {
            jobs = laborFormFilterResult.jobs;
            total = jobs.length;
            if (laborFormFilterResult.excluded.length > 0 && jobs.length === 0) {
              const noMatchFollowUp =
                candidateLaborForm === '暑假工'
                  ? '候选人已明确只要暑假工：不得主动推荐、展示或询问是否考虑普通兼职/小时工/全职，' +
                    '不得沿用历史非暑假工岗位继续收资或约面。只可说明目前暂无匹配的暑假工岗位并维护候选人；' +
                    '只有候选人之后主动、明确改口接受其他用工形式，才按其新意向重新查岗。'
                  : '可主动表示后续有匹配岗位上线会第一时间通知；若候选人愿意考虑其他用工形式，再据其意向重新查岗。';
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.JOB_LIST_LABOR_FORM_FILTER_EMPTY,
                outcome: `本轮召回岗位经"${candidateLaborForm}"用工形式过滤后为空`,
                replyInstruction:
                  `候选人想要「${candidateLaborForm}」，但本轮附近召回的岗位经岗位 用工形式/兼职类型 结构化字段核对后，` +
                  `没有一条是「${candidateLaborForm}」。**必须如实告知"附近暂时没有${candidateLaborForm}的岗位"**，` +
                  '不得把别的用工形式的岗位（如把兼职岗说成全职、把常规岗说成暑假工）包装回去，也不得凭通识承诺有岗。' +
                  noMatchFollowUp,
                details: {
                  queryMeta: {
                    laborFormFilter: {
                      applied: true,
                      candidateLaborForm,
                      excludedCount: laborFormFilterResult.excluded.length,
                      // 暑假工场景不把被剔除岗位的品牌/jobId 暴露给模型，避免它从 metadata
                      // 捞回普通兼职/小时工当替代推荐；数量足够支撑诊断。
                      ...(candidateLaborForm === '暑假工'
                        ? {}
                        : { excludedExamples: laborFormFilterResult.excluded.slice(0, 3) }),
                    },
                    // 过滤后为空且召回里存在契约异常数据时，大概率是数据问题而非真无岗
                    ...(candidateLaborForm === '暑假工'
                      ? {}
                      : {
                          laborFormAnomalies:
                            laborFormAnomalies.length > 0
                              ? {
                                  count: laborFormAnomalies.length,
                                  examples: laborFormAnomalies.slice(0, 10),
                                }
                              : null,
                        }),
                  },
                },
              });
            }
          }

          const flags: ProgressiveDisclosureFlags = {
            includeBasicInfo,
            includeJobSalary,
            includeWelfare,
            includeHiringRequirement,
            includeWorkTime,
            includeInterviewProcess,
          };

          const formatSet = new Set(responseFormat);
          const result: Record<string, unknown> = {};
          const ageScreeningSummary = includeHiringRequirement
            ? buildJobAgeScreeningSummary(jobs, resolveCandidateAge(context))
            : null;

          // 始终计算 brandNearestStores（不再仅在 hasUserCoords 时计算）：
          // 即使没有用户坐标，同品牌≥2 家时也需要 displayLine 让 LLM 区分。
          const brandGroups = buildBrandNearestStoreSummary(jobs);
          const multiStoreGroups = getMultiStoreBrandGroups(brandGroups);

          if (formatSet.has('markdown')) {
            const jobsMarkdown = formatJobsToMarkdown(
              jobs,
              total,
              DEFAULT_PAGE_NUM,
              DEFAULT_PAGE_SIZE,
              flags,
              brandGroups,
            );
            const markdownSections = [
              summerWorkerStrictNotice,
              laborFormRelaxNotice,
              ageScreeningSummary?.markdown,
              jobsMarkdown,
            ].filter((section): section is string => Boolean(section));
            result.markdown = sanitizeBrandName(markdownSections.join('\n\n'));
          }
          if (formatSet.has('rawData')) {
            result.rawData = { result: jobs, total };
          }
          // 观测自报口径：tool-call-analysis 优先读该字段推断 empty/narrow/ok
          result.resultCount = total;
          result.queryMeta = {
            storeMatchStrategy,
            jobCategoryMatchStrategy,
            regionRelaxedToLocation,
            regionRelaxAttempted,
            regionDroppedForCoords,
            cityFilterNormalization:
              cityFilterNormalization.mappings.length > 0 ? cityFilterNormalization.mappings : null,
            cityFilterRecovery,
            usedDistanceFiltering: hasUserCoords,
            distanceThresholdKm: maxKm ?? null,
            distanceScanPages,
            distanceScanTruncated,
            scheduleFilter: candidateScheduleConstraint
              ? {
                  applied: true,
                  candidateConstraint: candidateScheduleConstraint,
                  excludedCount: scheduleFilterResult.excluded.length,
                  excludedExamples: scheduleFilterResult.excluded.slice(0, 5),
                }
              : { applied: false },
            laborFormFilter: laborFormFilterResult.applied
              ? {
                  applied: true,
                  candidateLaborForm,
                  // 严格匹配为空、按兼职家族放宽命中：介绍必须按岗位真实 laborForm
                  relaxedToFamily: laborFormFilterResult.relaxedToFamily,
                  excludedCount: laborFormFilterResult.excluded.length,
                  ...(candidateLaborForm === '暑假工'
                    ? {}
                    : { excludedExamples: laborFormFilterResult.excluded.slice(0, 5) }),
                }
              : { applied: false },
            // 不符合新契约的岗位用工形式数据（不兼容不兜底，暴露出来修数据源头）
            ...(candidateLaborForm === '暑假工'
              ? {}
              : {
                  laborFormAnomalies:
                    laborFormAnomalies.length > 0
                      ? {
                          count: laborFormAnomalies.length,
                          examples: laborFormAnomalies.slice(0, 10),
                        }
                      : null,
                }),
            brandNearestStores: brandGroups,
            // 同品牌≥2 家的硬约束信号：LLM 必须按 displayLine
            // 转述同品牌门店，禁止把多家门店压成"有 X 品牌"。
            multiStoreSameBrandGroups:
              multiStoreGroups.length > 0
                ? multiStoreGroups.map((group) => ({
                    brandName: group.brandName,
                    brandId: group.brandId,
                    totalStoreCount: group.totalStoreCount,
                    displayLines: group.nearestStores.map((store) => store.displayLine),
                    requiresStoreDifferentiation: true,
                  }))
                : null,
            ageScreening: ageScreeningSummary?.meta ?? null,
            brandIdList,
            brandAliasList,
            brandAliasSource,
            rejectedNicknameBrandAliases: nicknameAliasValidation.rejected,
            searchJobName: searchJobName?.trim() || null,
          };

          // 通知调用方已获取岗位数据
          if (context.onJobsFetched && jobs.length > 0) {
            await context.onJobsFetched(mapJobsToSummaries(jobs));
          }

          // job.recommended：候选人本轮被推过岗位 → 记一次。fire-and-forget。
          // 幂等键按「本轮 turn」而非「每候选人一次」：daily_ops_report 是当天事件数，
          // 若用 userId 终身键，同一候选人后续天数再次推荐会被压成 0。turnId 缺省（test/debug）回退时间戳。
          if (jobs.length > 0) {
            const turnId = context.turnId ?? Date.now().toString();
            void opsEventsRecorder.recordEvent({
              corpId: context.corpId,
              eventName: 'job.recommended',
              idempotencyKey: `${context.sessionId}:job_recommend:${turnId}`,
              botImId: context.botImId,
              managerName: context.botUserId,
              sourceChannel: 'unknown',
              userId: context.userId,
              chatId: context.sessionId,
            });
          }

          return result;
        } catch (err) {
          logger.error('获取岗位列表失败', err);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.JOB_LIST_FETCH_FAILED,
            outcome: '岗位查询接口失败',
            replyInstruction:
              candidateLaborForm === '暑假工'
                ? '岗位查询接口暂时不可用，且候选人已明确只要暑假工。不要把异常信息原文转述给候选人；' +
                  '不得基于 [会话记忆] 的普通兼职/小时工/全职岗位维持上下文，不得推荐、收资或约面。' +
                  '先用招募者口吻说明需要再确认暑假工岗位，必要时调用 request_handoff 转人工。'
                : '岗位查询接口暂时不可用。不要把异常信息原文转述给候选人；用招募者口吻安抚"这边稍等下"，' +
                  '基于 [会话记忆] 已展示岗位维持上下文，必要时调用 request_handoff 转人工。',
            details: { reason: err instanceof Error ? err.message : '未知错误' },
          });
        }
      },
    });
  };
}
