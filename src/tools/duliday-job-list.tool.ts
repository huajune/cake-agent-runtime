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

import { toErrorMessage } from '@infra/utils/error.util';
import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import type { JobBasicInfo, JobDetail } from '@sponge/sponge.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { isValidLaborForm, stripLaborFormFromCategories } from '@resolution/labor-form';
import { ToolBuilder, ToolBuildContext } from '@shared-types/tool.types';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { isRecord } from '@infra/utils/object.util';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import {
  buildNoMatchScript,
  buildPostInviteClosureScript,
} from '@tools/job-list/no-match-script.util';
import { formatSettlementSummary } from '@tools/job-list/salary-settlement.util';
import { buildJobPolicyAnalysis } from '@tools/job-list/job-policy-parser';
import { sanitizeBrandName } from '@resolution/brand/sanitize-brand-name';
import { BRAND_FILTER_MODES } from '@resolution/brand/brand-resolution.types';
import { buildSpongeTokenContext } from '@tools/shared/sponge-token-context.util';
import {
  filterJobsToRequestedAdministrativeArea,
  normalizeSpongeCityFilters,
} from '@tools/job-list/sponge-area-filter.util';
import { detectGeoSignalConflict } from '@resolution/geo';
import { getTurnHintValue } from '@resolution/turn-hints/reducer';
import {
  buildJobListQuerySignature,
  REPEAT_QUERY_NOTICE,
} from '@tools/shared/job-list-query-signature';
import { correctSwappedLatLng } from '@tools/shared/latlng-swap';
import {
  applyLaborFormConstraint,
  applyScheduleConstraint,
  applyStudentIdentityConstraint,
  collectLaborFormAnomalies,
  filterJobsExcludingBrands,
  filterJobsToAppliedBrands,
  formatScheduleConstraintLabel,
  haversineDistance,
  rankJobsByRequestedCategories,
  stripGenericPositionUmbrella,
} from '@tools/job-list/search.util';
import {
  buildBrandQueryPlan,
  toBrandQueryMeta,
  type BrandQueryPlan,
} from '@tools/job-list/brand-query.util';
import {
  findBrandFuzzyMatches,
  resolveFuzzyConfidence,
  type BrandFuzzyMatch,
} from '@resolution/brand/fuzzy-recall';
import {
  buildBrandNearestStoreSummary,
  formatSalarySummary,
  getMultiStoreBrandGroups,
} from '@tools/job-list/brand-stores.util';
import {
  formatJobsToMarkdown,
  inferStudentRequirement,
  type ProgressiveDisclosureFlags,
} from '@tools/job-list/render.util';
import { type DistanceAnchorPrecision } from '@tools/job-list/distance-render.util';
import { composeShiftTimeText } from '@tools/job-list/format-shift-time.util';
import { extractWelfareFacts } from '@tools/job-list/welfare-facts.util';
import { parseAgeRange, parseCandidateAge } from '@tools/job-list/age.util';
import {
  AGE_BOUNDARY_HANDOFF_FLOOR,
  AGE_BOUNDARY_LOWER_TOLERANCE_YEARS,
  AGE_BOUNDARY_UPPER_TOLERANCE_YEARS,
  detectAgeBoundary,
  type AgeScreeningSignal,
} from '@resolution/candidate/age';

// ==================== 常量 ====================

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DISTANCE_SCAN_MAX_PAGES = 10;
/**
 * 判定"模型传入的坐标 = 本轮 geocode 解析结果"的坐标容差（度）。
 * 模型从 geocode 结果转抄经纬度时可能截断小数位，0.005° ≈ 500m，
 * 远小于相邻行政区代表点间距，不会串锚点。
 */
const GEOCODE_ANCHOR_COORD_TOLERANCE = 0.005;
/**
 * 模型自编坐标判定阈值（km）：本轮存在 geocode 锚点、但模型传入坐标与所有锚点
 * 偏差都超过该值时，判定坐标疑似模型凭记忆自编（方案 11.3 修复点 1，v3.2）。
 * shadow 观测：只记 queryMeta.anchor 并告警，不改变查询行为。
 * 实证 ：模型自编坐标与真实锚点偏差 3.7km，
 * 5 公里搜索圈整体画错位置（4.5km 门店被算成 1.2km）。
 */
const MODEL_SUPPLIED_COORD_DEVIATION_KM = 1;
/**
 * 模型显式传入 location.range 时，本地距离后置过滤的硬上限（km）。
 * 候选人主动要求更大范围、或点名品牌 0 条放宽复查时，模型可显式传更大 range
 * 放宽过滤（与 DESCRIPTION「点名品牌 0 条时放大到 30000」口径一致）；
 * 上限截断防止把全城岗位都算作"附近"。
 * badcase ：此前本地过滤只读业务阈值，模型传
 * range=20000 实际仍按 10km 过滤，模型据此对候选人谎称"扩到 20 公里查了没有"。
 */
const EXPLICIT_RANGE_CAP_KM = 30;

/**
 * 模型品牌入参全部被拒（未命中品牌库/冲突别名）时的结构化结果（§8.2.5）。
 *
 * 三种走向由回指置信度决定（判定阈值与守卫共享 resolveFuzzyConfidence）：
 * high=直接按回指品牌推进；low=反问澄清；none=按 noMatchScript 收口。
 * 未验证品牌绝不静默降级成无品牌查询（那会引发跨品牌乱推），也不进入品牌过滤。
 */
function buildBrandRejectedResult(params: {
  brandPlan: BrandQueryPlan;
  fuzzySuggestions: BrandFuzzyMatch[];
  noMatchScript: ReturnType<typeof buildNoMatchScript>;
}): Record<string, unknown> {
  const { brandPlan, fuzzySuggestions, noMatchScript } = params;
  const fuzzyConfidence = resolveFuzzyConfidence(fuzzySuggestions);
  const topMatch = fuzzySuggestions[0] ?? null;
  const rejectedInputs = brandPlan.rejected.map((item) => item.input);

  let outcome: string;
  let replyInstruction: string;
  if (fuzzyConfidence === 'high' && topMatch) {
    outcome = '品牌入参未命中品牌库，疑似口误，已自动回指最近推荐品牌';
    replyInstruction =
      `品牌入参 ${JSON.stringify(rejectedInputs)} 未在品牌库命中，但与会话最近推荐的 **${topMatch.brandName}** ` +
      '高度同音回指（见 queryMeta.brand.fuzzySuggestions[0]）。**直接按该品牌继续推进**，' +
      '回复时用一句轻确认带过让候选人自然听到正确品牌名；不要单独反问"你是说 X 吗"，' +
      '不要照念 noMatchScript，不要调 invite_to_group。需要岗位详情时用该标准品牌名重调本工具。';
  } else if (fuzzyConfidence === 'low') {
    outcome = '品牌入参未命中品牌库，会话最近品牌池存在多个同音候选，需反问澄清';
    replyInstruction =
      `品牌入参 ${JSON.stringify(rejectedInputs)} 未在品牌库命中，会话最近品牌池里存在多个同音/字形候选` +
      '（见 queryMeta.brand.fuzzySuggestions），无法判定指代哪一个。**用一句反问澄清**："你说的是 X 还是 Y？"——' +
      '不要直接答"没查到"，不要照念 noMatchScript，不要调 invite_to_group。';
  } else {
    outcome = '品牌入参未命中品牌库，未形成品牌过滤';
    replyInstruction =
      `品牌入参 ${JSON.stringify(rejectedInputs)} 经品牌库校验全部未命中（见 queryMeta.brand.rejected：` +
      'unmatched=库中无此品牌，ambiguous=别名对应多个品牌需澄清）。未按该品牌执行查询。' +
      '若这是候选人点名的品牌，**严格按 noMatchScript.candidateMessage 原文照念并结束本轮**，' +
      '真实无岗不得调用 invite_to_group；' +
      '不得跨品牌推荐；若怀疑是你自己拼错了品牌名，换标准品牌名或 brandIdList 重查一次。';
  }

  return buildToolError({
    errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
    outcome,
    replyInstruction,
    details: {
      noMatchScript,
      aliasFuzzyMatch:
        fuzzyConfidence !== 'none'
          ? {
              brandAliasList: rejectedInputs,
              confidence: fuzzyConfidence,
              suggestions: fuzzySuggestions,
            }
          : null,
      queryMeta: {
        brand: toBrandQueryMeta(
          brandPlan,
          fuzzySuggestions.map((match) => ({
            brandName: match.brandName,
            inputAlias: match.inputAlias,
            score: match.score,
          })),
        ),
      },
    },
  });
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
      '岗位名称模糊匹配（子串匹配整条 jobName，jobName 形如「品牌-门店-工种-用工形式」，如「M Stand-上海长泰广场店-店员-小时工」）。**想按门店/地标找岗位时填这里**（如候选人说"想去长泰广场那家"就填"长泰广场"），比 storeNameList（精确匹配易落空）宽容得多。建议配合 cityNameList/brandIdList 收窄；不要把工种/用工形式词塞进来（那些用 jobCategoryList）。\n**也不要把品类/行业词（"咖啡""奶茶""茶饮""火锅"等）塞进来**。未指定品牌的"咖啡兼职/咖啡店岗位"当前默认按 M Stand 走 brandIdList/brandAliasList；只有"其他咖啡品牌/除了 M Stand"才扩张到其他咖啡品牌。其他品类按对应品牌解析结果召回。',
    ),
  jobCategoryList: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      '候选人明确点名的意向工种关键词（如"收银员""分拣员""骑手"）。**仅用于把 岗位名称/岗位类型/工作内容 匹配的岗位排到结果前面并标注，不做过滤、不会减少召回结果**——召回范围始终由城市/区域/坐标 + 品牌决定。只有候选人**明确点名具体工种**(如"我只做收银""想干分拣")时才填；没点名就留空。\n不要填：品类/行业词("咖啡""奶茶"是品牌意向，走品牌参数)；"全职""兼职""小时工""暑假工"等用工形式词(是岗位 laborForm 属性，已按会话事实自动硬过滤)。',
    ),
  brandIdList: z
    .array(z.number().int())
    .optional()
    .default([])
    .describe(
      '品牌ID列表；Boss直聘岗位标题中形如 "[10239]" 的方括号纯数字是品牌ID，应填为 brandIdList=[10239]，不要当作 jobId/薪资/编号',
    ),
  brandFilterMode: z
    .enum(BRAND_FILTER_MODES)
    .optional()
    .describe(
      '品牌过滤形态（可选）。enforce=仅查询指定品牌（品牌列表非空时的默认语义，通常无需显式传）；' +
        'exclude=排除指定品牌（结果中剔除 brandIdList/brandAliasList 列出的品牌）；' +
        'clear=本次查询有意放宽品牌条件（0 结果重查、探索别家时**必须显式传 clear**，只省略品牌参数会被会话品牌兜底拉回）；' +
        'browse_all=候选人明确说不限品牌。' +
        '兜底语义：品牌参数与本字段都省略时，工具沿用会话品牌状态的当前主品牌查询（brandSource=session_state 会在结果中披露）。' +
        '注意：enforce/exclude 必须配合非空品牌列表，列表为空会报错。',
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
            '需要更小或更大的查询半径（如候选人明说"远点也行 / 20 公里内都能接受"）时显式传值，' +
            '距离过滤按传入值生效；硬上限 30000（30km），超出按 30km 截断并在结果中披露',
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

/**
 * `basicInfo.storeInfo` 在领域契约里是 raw `Record<string, unknown>`（海绵按门店透传），
 * 这里声明本工具实际读取的字段视图。仅用于类型断言，不做运行时转换。
 */
type StoreInfoView = {
  storeName?: string;
  storeAddress?: string;
  storeCityName?: string;
  storeRegionName?: string;
  latitude?: unknown;
  longitude?: unknown;
};

/**
 * `_distanceKm` 是**本工具写上去的合成标注**（海绵不返回）：拿到候选人坐标后按 haversine
 * 算出门店距离回写到岗位对象，供排序/半径过滤/摘要读取。`JobDetail` 的 catchall 把它读成
 * `unknown`，这里给读写两侧一个显式契约，替代原先整段 `eslint-disable no-explicit-any`。
 */
type JobWithDistance = JobDetail & { _distanceKm?: number };

function mapJobsToSummaries(jobs: JobDetail[]): RecommendedJobSummary[] {
  return jobs.map((job) => {
    const policy = buildJobPolicyAnalysis(job);
    const ageRequirement = policy.normalizedRequirements.ageRequirement;
    const educationRequirement = policy.normalizedRequirements.educationRequirement;
    const healthCertificateRequirement = policy.normalizedRequirements.healthCertificateRequirement;
    const hasWelfarePayload =
      job.welfare !== null && typeof job.welfare === 'object' && !Array.isArray(job.welfare);
    const welfare = hasWelfarePayload ? extractWelfareFacts(job.welfare) : null;
    // storeInfo 在领域契约里是 raw Record：按预期形状断言后直接透传，不做运行时转换
    // （与 candidate-card.util.ts 同一写法，缺字段落 undefined → `?? null`）。
    const storeInfo = job.basicInfo.storeInfo as StoreInfoView | undefined;
    const distanceKm = (job as JobWithDistance)._distanceKm;

    return {
      jobId: job.basicInfo.jobId,
      brandName: job.basicInfo.brandName ?? null,
      jobName: job.basicInfo.jobName ?? null,
      storeName: storeInfo?.storeName ?? null,
      storeAddress: storeInfo?.storeAddress ?? null,
      cityName: storeInfo?.storeCityName ?? null,
      regionName: storeInfo?.storeRegionName ?? null,
      laborForm: job.basicInfo.laborForm ?? null,
      partTimeJobType: job.basicInfo.partTimeJobType ?? null,
      salaryDesc: formatSalarySummary(job),
      settlementSummary: formatSettlementSummary(job),
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
      resumeRequired: policy.fieldGuidance.fieldSignals.some(
        (signal) => signal.field === '简历附件',
      ),
      distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
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

function readFactValue(value: unknown): unknown {
  if (isRecord(value) && 'value' in value) return value.value;
  return value;
}

function resolveCandidateAge(context: ToolBuildContext): number | null {
  const sources = [
    getTurnHintValue(context.ledger.facts.turnHints, 'interview_info.age', {
      minConfidence: 'high',
    }),
    readFactValue(context.archive.sessionFacts?.interview_info?.age),
    context.archive.profile?.age,
  ];

  for (const source of sources) {
    const parsed = parseCandidateAge(source == null ? null : String(source));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * 解析候选人是否学生（本轮规则解析结果优先，其次会话事实；不依赖 LLM 入参）。
 *
 * 只用于学生身份硬过滤：仅 true（候选人明确自报学生）触发；false 有抽取
 * 污染史（badcase 凭空落 false），调用方不得据 false 做过滤。
 */
function resolveCandidateIsStudent(context: ToolBuildContext): boolean | null {
  const sources = [
    getTurnHintValue(context.ledger.facts.turnHints, 'interview_info.is_student', {
      minConfidence: 'high',
    }),
    readFactValue(context.archive.sessionFacts?.interview_info?.is_student),
  ];
  for (const source of sources) {
    if (typeof source === 'boolean') return source;
  }
  return null;
}

/**
 * 解析候选人想要的用工形式。
 *
 * 只从确定性解析结果与会话事实读取（本轮规则解析结果优先，其次会话事实），
 * 不依赖 LLM 入参——保证用工形式过滤始终生效，避免模型忘传。
 * 返回合法用工形式（全职/兼职/小时工/寒假工/暑假工）；"正式工/临时工" 等
 * 不同轴噪音词视为无效。
 */
function resolveCandidateLaborForm(context: ToolBuildContext): string | null {
  const sources = [
    getTurnHintValue(context.ledger.facts.turnHints, 'preferences.labor_form', {
      minConfidence: 'high',
    }),
    readFactValue(context.archive.sessionFacts?.preferences?.labor_form),
  ];
  if (context.turnInput.currentLaborFormIntent?.kind === 'set') {
    return context.turnInput.currentLaborFormIntent.value;
  }
  for (const source of sources) {
    if (typeof source !== 'string' || !isValidLaborForm(source)) continue;
    if (
      context.turnInput.currentLaborFormIntent?.kind === 'clear' &&
      context.turnInput.currentLaborFormIntent.clearedValues.some((value) => value === source)
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

function buildJobAgeScreeningSummary(
  jobs: JobDetail[],
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
      const basic = job.basicInfo ?? ({} as JobBasicInfo);
      const storeName = (basic.storeInfo as StoreInfoView | undefined)?.storeName;
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

  if (counts.hard_reject > 0) {
    lines.push(
      `- **hard_reject 岗位默认不得推荐**：不得把年龄硬拦截的岗位当作可选项展示给候选人——选中后会被 precheck 打回，浪费候选人意向（badcase 6a60528bce406a6aee8004f9：19 岁候选人被推 20-35/20-40 岗位，选中后被拒）。仅当候选人主动点名该品牌/门店时可提及，且必须同时明确说明年龄不符、无法约面。存在 pass/boundary 岗位时只推荐 pass/boundary 的。`,
    );
  }

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

// ==================== 构建函数 ====================

const logger = new Logger('duliday_job_list');

// 程序记忆层（procedural memory）工具绑定规则；总目录：docs/prompt-rule-ledger.md
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
| 问"某区域有什么" / 候选人说自己在某区 | **默认按就近处理**：区/县名先 geocode 拿坐标走 location 距离召回；城市没把握就 city 留空让 geocode 三态判定，不要先反问候选人。区内硬约束的精确过滤见下方 regionNameList 条 |
| 问"附近有什么" / 给了商圈/地标 | 先 geocode 拿坐标 → 传 location 半径；若结果 ≤ 1 条**必须**去掉 location 重查全市 |
| 用户接受了某门店但要换条件 | **先在 [会话记忆] 里查这门店所在的 region**，用 regionNameList 重查；不要直接拿口语门店名传 storeNameList |
| 用户问"还有别的品牌吗" | **不带 brandIdList 重查**当前区域，对比之前已展示的 brand 集合，告诉用户除了已推过的还有什么 |

## 结果数处理（必须遵守）
- **0 条**：本次查询失败。检查是否用了 storeNameList / brandAliasList 等低稳定字段；若是，立即换成 regionNameList / brandIdList 重试一次；若已经是稳定字段且仍为 0，**如实告知候选人"暂时没找到"**，不要再换条件硬试
- **1 条** 且候选人在问"还有别的吗 / 其他选择"：反常信号，**必须再放宽 1 个维度重查**（去掉 location / 扩大半径 / 去掉某个 brand/category filter），不得用 1 条结果直接答"暂时没空缺"
- **≥ 2 条**：可以基于结果回复，无需扩面
- **同一轮内本工具调用次数硬上限 = 3**：第 4 次系统会直接拒绝。第 3 次仍未拿到可用数据时，应基于已有结果如实告知候选人，不要再继续猜 filter
- **结果只对最近 6 家给全文，更远的列在「### 更远的 N 家」里只有摘要行（店名/距离/薪资/年龄/jobId）**：推荐时优先用全文的最近几家；候选人明确问到摘要区某家的班次/福利/详细要求时，用该行的 jobId 走 jobIdList 单独重查拿全文，不要凭摘要行编造其未列出的字段

## 必须考虑的硬约束
- [本轮查询硬约束] 段列出的字段必须在本轮查询里体现——按每项注明的处理方式执行（作为 filter 或在结果集自行排除），注释没说"填到 XxxList"的不要硬塞 filter；缺任一硬约束的结果不得用于"无空缺"结论
- 候选人说"只周末"、"平时下班后"、"只能晚班"、"每周最多两天"、"做一休一"、"不上夜班"、"周四最早 19:30"这类班次/出勤限制时，必须把工作时间当硬约束。岗位侧"每天"、"周一至周日"、"做六休一"、"每周四/六/日都要给班"、"早开晚结全天时段/05:00-23:00"是强排班要求：除非岗位明确写"只周末/仅周末/可只排周末/每周可两天/可做一休一"，否则一律视为与上述窄约束不匹配，不能解释成任选一天、任选晚班或可只做周末，不得回复"周末能排"或"可以协调"

## 参数要点
- 至少提供一个有效筛选条件：城市、区域、品牌、门店、岗位类型、项目ID、岗位ID。根据 [会话记忆] 中候选人意向填入
- responseFormat 只能用 ["markdown"]，禁止 rawData
- 传 regionNameList 时必须同时传 cityNameList；系统已有高置信城市时直接使用，否则先追问城市。候选人只说"房山/合川/某区县附近"时，不能凭通识补"北京/重庆"等城市
- **regionNameList = 区级行政区名的精确过滤，不是就近召回**（后端对库里的区级 storeRegionName 做精确字符串匹配）。三条推论：
  - 候选人说"我在某区/某区这边"是**就近信号**：geocode 成坐标走 location——精确过滤会把隔壁区更近的店整批漏掉（badcase 6a3356e2）。regionNameList 仅用于 ① 候选人明确"只在某区内"的硬约束，② 从已知门店扩展回它所在区重查
  - **只接受区/县级行政区全称**（浦东新区、朝阳区等）：乡镇/街道/片区名（川沙、九亭、安亭等）与商圈/地标/详细地址精确匹配必然 0 条、且绝不代表该片区没岗，必须先 geocode 解析成"区级 district + 坐标"再查
  - 区名简称（"浦东""静安"）也先 geocode 拿规范全称，避免对不上后端区级实名
- **未确认城市禁默认**：[本轮解析线索] 与 [会话记忆] 都未给出城市时，禁止默认任何城市做查岗或品牌承诺；候选人明确品牌但未给城市时，必须先简短确认"您想找哪个城市的岗位"，避免出现把"北京必胜客"默认按上海查的事故

## 数据开关
- 薪资/班次/要求/福利开关**默认全开**、随结果自动返回，无需显式传；仅 \`includeInterviewProcess\` 默认关——候选人问"怎么面试/面试流程"时开启
- 距离场景：先 geocode，把坐标连同城市/品牌一起传 location；非默认半径补 location.range（米，语义与上限见参数说明）

## 回复展示要求
- **卡片正文是展示的唯一底盘**（详见「硬规则」末段的四行卡片铁律）：薪资、班次、要求、门店区分由卡片行保障；同品牌多店必须用门店名/距离区分，禁止把多个岗位压缩在同一句里
- **薪资/班次的补充纪律**：任何场景引用阶梯薪资必须保留"基础 + 阶梯规则"原文（如"基础 A/小时，做满 N 小时再加 B"），禁止简化为"约 X 元"；薪资数字必须带单位（元/小时、元/月，多岗混排逐岗标注）；**严禁**反问"班次能不能接受？"自己却没说出班次时间；工作时间字段缺失时如实说"班次门店再确认"，不得编造，也不得把"面试时间"当"上班班次"
- **福利信息主动展示**：普通福利字段（员工餐/包吃住/餐补/补贴/转正机会等，**不含保险/社保**——敏感政策按全局规则不主动提及）非空必须按工具原文展示，候选人没问也要给；为空时按"空头承诺禁忌"如实说"这个我再确认"
- **挑选式开场禁忌**：直接展示 1~2 个最匹配岗位的完整详情，不要先发"有 A/B/C 你想看哪个"再等候选人选
- **岗位卡片必须紧凑**：单岗信息集中在 1-2 段内（行内可用顿号/逗号分隔），不要用段间空行拆成多段——后置消息切分器按空行拆成独立微信消息，候选人会连收 6-8 条碎片
- **工作内容**：回答"具体做什么"前必须读本轮岗位详情的工作内容字段，未返回时按缺字段规则补查；出现"打荷/收档/出货"等行业短语时用一句口语化解释展开，不要原样复读

## 硬规则
- **岗位详情缺字段必须按 jobId 补查（通用规则，含福利追问）**：候选人追问当前岗位的薪资、结算、班次、福利、要求、地址、用工形式、工作内容、工期等具体字段时，先检查 [当前焦点岗位] 摘要是否明确包含所问字段；缺少任一字段时，必须用当前焦点岗位的 jobId 传 jobIdList 重新调用本工具并开启对应 include 开关（福利用 includeWelfare=true），只按本轮结果回答。记忆只用于定位 jobId，严禁从综合薪资的"元/月"、岗位名、品牌常识或历史助手回复推断缺失字段。**薪资、结算周期/发薪日与具体福利是易变高风险字段，即使摘要已有也必须本轮实时重查**；当前岗位不唯一时先确认具体门店，禁止拿另一门店代答
- **品牌/区域分布判断必须基于本工具结果**：候选人说出品牌不得用"XX是吧"直接确认，需先在当前已知范围验证在招；"杨浦没岗、虹口有岗"这类分布结论也必须先查。未查前只能说"我先帮你查下"
- **具体岗位/门店推荐必须带位置**：候选人给了商圈/地标/街道/详细地址/位置分享/经纬度等具体位置线索、且本轮要输出具体岗位或门店推荐时，必须先 geocode 或使用位置分享经纬度再调用本工具；不要因对方没明说"附近/离我近"就跳过。学校、校区、学院、小学部等地点名只代表位置，不代表学历
- **候选人给了 2 个及以上位置（多个位置分享/多个地标）**：对每个位置**各调用一次**本工具（可并行），分别传各自的 location 坐标；推荐时按位置分组展示，让候选人清楚各自附近有哪些岗位；**禁止**只查其中一个位置然后合并描述
- **推荐距离是硬约束**：只要本轮在推荐具体岗位/门店，结果必须满足业务距离阈值；超出阈值即使其他条件匹配也不得推荐。无有效 location 时只能回答在招情况或区域分布，不得输出具体推荐
- **距离数字只能引用本轮工具结果，严禁编造**：距离只能来自本轮结果的距离字段（推荐卡片 / brandNearestStores 的 km 数）；本轮没传 location、结果无距离数据时**禁止**凭地名印象估算公里数——已有候选人坐标就带 location 重查，拿不到就不提数字改说"具体距离我帮你再确认下"（badcase 6a266b51）
- **location 坐标禁止凭记忆自编**：坐标只能逐位复制自本轮/历史 geocode 结果或候选人位置分享；改半径复查时原样复用上次完整坐标（小数位不得截断改写），拿不准就重新 geocode——自编坐标会把搜索圈画到错误圆心上（badcase 6a60528b）
- **区级定位下距离必须按估算口径转述**：结果头部声明"定位精度：区级代表点"时，距离已渲染成"约 X.Xkm（按 XX 估算）"，转述**必须保留"约 / 按 XX 估算"口径**（或请候选人发定位重查后再给精确距离）；**严禁**去掉估算说明包装成精确距离——区级锚点与真实位置可能差数公里
- **同品牌按距离最近优先**：有 brand intent 时按 queryMeta.brandNearestStores 的距离升序展示，不得跳过更近的同品牌门店转推更远的
- **明确品牌意向时不静默换品牌**：候选人明确点名品牌时 brand 必须进 brandIdList/brandAliasList（非空即硬过滤到该品牌），**不得**反问"看看其他品牌吗"或默默换牌推荐；想跨品牌推才省略品牌参数，明确意向下禁止省略
- **点名品牌豁免距离上限——0 条先放宽复查再下结论**：候选人点名的品牌不受 max_recommend_distance_km（约 10km）约束（阈值只管 Agent 主动推荐）。距离内查得 0 条时必须放宽再查一次：location.range 放大到 30000 并保留品牌 + 城市/坐标（**不要只去掉 range**——保留坐标缺省 range 会被阈值兜底拉回；全城查则去掉整个 location）。放宽后查到较远门店 → 如实告知距离让候选人决定，**严禁**把"超距离"说成"没有/暂无在招"（候选人常已在 BOSS 见过该品牌，谎称没有直接流失）；整城仍 0 条才说"该品牌你所在城市暂无在招"，再按无岗动作链收口
- **缺位置不要直接当无岗**：调用前须有 cityNameList 或 location 坐标；没有位置上下文时先中性问一句城市/区域，**禁止**把"还没给位置的 0 条"当"无岗"收口拉群
- **跨城市无岗禁反问扩张**：候选人所在城市 0 条时按 noMatchScript 原文照念，**严禁**反问"看看其他城市吗"等扩张式追问；候选人主动提其他城市才重查，否则收口等待新库存，不拉群
- **禁止推断品牌地理分布**：本工具只确认查询范围内有无在招，不掌握品牌全国门店分布；0 条只能说"暂时没查到 XX 品牌的在招岗位"，**严禁**"这个品牌主要在 XX 开店 / XX 才有"类措辞
- **Agent 自推岗位不适用品牌锁死**：如果候选人并未主动指定品牌，而是你上一轮先推荐了某品牌/门店，候选人只是说"可以"或补收资资料，则该品牌不是硬性 brand intent。后续发现该岗位年龄/性别/班次/学历等条件不匹配时，必须先去掉 jobIdList / brandIdList / brandAliasList，保留候选人的位置、年龄、身份、时间窗等硬约束重查，并基于新结果推荐可匹配岗位；不要直接 request_handoff，也不要用"明确品牌意向"规则阻止换岗自救
- **工时长度反查**：候选人说"时间长一点的 / 工时长 / 全天班 / 想做半天以上"等工时偏好时，必须基于返回的工作时间字段重新筛选；若结果集仍以短班为主，先告知"附近主要是短班"再问是否扩大区域，不要继续把短班包装成"差不多"
- **首次推荐必须把关键要求 + 工作班次时间随岗位信息一起告知**，让候选人自行判断；严禁推完岗位再逐个追问个人条件去做比对
- **推荐文案只输出工具结果顶部的实际岗位卡正文，严禁自行添加“模板/示例/内部说明”等元标题**：每个岗位四行（标题 = 品牌（门店）- 岗位，距离；班次行；薪资行；要求行），**不得删除或合并任一行**。每行的具体取值须结合该岗位下方详情和备注组织完整信息——例如薪资行须包含备注中的阶梯/节假日等补充薪资，而非只写结构化字段的基础时薪。漏掉班次行、薪资行或门店行都属于不合格推荐
- **班次行必须列全工具返回的所有档位，不得只报候选人偏好的那一档**：含多档时连同排班关系（可选其一 / 全部需出勤等）原样转述，排班方式以工具为准、不自行假定；只挑一档会让候选人误以为是纯某班岗，报名后被排到没告知的班次
- **无岗与推荐不满意分流**（互斥顺序收口）：
   1. 首次 0 条 → 本轮直接放宽一次（同城邻区 / 同品牌邻店 / 放宽距离），不向候选人多问一句
   2. 放宽仍 0 条 = **真实无岗** → 直接告知"暂时没有合适岗位"结束本轮，不拉群替代岗位供给
   3. 你根据完整对话确认候选人连续否定两轮具体推荐 → 停止第三轮，只征询进群意愿；下轮明确同意后才实调 invite_to_group（工具不做文本轮次计数）
   4. 已成功拉群 → 永久停止查岗、推荐及"看其他区域"类追问，只提示留意既有群消息
   5. **历史轨迹打破**：即使自己上轮提议过"换品牌/换城市"，本轮工具证实无岗就直接收口，不顺承旧反问思路
   6. **结果非空但全部与硬约束冲突** = 视同 0 条有效，先放宽一维重查；仍无匹配才按真实无岗收口。年龄判断必须沿用 precheck 弹性口径：候选人 52 岁遇到 20-50 岁 / 40-50 岁岗位属上限边界，用 duliday_interview_precheck 复核，不得直接判无岗
   7. 新搜索无匹配时回看 [会话记忆]「上轮候选岗位池」，有潜在匹配用 jobIdList 精查后再推荐
- **包餐/餐补硬偏好**：候选人说"没饭吃不去了 / 必须包饭"等视为硬性偏好，不要安慰成"附近吃饭方便"或继续收资；继续推荐须本轮核对福利字段，无匹配就如实说明并结束本轮，不因真实无岗直接拉群
- **面试相关字段**：推进面试时优先读工具结果中的「约面重点」；工具没明确时间不得编造；相对当前时间已过期的日期限制视为历史备注，不得当作当前规则输出

## 空头承诺禁忌
- 工具未返回某福利字段时不得说"有 / 没有该福利"；候选人需要该答案才能决定时，当轮按 request_handoff（reasonCode="salary_admin_inquiry"）转人工——不要说"帮你确认下"却不转
- **阶梯薪资只能复述工具原文的门槛与单价，两个口径缺口禁止自行填空**：① **累计周期**——工时累计**按月结算、每个自然月清零重新累计**（平台口径），候选人问"是一直累计吗 / 下个月也按最高档吗"必须明确"每月重新累计、次月从基础档起算"，**严禁**"以后一直按最高档"或含糊成"看门店"；② **计算基数**——升档后是全月工时按新档、还是仅超出部分按新档，**不在岗位数据里**，候选人问到时**严禁**按个税式分段模型自答、也**严禁**断言"全部按最高档"，只能复述门槛与单价原文并当轮按 request_handoff（reasonCode="salary_admin_inquiry"）转人工确认。两类说错都会导致候选人结算时工资对不上
- **健康证口径必须两段一起给**：岗位分「面试前须持证」与「入职前办妥」两档；属后者时回答"面试要不要健康证"**必须同时说明入职前仍须办妥**，**严禁**只回"面试不需要"就结束（候选人会以为全程不用办，是既有投诉形态）。时点以本轮健康证字段为准，不得自行加"试工/培训"等数据没有的环节口径
- 历史助手回复说过的门店事实不能当本轮事实复述；本轮要给候选人新的具体推荐时，必须以本轮工具结果为准；只有 [当前焦点岗位] 等记忆字段是稳定的，可以直接承接
- **工具未返回的业务事实禁止用通识补充**：候选人追问"日结哪天到账 / 面试线上还是线下 / 能否跨店 / 排班固定还是灵活 / 试用期 / 经验要求"等而本轮字段没明示时，当轮按 request_handoff（reasonCode="salary_admin_inquiry"）转人工，**严禁**"一般日结当天结 / 应该是全职"类经验性回答
- **学生安排只服从岗位数据，且资格通过≠预约已通过**：工具明确写不接受学生就不得推荐；写接受/学生优先则继续；未标注学生限制时按"没有额外学生硬限制"继续校验其余条件——不得凭空说"需要跟店里确认"、不得因此 request_handoff 或声称已联系门店，年龄/学历/常识不能替代岗位数据。资格通过只代表可以继续：约面阶段必须保持候选人原话身份（历史明确填学生就传 candidateIsStudent=true）走 duliday_interview_precheck，只有 booking 返回 success=true 才能说已提交/已预约，严禁只调本工具就说"现在帮你提交预约/稍后提交"。
- **门店运营状态禁编造**：本工具只确认是否有在招岗位，**不掌握**营业/装修/关店/搬迁/招满等状态；结果为空只能答"目前查不到 X 在招岗位"，**严禁**"可能关店了 / 应该是搬了"类推测；候选人坚持要实际状态时按 request_handoff 转人工。
- **同字段多次查询不一致时以最新一次为准**：前后返回不同时按最新结果自洽回复，用一句衔接（"刚再核了一下，这家目前确实没空缺了"），不得前后口径并存造成人格分裂`;

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
    // v7 的 tool() 多重载对本工具的大 schema + 长 execute 推断失败（塌成
    // Tool<never,never,CONTEXT> 报 FlexibleSchema<never>），必须显式钉死泛型。
    const jobListTool = tool<z.output<typeof inputSchema>, unknown, Record<string, unknown>>({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        cityNameList = [],
        regionNameList = [],
        brandAliasList: brandAliasListInput = [],
        brandIdList: brandIdListInput = [],
        brandFilterMode,
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
        // 经纬度对调确定性纠偏（模型 reasoning 绑定正确、发射的
        // JSON 值却对调，圆心落到纬度 121° → 必然 0 条假"无岗"）。args 落库仍是模型
        // 原始入参，簇收敛继续用 lat 越界探针观测；此处只修查询行为并记 queryMeta。
        let coordSwapOriginal: { latitude: number; longitude: number } | null = null;
        if (location?.latitude != null && location?.longitude != null) {
          const corrected = correctSwappedLatLng(location.latitude, location.longitude);
          if (corrected.swapped) {
            coordSwapOriginal = { latitude: location.latitude, longitude: location.longitude };
            location = {
              ...location,
              latitude: corrected.latitude,
              longitude: corrected.longitude,
            };
            logger.warn(
              `location 经纬度对调已自动纠偏：入参 (lat=${coordSwapOriginal.latitude}, lng=${coordSwapOriginal.longitude}) → (lat=${corrected.latitude}, lng=${corrected.longitude})`,
            );
          }
        }
        const normalizedCityNameList = cityNameList.map((city) => city.trim()).filter(Boolean);
        const normalizedRegionNameList = regionNameList
          .map((region) => region.trim())
          .filter(Boolean);
        const invitedGroup = context.archive.invitedGroups?.[0];
        if (invitedGroup) {
          const noMatchScript = buildPostInviteClosureScript({
            groupName: invitedGroup.groupName,
            city: invitedGroup.city,
          });
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.JOB_LIST_GROUP_HANDOFF_COMPLETE,
            outcome: '本会话已经完成群承接，岗位查询链路已收口',
            replyInstruction:
              '**严格按 noMatchScript.candidateMessage 收口**。不得继续查询、推荐岗位或询问其他区域/品牌，' +
              '也不得重复调用 invite_to_group。',
            details: { noMatchScript },
          });
        }

        // jobIdList provenance 闸门（候选人全程只聊东莞长安晚班兼职，
        // 模型却在收尾轮凭空查 jobIdList=[53035]+新白鹿+上海——预训练知识幻觉成查询参数，
        // 还经无岗脚本把"新白鹿在上海"说给了候选人）。与 precheck/booking 的同名闸门同口径：
        // 按 jobId 精查只能用本会话真实召回过的 jobId；幻觉参数直接拦截，不打接口。
        if (jobIdList.length > 0 && context.archive.isRecalledJobId) {
          const unrecalledJobIds = jobIdList.filter((id) => !context.archive.isRecalledJobId!(id));
          if (unrecalledJobIds.length > 0) {
            const recalled = context.archive.recalledJobIds ?? [];
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.JOB_LIST_JOBID_NO_PROVENANCE,
              outcome: '查询拦截（jobIdList 含无召回出处的 jobId）',
              replyInstruction:
                (recalled.length === 0
                  ? `jobIdList=[${unrecalledJobIds.join('、')}] 在本会话没有任何来源——会话还没召回过岗位，禁止凭空按 jobId 查询。`
                  : `jobIdList 中的 [${unrecalledJobIds.join('、')}] 不在本会话召回过的岗位里（合法 jobId：${recalled.join('、')}），禁止使用。`) +
                '请去掉 jobIdList，按候选人本轮真实意向（城市/位置/品牌/工种）用常规参数查询；' +
                '严禁把本次拦截的品牌/城市/岗位名当作事实写进给候选人的话术。',
              details: { unrecalledJobIds, recalledJobIds: recalled },
            });
          }
        }

        // ==================== 品牌入口标准化 + 查询计划（§8.1/§8.2） ====================
        // 别名经品牌目录解析成唯一标准品牌（冲突/未命中进 rejected，不形成品牌过滤）；
        // 会话品牌兜底只读 SessionBrandState.currentBrand（昵称品牌经首轮 seed 已在其中，
        // 旧 contact_remark 兜底档随入口标准化废除）；模型原始参数保留在流水审计，不作权威事实。
        let brandCatalog: Awaited<ReturnType<SpongeService['fetchBrandList']>> = [];
        try {
          brandCatalog = await spongeService.fetchBrandList();
        } catch (error) {
          logger.warn(`品牌目录拉取失败，入口标准化按空目录降级: ${toErrorMessage(error)}`);
        }
        const brandPlan = buildBrandQueryPlan({
          brandAliasList: brandAliasListInput,
          brandIdList: brandIdListInput,
          brandFilterMode,
          sessionBrandState: context.archive.sessionBrandState ?? null,
          catalog: brandCatalog,
        });

        // 矛盾组合：列表空 + enforce/exclude（§8.1 组合表第 4 行）。
        if (brandPlan.error === 'empty_list_with_mode') {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.JOB_LIST_BRAND_MODE_CONFLICT,
            outcome: `brandFilterMode='${brandPlan.filterMode}' 但品牌列表为空`,
            replyInstruction:
              `brandFilterMode='${brandPlan.filterMode}' 必须配合非空的 brandIdList/brandAliasList。` +
              "请补上要查询/排除的品牌后重试；若本意是无品牌查询，改传 brandFilterMode='clear'（放宽重查）" +
              "或 'browse_all'（候选人明确不限品牌）。",
            details: { queryMeta: { brand: toBrandQueryMeta(brandPlan) } },
          });
        }

        // 模型传了品牌但全部被拒（未命中/歧义）：不得静默降级成无品牌查询乱推。
        // 先与会话最近推荐品牌池做同音回指（"刘姐妹"→"成都你六姐"口误场景，§8.3）。
        if (brandPlan.allRejected) {
          const rejectedInputs = brandPlan.rejected.map((item) => item.input);
          const fuzzySuggestions =
            (context.archive.recentBrandPool?.length ?? 0) > 0
              ? findBrandFuzzyMatches(rejectedInputs, context.archive.recentBrandPool ?? [])
              : [];
          return buildBrandRejectedResult({
            brandPlan,
            fuzzySuggestions,
            noMatchScript: buildNoMatchScript({
              brandLabels: rejectedInputs,
              storeLabels: storeNameList,
              cityLabels: normalizedCityNameList,
              regionLabels: normalizedRegionNameList,
              maxKm: null,
              scheduleConstraintLabel: candidateScheduleConstraint
                ? formatScheduleConstraintLabel(candidateScheduleConstraint)
                : null,
            }),
          });
        }

        if (brandPlan.brandSource === 'session_state') {
          logger.log(
            `会话品牌兜底命中：currentBrand=${JSON.stringify(brandPlan.applied)}（brandSource=session_state）`,
          );
        }
        const brandAliasList = brandPlan.queryBrandAliasList;
        const brandIdList = brandPlan.queryBrandIdList;
        // exclude 档的 applied 是“候选人不要的品牌”，不能拿来生成“该品牌没岗”的
        // 候选人话术；无结果脚本只承接正向 enforce 查询的品牌。
        const noMatchBrandLabels =
          brandPlan.filterMode === 'enforce'
            ? brandPlan.applied.map((brand) => brand.canonicalName)
            : [];
        // 候选人在更早轮次表达过的班次硬约束已经被 fact-extraction 持久化到
        // sessionFacts.preferences.schedule_constraint。Agent 本轮调本工具时若没显式
        // 传 candidateScheduleConstraint，自动从 sessionFacts 兜底，避免 Agent 忘了
        // 拉回候选人原话（badcase 簇 schedule_constraint_forgotten）。
        // 模型传了约束也不整体采信：
        // 候选人要"周六的兼职"，模型却传 {onlyEvenings:true} 把"周六"弄丢。持久化约束
        // 是候选人原话的高置信沉淀，须与模型入参逐字段合并：模型显式传的字段保留
        // （本轮新信息优先），漏传的字段由持久化约束补齐；空对象 {} 视同未传
        // （{} 是 truthy，不显式排除会绕过兜底）。
        const persistedConstraint =
          context.archive.sessionFacts?.preferences?.schedule_constraint ?? null;
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
              `(3) 仅当 geocode 报 ${TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX} 或 ambiguous 多候选时，才中性反问候选人所在城市；` +
              '反问必须中性，不得带具体城市名（"是 X 城市吗"会构成诱导）。',
          });
        }

        // jobCategoryList 只做本地软排序信号、不下传 API；两道确定性剥离保住排序信号纯净度：
        // 1）用工形式词（兼职/全职/小时工/寒假工/暑假工 等）——是岗位 laborForm 属性，已有独立硬过滤；
        // 2）「店员/员工/工作人员」等泛化统称——不是真实工种名的子串，必然 0 命中，
        //    会触发「无明确匹配工种」披露误导模型说"没有店员岗"。
        const laborFormStrip = stripLaborFormFromCategories(jobCategoryList);
        const umbrellaStrip = stripGenericPositionUmbrella(laborFormStrip.cleaned);
        const sanitizedJobCategoryList = umbrellaStrip.cleaned;
        const removedCategoryWords = laborFormStrip.removed;
        const removedUmbrellaCategoryWords = umbrellaStrip.removed;
        if (removedCategoryWords.length > 0) {
          logger.warn(
            `jobCategoryList 兜底剔除用工形式词: ${removedCategoryWords.join('、')}（原始: ${JSON.stringify(jobCategoryList)}）`,
          );
        }
        if (removedUmbrellaCategoryWords.length > 0) {
          logger.warn(
            `jobCategoryList 兜底剔除泛化统称词: ${removedUmbrellaCategoryWords.join('、')}（原始: ${JSON.stringify(jobCategoryList)}）`,
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
        const maxKmThreshold = context.runtime.thresholds?.find(
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

        // 点名品牌意向：品牌查询有独立的"距离豁免 + 0 条放宽"处理（见 DESCRIPTION
        // 「点名品牌豁免距离上限」条目与各 hasBrandIntent 绕行点），区级兜底
        // 一律绕开，避免给品牌结果套上 maxKm 距离帽把远处的品牌门店藏掉。查询品牌条件来自
        // 入口标准化后的 brandPlan（enforce 档，含会话品牌兜底），故兜底品牌也走品牌豁免。
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
        // 与坐标 AND 在一起只会把隔壁区更近的门店排除掉（badcase 同源）。模型偶尔
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

        // jobCategoryList 有意不进查询参数：模型猜的工种词与海绵类目字典对不上，API 精确
        // 匹配基本落空（"传了基本出不来岗位"）。工种意向改为召回后本地软排序 + 知情披露，
        // 见下方 rankJobsByRequestedCategories。
        let fetchBaseParams = {
          cityNameList: cityFilterNormalization.cityNameList,
          regionNameList: regionNameListForQuery,
          brandAliasList,
          brandIdList,
          projectNameList,
          projectIdList,
          storeNameList,
          searchJobName: searchJobName?.trim() || undefined,
          jobIdList,
          salaryPeriodNameList: settlementPeriodList.map((p) => p.trim()).filter(Boolean),
          location: effectiveLocation,
          options,
        };
        try {
          let storeMatchStrategy: 'api_exact' | 'local_fuzzy_match' = 'api_exact';
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
          let searchNameRelaxed = false;

          // 跨轮重复查询检测：归一化后的实质过滤条件
          // 与上一轮完全一致时，结果必然相同——结果头部注入提醒，要求模型实质调整查询
          // 或按既有拉群优先阶梯兜底，不得复读"没有"。同轮 Bull 重试（turnId 相同）不触发。
          const querySignature = buildJobListQuerySignature({
            cityNameList: fetchBaseParams.cityNameList,
            regionNameList: fetchBaseParams.regionNameList,
            brandAliasList: fetchBaseParams.brandAliasList,
            brandIdList: fetchBaseParams.brandIdList,
            // exclude 模式的品牌不进上游查询参数（本地剔除），mode 与排除名单单独入签名
            brandFilterMode:
              brandPlan.filterMode === 'exclude' && brandPlan.excludeBrands.length > 0
                ? 'exclude'
                : fetchBaseParams.brandAliasList.length > 0 ||
                    fetchBaseParams.brandIdList.length > 0
                  ? 'enforce'
                  : null,
            excludeBrandNames: brandPlan.excludeBrands.map((brand) => brand.canonicalName),
            projectNameList: fetchBaseParams.projectNameList,
            projectIdList: fetchBaseParams.projectIdList,
            storeNameList: fetchBaseParams.storeNameList,
            searchJobName: fetchBaseParams.searchJobName,
            // 类目词不再进查询参数（本地软排序信号），但仍入签名：换工种关键词重查时
            // 排序/披露会变，不应被跨轮重复查询检测误拦。
            jobCategoryList: sanitizedJobCategoryList,
            jobIdList: fetchBaseParams.jobIdList,
            salaryPeriodNameList: fetchBaseParams.salaryPeriodNameList,
            location: fetchBaseParams.location ?? null,
            candidateScheduleConstraint: candidateScheduleConstraint ?? null,
            candidateLaborForm,
          });
          const previousQuery = context.archive.lastJobListQuery ?? null;
          const isRepeatQuery = Boolean(
            previousQuery &&
              previousQuery.signature === querySignature &&
              previousQuery.turnId !== (context.session.turnId ?? null),
          );

          // 首次请求
          let { jobs, total } = await fetchJobs(fetchBaseParams);
          context.ledger.recordJobListQuery({ signature: querySignature });
          // 本轮已产出查岗结论：invite_to_group 的时机 gate 据此判断"是否突兀拉群"
          //（回合内直写，同 bookingSucceeded 模式）。放在请求返回后而非入口，
          // 是因为"发过请求但抛异常"不构成可告知候选人的查岗结论。
          context.ledger.jobs.jobListExecuted = true;

          // 县级市行政层级兜底：候选人报县级市（“延吉市铁南”）时提取会把“延吉”放进
          // cityNameList，而海绵存的是 city=延边朝鲜族自治州、region=延吉市，正确坐标与
          // 错误 city 做 AND 后返回 0。已有精确坐标时，0 条后去掉 city 做一次 location-only
          // 召回；为了避免
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
              const reason = toErrorMessage(error);
              logger.warn(`城市层级过滤兜底查询失败，保留原始 0 条结果: ${reason}`);
            }
          }

          // 场所名模糊查回退：候选人分享了精确坐标、模型又把候选人口述的商场/写字楼名
          // （"万辉国际"）塞进 searchJobName 时，两者做 AND 必然 0 条——口述名多半与库内
          // 岗位名对不上，而坐标才是硬约束。0 条后去掉 searchJobName 再做一次距离召回，
          // 避免把"这个楼里没有在招岗"误报成"你附近 10 公里没有岗位"并直接拉群收口。
          // 距离仍受原 location.range 约束，不会带回远处岗位。
          if (jobs.length === 0 && hasCoordinates && searchJobName?.trim()) {
            try {
              const locationOnly = await fetchJobs({
                ...fetchBaseParams,
                searchJobName: undefined,
              });
              if (locationOnly.jobs.length > 0) {
                jobs = locationOnly.jobs;
                total = locationOnly.total ?? locationOnly.jobs.length;
                fetchBaseParams = { ...fetchBaseParams, searchJobName: undefined };
                searchNameRelaxed = true;
                logger.warn(
                  `场所名模糊查兜底命中：searchJobName="${searchJobName.trim()}" 原查询 0 条，` +
                    `去掉名称后距离召回 ${locationOnly.jobs.length} 条`,
                );
              }
            } catch (error: unknown) {
              logger.warn(`场所名模糊查兜底失败，保留原始 0 条结果: ${toErrorMessage(error)}`);
            }
          }

          // 门店名模糊匹配回退：去掉 storeNameList 后在同范围（城市/区域/品牌等）宽查，
          // 再按门店名本地模糊过滤。不能查全量（{ options }）——上游要求至少一个筛选
          // 条件，无筛选请求会被拒（"查询岗位时至少提供一个筛选条件"），把"该门店已
          // 无在招岗位"这一合法结果污染成接口故障。
          if (jobs.length === 0 && storeNameList.length > 0) {
            const fallback = await fetchJobs({ ...fetchBaseParams, storeNameList: [] });
            if (fallback.jobs.length > 0) {
              const lowerKeywords = storeNameList.map((s) => s.toLowerCase());
              const filtered = fallback.jobs.filter((job) => {
                const storeName = (
                  (job.basicInfo?.storeInfo as StoreInfoView | undefined)?.storeName || ''
                ).toLowerCase();
                return lowerKeywords.some((kw) => storeName.includes(kw));
              });
              if (filtered.length > 0) {
                storeMatchStrategy = 'local_fuzzy_match';
                jobs = filtered;
                total = filtered.length;
              }
            }
          }

          // 区级精确过滤 → 距离召回的确定性兜底。
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

          // 距离锚点精度确定性判定（方案 11.3，B-1）——不依赖模型转抄 areaLevelQuery：
          // 1) 工具内区级兜底（regionRelaxedToLocation）本身用的就是区中心坐标 → area_level；
          // 2) 本轮坐标与 geocode 写入回合上下文的区级锚点坐标匹配 → area_level；
          // 3) 其余（位置分享 / POI 级 geocode）→ poi 精确口径。
          const matchedGeocodeAnchor =
            locationLatitude != null && locationLongitude != null
              ? (context.ledger.geo.anchors ?? []).find(
                  (anchor) =>
                    Math.abs(anchor.longitude - locationLongitude) <=
                      GEOCODE_ANCHOR_COORD_TOLERANCE &&
                    Math.abs(anchor.latitude - locationLatitude) <= GEOCODE_ANCHOR_COORD_TOLERANCE,
                )
              : undefined;
          const distanceAnchor: DistanceAnchorPrecision | null = regionRelaxedToLocation
            ? { precision: 'area_level', areaName: regionRelaxedToLocation.region }
            : matchedGeocodeAnchor?.areaLevelQuery
              ? { precision: 'area_level', areaName: matchedGeocodeAnchor.areaName }
              : hasUserCoords
                ? { precision: 'poi', areaName: null }
                : null;

          // 坐标来源判定（方案 11.3 修复点 1，v3.2，shadow 观测不改查询行为）：
          // - turn_geocode：坐标与本轮 geocode 锚点匹配（含 ≤1km 的截断误差）；
          // - model_supplied：本轮有 geocode 锚点，但坐标与所有锚点偏差 >1km——模型自编坐标；
          // - unreferenced：本轮无 geocode 锚点（改半径复查未重新 geocode / 位置分享转抄），
          //   无确定性参照，仅记量作为后续 enforce 决策依据。
          const turnAnchors = context.ledger.geo.anchors ?? [];
          let coordsProvenance: 'turn_geocode' | 'model_supplied' | 'unreferenced' | null = null;
          let coordsDeviationKm: number | null = null;
          if (hasUserCoords) {
            if (regionRelaxedToLocation || matchedGeocodeAnchor) {
              // 区级兜底坐标是工具内部 geocode 的，可信；命中回合锚点同理。
              coordsProvenance = 'turn_geocode';
            } else if (turnAnchors.length > 0) {
              const minDeviationKm = Math.min(
                ...turnAnchors.map((anchor) =>
                  haversineDistance(
                    locationLatitude,
                    locationLongitude,
                    anchor.latitude,
                    anchor.longitude,
                  ),
                ),
              );
              coordsDeviationKm = Math.round(minDeviationKm * 10) / 10;
              coordsProvenance =
                minDeviationKm > MODEL_SUPPLIED_COORD_DEVIATION_KM
                  ? 'model_supplied'
                  : 'turn_geocode';
              if (coordsProvenance === 'model_supplied') {
                logger.warn(
                  `模型传入坐标 (${locationLatitude},${locationLongitude}) 与本轮 geocode 锚点最小偏差 ${coordsDeviationKm}km，疑似自编坐标，搜索圈可能画错位置（shadow 观测，未干预查询）`,
                );
              }
            } else {
              coordsProvenance = 'unreferenced';
            }
          }
          const distanceThreshold = context.runtime.thresholds?.find(
            (t) => t.flag === 'max_recommend_distance_km',
          );
          // 模型显式传入 location.range 时，本地距离过滤以 range 为准（schema 契约：
          // 候选人要求更广/更窄半径时的放宽出口），超过 EXPLICIT_RANGE_CAP_KM 截断；
          // 未传时按业务阈值兜底（此前只读
          // 阈值，range=20000 实际仍按 10km 过滤，模型据"附近 10km 内"的结果口径
          // 谎称"扩到 20 公里查了没有"）。
          const requestedRangeKm =
            location?.range != null && location.range > 0 ? location.range / 1000 : null;
          const rangeClampedByCap =
            requestedRangeKm != null && requestedRangeKm > EXPLICIT_RANGE_CAP_KM;
          const maxKm =
            requestedRangeKm != null
              ? Math.min(requestedRangeKm, EXPLICIT_RANGE_CAP_KM)
              : distanceThreshold?.max;

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
            for (const job of jobs) {
              const store = job.basicInfo?.storeInfo as StoreInfoView | undefined;
              if (store?.latitude != null && store?.longitude != null) {
                (job as JobWithDistance)._distanceKm = haversineDistance(
                  locationLatitude!,
                  locationLongitude!,
                  Number(store.latitude),
                  Number(store.longitude),
                );
              }
            }

            if (maxKm != null) {
              const beforeCount = jobs.length;
              jobs = jobs.filter((job) => {
                const distanceKm = (job as JobWithDistance)._distanceKm;
                return distanceKm == null || distanceKm <= maxKm;
              });
              total = jobs.length;
              if (beforeCount > 0 && jobs.length === 0) {
                return buildToolError({
                  errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
                  outcome: `附近 ${maxKm}km 内无符合岗位`,
                  replyInstruction:
                    '附近半径内已过滤为空。先尝试一次合理范围内的扩面（同城邻区 / 放宽距离 / 同品牌邻店），' +
                    '本轮直接执行，不要向候选人多问。' +
                    '若扩面后仍无结果，**严格按 noMatchScript.candidateMessage 原文照念给候选人并结束本轮**——' +
                    '真实无岗不得调用 invite_to_group；' +
                    '不要自己改写承接句，不要跨品牌推荐。',
                  details: {
                    maxKm,
                    noMatchScript: buildNoMatchScript({
                      brandLabels: noMatchBrandLabels,
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
            jobs.sort((a, b) => {
              const aDistanceKm = (a as JobWithDistance)._distanceKm;
              const bDistanceKm = (b as JobWithDistance)._distanceKm;
              if (aDistanceKm == null && bDistanceKm == null) return 0;
              if (aDistanceKm == null) return 1;
              if (bDistanceKm == null) return -1;
              return aDistanceKm - bDistanceKm;
            });
          }

          // 品牌意向硬过滤（§8.2 入口标准化后为等值比较）：enforce 档把结果过滤到
          // 实际应用的品牌 ID/标准名，杜绝跨品牌乱推（找大米先生
          // 推史伟莎——sponge 某些场景做模糊匹配）。过滤后 0 条 fall through 到下方
          // no-match 路径，触发 noMatchScript 拉群兜底。
          const brandEqualityTarget = {
            brandIds: brandPlan.applied
              .map((brand) => brand.brandId)
              .filter((id): id is number => id != null),
            canonicalNames: brandPlan.applied.map((brand) => brand.canonicalName),
          };
          if (brandPlan.filterMode === 'enforce' && brandPlan.applied.length > 0) {
            const beforeBrandFilter = jobs.length;
            jobs = filterJobsToAppliedBrands(jobs, brandEqualityTarget);
            if (jobs.length !== beforeBrandFilter) {
              total = jobs.length;
              logger.log(
                `品牌硬过滤（等值）：applied=${JSON.stringify(brandEqualityTarget.canonicalNames)} 剔除非匹配品牌 ${beforeBrandFilter - jobs.length} 条`,
              );
            }
          }
          // exclude 档：上游接口无品牌排除参数，只能召回后本地剔除（§8.1，已知召回空洞局限）。
          if (brandPlan.filterMode === 'exclude' && brandPlan.excludeBrands.length > 0) {
            const beforeExcludeFilter = jobs.length;
            jobs = filterJobsExcludingBrands(jobs, brandEqualityTarget);
            if (jobs.length !== beforeExcludeFilter) {
              total = jobs.length;
              logger.log(
                `品牌排除过滤：excluded=${JSON.stringify(brandEqualityTarget.canonicalNames)} 剔除 ${beforeExcludeFilter - jobs.length} 条`,
              );
            }
          }

          if (jobs.length === 0) {
            // 乡镇/街道/新镇/地标级地名被误当 regionNameList（川沙、九亭、周浦 等）：后端只精确
            // 匹配区级 storeRegionName，这类地名必然命中 0 ≠ 该片区无岗（候选人答"川沙"、
            // Agent 直接 regionNameList=["川沙"] 查 0 条就拉群收口）。
            // 无坐标、无高稳定主键、无品牌别名兜底时，引导 Agent 先 geocode
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

            // 品牌查询命中 0 时，先和会话最近推荐过的品牌池做同音/字形回指匹配，
            // 识别"刘姐妹"实指上轮推过的"成都你六姐"这类候选人口误。
            // 全未命中品牌库的入参已在入口标准化
            // 提前走 buildBrandRejectedResult；此处兜的是"品牌合法但查无岗位"的残余，
            // 用模型原始入参（口误原文）做回指。
            const hadBrandCondition =
              brandPlan.filterMode === 'enforce' && brandPlan.applied.length > 0;
            const fuzzySuggestions =
              hadBrandCondition && (context.archive.recentBrandPool?.length ?? 0) > 0
                ? findBrandFuzzyMatches(
                    brandAliasListInput.length > 0
                      ? brandAliasListInput
                      : brandPlan.applied.map((brand) => brand.canonicalName),
                    context.archive.recentBrandPool ?? [],
                  )
                : [];

            // 匹配分歧度判定（与守卫共享 resolveFuzzyConfidence）：
            // - 单一候选 / top1 领先 ≥0.15 → 高置信，Agent 直接沿用该品牌（轻确认带过）
            // - 多个分数接近 → 低置信，反问澄清
            const fuzzyConfidence = resolveFuzzyConfidence(fuzzySuggestions);
            const topMatch = fuzzySuggestions[0] ?? null;

            let replyInstruction: string;
            let outcome: string;
            if (fuzzyConfidence === 'high' && topMatch) {
              outcome = '品牌别名疑似口误，已自动回指最近推荐品牌';
              replyInstruction =
                '品牌查询命中 0，但候选人输入与会话最近推荐的 **' +
                topMatch.brandName +
                '** 高度同音回指（见 queryMeta.brand.fuzzySuggestions[0]）。**直接按该品牌继续推进**，' +
                '回复时用一句轻确认带过（如"成都你六姐这家…"）让候选人自然听到正确品牌名；' +
                '**不要单独反问"你是说 X 吗"，不要照念 noMatchScript，不要调 invite_to_group。' +
                '若需要重新拿岗位详情，从 [会话记忆] 已展示岗位里取 jobId 直查，避免重复品牌别名。' +
                '候选人后续若否认这个品牌，再按 noMatchScript 收口。';
            } else if (fuzzyConfidence === 'low') {
              outcome = '品牌别名疑似口误，候选品牌多个分数接近，需反问澄清';
              replyInstruction =
                '品牌查询命中 0，会话最近品牌池里存在多个同音/字形候选（见 queryMeta.brand.fuzzySuggestions），' +
                '分数差过小无法判定指代哪一个。**用一句反问澄清**："你说的是 X 还是 Y？"——' +
                '不要直接答"没查到"，不要照念 noMatchScript，不要调 invite_to_group。';
            } else {
              outcome = '未找到符合条件的岗位';
              replyInstruction =
                '本次查询无匹配岗位。先核对是否用了 storeNameList 等低稳定字段；' +
                '是则换 regionNameList / brandIdList 重试一次；需要放宽品牌条件重查时显式传 ' +
                "brandFilterMode='clear'（只省略品牌参数会被会话品牌兜底拉回）。" +
                '若已是高稳定字段仍为 0，**严格按 noMatchScript.candidateMessage 原文照念给候选人并结束本轮**——' +
                '真实无岗不得调用 invite_to_group；' +
                '不得自行改写承接句、不得跨品牌推荐、不得反问"换品牌 / 换城市 / 别的区域"；' +
                '候选人主动追问扩张时同样按此动作链处理。';
            }

            return buildToolError({
              errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
              outcome,
              replyInstruction,
              details: {
                cityFilterRecovery,
                ...(brandPlan.brandSource === 'session_state' && brandPlan.disclosure
                  ? { brandFilterNotice: brandPlan.disclosure }
                  : {}),
                noMatchScript: buildNoMatchScript({
                  brandLabels: noMatchBrandLabels,
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
                        brandAliasList: brandAliasListInput,
                        confidence: fuzzyConfidence,
                        suggestions: fuzzySuggestions,
                      }
                    : null,
                queryMeta: {
                  brand: toBrandQueryMeta(
                    brandPlan,
                    fuzzySuggestions.map((match) => ({
                      brandName: match.brandName,
                      inputAlias: match.inputAlias,
                      score: match.score,
                    })),
                  ),
                },
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
                '**严格按 noMatchScript.candidateMessage 原文照念给候选人并结束本轮**，不得调用 invite_to_group。' +
                '候选人的可上班时段是刚性需求：**禁止劝候选人放宽时段/调整自己的时间迁就班次**' +
                '（不得问"要不要放宽一下时段/全天班周末班也可以考虑吗"）；只有候选人后续主动改口放宽，才按新时段重新查岗。' +
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
                  scheduleExcludedCount: scheduleFilterResult.excluded.length,
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
                  ? '候选人已明确只要暑假工：请直接回复“抱歉，你附近暂时没有合适的暑假工岗位。”并结束本轮。' +
                    '不得追加问题、替代建议，不得主动推荐、展示或询问是否考虑普通兼职/小时工/全职，' +
                    '不得沿用历史非暑假工岗位继续收资或约面；' +
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

          // 学生身份硬过滤（先筛后推，badcase fazpqciu）：候选人已明确学生身份时，
          // "不接受学生"的岗位在查询侧直接剔除，不进推荐池。从确定性会话事实读取，
          // 不依赖 LLM 入参；is_student=false 有抽取污染史，只有 true 触发过滤。
          const candidateIsStudent = resolveCandidateIsStudent(context);
          const studentFilterResult = applyStudentIdentityConstraint(jobs, candidateIsStudent);
          let studentFilterNotice: string | null = null;
          if (studentFilterResult.applied) {
            jobs = studentFilterResult.jobs;
            total = jobs.length;
            if (studentFilterResult.excluded.length > 0 && jobs.length === 0) {
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.JOB_LIST_STUDENT_FILTER_EMPTY,
                outcome: '本轮召回岗位全部不接受学生，按候选人学生身份过滤后为空',
                replyInstruction:
                  '候选人已明确是学生，本轮召回的岗位经「学生身份要求」核对后全部只招社会人士，已被剔除。' +
                  '**按 noMatchScript.candidateMessage 如实告知附近岗位暂不接受学生**（学生门槛是可公开条件，可以明说），' +
                  '然后结束本轮，后续有接受学生的岗位再通知；真实无岗不得调用 invite_to_group。' +
                  '**严禁**建议候选人按社会人士登记、隐瞒学生身份或"先报上再说"（诚信红线），' +
                  '也不得把被剔除的岗位包装回去。',
                details: {
                  queryMeta: {
                    studentIdentityFilter: {
                      applied: true,
                      excludedCount: studentFilterResult.excluded.length,
                      excludedExamples: studentFilterResult.excluded.slice(0, 3),
                    },
                  },
                  noMatchScript: buildNoMatchScript({
                    brandLabels: brandAliasList,
                    storeLabels: storeNameList,
                    cityLabels: normalizedCityNameList,
                    regionLabels: normalizedRegionNameList,
                    maxKm: maxKm ?? null,
                    identityConstraintLabel: '学生可做',
                  }),
                },
              });
            }
            if (studentFilterResult.excluded.length > 0) {
              // 知情披露：部分岗位被身份过滤剔除时向模型说明，避免它按记忆中的
              // 品牌数量口径（如"附近有3家哈根达斯"）与过滤后结果自相矛盾。
              studentFilterNotice =
                `ℹ️ 候选人已明确学生身份：本轮已剔除 ${studentFilterResult.excluded.length} 个「不接受学生」的岗位，` +
                '以下仅展示学生可做/未标注学生限制的岗位。不得再推荐被剔除岗位；候选人点名问到时，如实说明该岗只招社会人士。';
            }
          }

          // 意向工种本地软排序（不下传 API、不过滤）：明确匹配的岗位稳定分区排前
          //（组内保持距离序），匹配情况经头部 notice 向模型知情披露，由模型按
          // 岗位名称/工作内容自行判断相近岗位并如实告知候选人。
          const jobCategoryRank = rankJobsByRequestedCategories(jobs, sanitizedJobCategoryList);
          jobs = jobCategoryRank.jobs;
          let jobCategoryNotice: string | null = null;
          if (jobCategoryRank.applied) {
            const requestedLabel = sanitizedJobCategoryList.join('、');
            jobCategoryNotice =
              jobCategoryRank.matchedCount > 0
                ? `ℹ️ 候选人意向工种「${requestedLabel}」：已把 岗位名称/岗位类型/工作内容 明确匹配的 ${jobCategoryRank.matchedCount} 个岗位排在最前（仅排序，未过滤，其余岗位仍在列表后段）。介绍时按每个岗位的真实名称/内容说明，不得把其他工种包装成「${requestedLabel}」。`
                : `⚠️ 本轮召回中没有 岗位名称/岗位类型/工作内容 明确匹配「${requestedLabel}」的岗位；以下为同范围其他在招岗位（工具未做工种过滤）。请先如实告知候选人"附近暂时没有明确的${requestedLabel}岗位"，再逐条按岗位名称/工作内容判断是否相近、介绍给候选人自行决定；不得把其他工种包装成「${requestedLabel}」，也不得据此直接判定无岗拉群。`;
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
          const brandGroups = buildBrandNearestStoreSummary(jobs, distanceAnchor);
          const multiStoreGroups = getMultiStoreBrandGroups(brandGroups);

          // 兜底知情披露（§8.1）：brandSource=session_state / 品类裁剪时向模型说明
          // 所用品牌与 clear 覆盖出口，兜底不做静默注入。
          const brandFilterNotice =
            brandPlan.brandSource === 'session_state' ||
            brandPlan.categoryExcludedRemoved.length > 0
              ? brandPlan.disclosure
              : null;

          // 传入 range 超硬上限时知情披露：防止模型按传入值向候选人转述"已查 Xkm"
          const rangeClampNotice = rangeClampedByCap
            ? `ℹ️ 本次距离过滤按硬上限 ${EXPLICIT_RANGE_CAP_KM}km 生效（传入 range≈${Math.round(requestedRangeKm!)}km 超出上限）。向候选人转述查询范围时以 ${EXPLICIT_RANGE_CAP_KM}km 为准。`
            : null;

          if (formatSet.has('markdown')) {
            const jobsMarkdown = formatJobsToMarkdown(
              jobs,
              total,
              DEFAULT_PAGE_NUM,
              DEFAULT_PAGE_SIZE,
              flags,
              brandGroups,
              distanceAnchor,
            );
            const markdownSections = [
              isRepeatQuery ? REPEAT_QUERY_NOTICE : null,
              brandFilterNotice ? `ℹ️ ${brandFilterNotice}` : null,
              rangeClampNotice,
              summerWorkerStrictNotice,
              laborFormRelaxNotice,
              studentFilterNotice,
              jobCategoryNotice,
              ageScreeningSummary?.markdown,
              jobsMarkdown,
            ].filter((section): section is string => Boolean(section));
            result.markdown = sanitizeBrandName(markdownSections.join('\n\n'));
          }
          if (formatSet.has('rawData')) {
            result.rawData = { result: jobs, total };
          }
          if (brandFilterNotice) {
            result.brandFilterNotice = brandFilterNotice;
          }
          // 观测自报口径：tool-call-analysis 优先读该字段推断 empty/narrow/ok
          result.resultCount = total;
          const knownCityFactValue = readFactValue(context.archive.sessionFacts?.preferences?.city);
          const knownCityForConflict =
            typeof knownCityFactValue === 'string' ? knownCityFactValue : null;
          result.queryMeta = {
            storeMatchStrategy,
            // 意向工种本地软排序观测（取代 API 直传时代的 jobCategoryMatchStrategy）：
            // requested=剥离后实际参与排序的关键词，matchedCount=明确匹配数，用于评估
            // "靠岗位名称/内容理解工种意向"的效果
            jobCategoryRank: jobCategoryRank.applied
              ? {
                  requested: sanitizedJobCategoryList,
                  matchedCount: jobCategoryRank.matchedCount,
                  totalCount: jobs.length,
                }
              : null,
            // 泛化统称（店员/员工…）被确定性剥离出 jobCategoryList 的记录，供排障对账
            jobCategoryUmbrellaStripped:
              removedUmbrellaCategoryWords.length > 0 ? removedUmbrellaCategoryWords : null,
            // 跨轮重复查询：本轮实质过滤条件与上一轮完全一致（观测排障用）
            repeatQuery: isRepeatQuery
              ? { repeated: true, previousTurnId: previousQuery?.turnId ?? null }
              : { repeated: false },
            regionRelaxedToLocation,
            regionRelaxAttempted,
            regionDroppedForCoords,
            cityFilterNormalization:
              cityFilterNormalization.mappings.length > 0 ? cityFilterNormalization.mappings : null,
            cityFilterRecovery,
            // 场所名兜底：true 表示按候选人口述的场所名查为 0，已改用坐标做距离召回。
            // 结果是"你附近的岗位"而非"该场所内的岗位"，回复时不得把它说成那个楼里的岗位。
            searchNameRelaxed,
            usedDistanceFiltering: hasUserCoords,
            // 距离锚点精度（方案 16.1 GeoQueryMeta.anchor 的 B-1 先行子集）：
            // 区级锚点查询占比的观测口径。⚠️ 原设计的对账对象是守卫规则，但那条规则
            // 早已下线，不存在"拦截量趋零"这个验收项——距离渲染层（distance-render.util）
            // 是这条链路的唯一防线，验收看渲染覆盖率（详见 §7 第 4 条）。
            // 经纬度对调纠偏记录：非 null 表示模型入参被确定性交换过（原始值），
            // 用于对账"纠偏后查询是否恢复正常"；模型原始 args 另存于 tool_calls.args
            coordSwapCorrected: coordSwapOriginal,
            anchor: {
              source:
                regionRelaxedToLocation || matchedGeocodeAnchor
                  ? 'geocode'
                  : coordsProvenance === 'model_supplied'
                    ? 'model_supplied'
                    : null,
              precision: distanceAnchor?.precision ?? null,
              areaLevelQuery: distanceAnchor?.precision === 'area_level',
              areaName: distanceAnchor?.areaName ?? null,
              // 坐标来源观测（v3.2）：model_supplied 频次是"是否强制回退 geocode 坐标"的决策依据
              coordsProvenance,
              coordsDeviationKm,
            },
            // 地理信号冲突 shadow：多个地理信号指向不同城市时记录"本应 ambiguous"案例，
            // 仅观测不干预，先命中先赢行为不变。enforce 已终审 no-go
            // （见 docs/architecture/geo-resolution.md §9.3）——本字段只作排障线索，
            // 勿再当"待决策 shadow"推动。
            // 传已确立会话城市做候选裁决：命中即打 adjudicatedByKnownCity，标记为
            // 同形地名一类噪音而非真冲突，让累计统计能分开两者。
            geoSignalConflictShadow: detectGeoSignalConflict(
              context.archive.sessionFacts?.preferences?.district ?? null,
              context.archive.sessionFacts?.preferences?.location ?? null,
              { knownCity: knownCityForConflict },
            ),
            distanceThresholdKm: maxKm ?? null,
            // 距离上限来源：model_range=模型显式传 location.range（候选人要求的半径），
            // threshold=业务阈值兜底；distanceRangeClamped=true 表示传入值被硬上限截断
            distanceCapSource:
              requestedRangeKm != null ? 'model_range' : maxKm != null ? 'threshold' : null,
            distanceRangeClamped: rangeClampedByCap,
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
            studentIdentityFilter: studentFilterResult.applied
              ? {
                  applied: true,
                  excludedCount: studentFilterResult.excluded.length,
                  excludedExamples: studentFilterResult.excluded.slice(0, 5),
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
            // 品牌散字段（brandIdList/brandAliasList/brandAliasSource/rejectedNickname…）
            // 已收拢为类型化 brand 小节（§11）；模型原始参数在 message_processing_records
            // 调用流水里本来就有，不重复存。
            brand: toBrandQueryMeta(brandPlan),
            searchJobName: searchJobName?.trim() || null,
          };

          // 通知调用方已获取岗位数据
          if (jobs.length > 0) context.ledger.recordFetchedJobs(mapJobsToSummaries(jobs));

          // job.recommended：候选人本轮被推过岗位 → 记一次。fire-and-forget。
          // 幂等键按「本轮 turn」而非「每候选人一次」：daily_ops_report 是当天事件数，
          // 若用 userId 终身键，同一候选人后续天数再次推荐会被压成 0。turnId 缺省（test/debug）回退时间戳。
          if (jobs.length > 0) {
            const turnId = context.session.turnId ?? Date.now().toString();
            void opsEventsRecorder.recordEvent({
              corpId: context.session.corpId,
              eventName: 'job.recommended',
              idempotencyKey: `${context.session.sessionId}:job_recommend:${turnId}`,
              botImId: context.session.botImId,
              managerName: context.session.botUserId,
              sourceChannel: 'unknown',
              userId: context.session.userId,
              chatId: context.session.sessionId,
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
            details: { reason: toErrorMessage(err) || '未知错误' },
          });
        }
      },
    });
    return jobListTool;
  };
}
