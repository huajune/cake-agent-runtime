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
import { stripLaborFormFromCategories } from '@memory/facts/labor-form';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';
import { sanitizeBrandName } from '@tools/utils/sanitize-brand-name.util';
import {
  applyScheduleConstraint,
  filterJobsByRequestedCategories,
  formatScheduleConstraintLabel,
  haversineDistance,
} from '@tools/duliday/job-list/search.util';
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

// ==================== 常量 ====================

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DISTANCE_SCAN_MAX_PAGES = 10;

// ==================== 输入 Schema ====================

const inputSchema = z.object({
  cityNameList: z.array(z.string()).optional().default([]).describe('城市列表'),
  regionNameList: z.array(z.string()).optional().default([]).describe('区域列表'),
  brandAliasList: z.array(z.string()).optional().default([]).describe('品牌别名列表'),
  storeNameList: z.array(z.string()).optional().default([]).describe('门店名称列表（模糊匹配）'),
  jobCategoryList: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      '岗位工种/职位类目，描述这份岗位具体做什么工作。例如：["咖啡师"]、["服务员"]、["理货员"]、["分拣员"]、["收银员"]、["骑手"]。严禁填入"兼职"、"全职"、"小时工"、"寒假工"、"暑假工"、"兼职+"、"临时工"等用工形式词——平台所有岗位都是兼职岗位，用工形式不是岗位工种，若有用工形式偏好应用其他方式在结果中筛选。',
    ),
  brandIdList: z.array(z.number().int()).optional().default([]).describe('品牌ID列表'),
  projectNameList: z.array(z.string()).optional().default([]).describe('项目名称列表'),
  projectIdList: z.array(z.number().int()).optional().default([]).describe('项目ID列表'),
  jobIdList: z.array(z.number().int()).optional().default([]).describe('岗位ID列表'),

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
  includeWelfare: z.boolean().optional().default(false).describe('返回福利信息'),
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
      '候选人班次硬约束。传入后，工具会按岗位 workTime 语义判定是否兼容；不兼容岗位会从结果中移除并在 queryMeta.scheduleFilter 里说明剔除数量。候选人明确表达"只能周末/只做晚班/每周最多两天"等班次硬约束时必须传，避免推荐工作日强排班/全周岗位。',
    ),
});

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapJobsToSummaries(jobs: any[]): RecommendedJobSummary[] {
  return jobs.map((job) => {
    const policy = buildJobPolicyAnalysis(job);
    const ageRequirement = policy.normalizedRequirements.ageRequirement;
    const educationRequirement = policy.normalizedRequirements.educationRequirement;
    const healthCertificateRequirement = policy.normalizedRequirements.healthCertificateRequirement;

    return {
      jobId: job.basicInfo.jobId,
      brandName: job.basicInfo.brandName ?? null,
      jobName: job.basicInfo.jobName ?? null,
      storeName: job.basicInfo.storeInfo?.storeName ?? null,
      storeAddress: job.basicInfo.storeInfo?.storeAddress ?? null,
      cityName: job.basicInfo.storeInfo?.storeCityName ?? null,
      regionName: job.basicInfo.storeInfo?.storeRegionName ?? null,
      laborForm: job.basicInfo.laborForm ?? null,
      salaryDesc: formatSalarySummary(job),
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
    };
  });
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
| 问"某区域有什么" | 已确认城市时 cityNameList + regionNameList，按需补 jobCategoryList / brandIdList；未确认城市时先中性确认城市，禁止凭区县通识补 city |
| 问"附近有什么" / 给了商圈/地标 | 先 geocode 拿坐标 → 传 location 半径；若结果 ≤ 1 条**必须**去掉 location 重查全市 |
| 用户接受了某门店但要换条件 | **先在 [会话记忆] 里查这门店所在的 region**，用 regionNameList 重查；不要直接拿口语门店名传 storeNameList |
| 用户问"还有别的品牌吗" | **不带 brandIdList 重查**当前区域，对比之前已展示的 brand 集合，告诉用户除了已推过的还有什么 |

## 结果数处理（必须遵守）
- **0 条**：本次查询失败。检查是否用了 storeNameList / brandAliasList 等低稳定字段；若是，立即换成 regionNameList / brandIdList 重试一次；若已经是稳定字段且仍为 0，**如实告知候选人"暂时没找到"**，不要再换条件硬试
- **1 条** 且候选人在问"还有别的吗 / 什么品牌 / 其他选择"：把这视为反常信号，**必须再放宽 1 个维度重查**——去掉 location，或扩大半径到全市，或去掉某个 brand/category filter。直接用 1 条结果回答"暂时没空缺"是错误的
- **≥ 2 条**：可以基于结果回复，无需扩面
- **同一轮内本工具调用次数硬上限 = 3**：第 4 次系统会直接拒绝。第 3 次仍未拿到可用数据时，应基于已有结果如实告知候选人，不要再继续猜 filter

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
- 行政区域（静安区/浦东新区等）可直接查岗；商圈/地标/街道/详细地址（人民广场/陆家嘴/XX路123号等）**不得**直接当 regionNameList，需先 geocode 或使用位置分享坐标
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
- **福利信息主动展示**：本轮要做具体岗位推荐时，必须开 includeWelfare=true；工具返回的福利字段（员工餐/包吃住/餐补/补贴/转正机会/节假日加薪等）若非空，必须在岗位介绍中按工具原文展示。候选人没问也要给——这些是候选人决策的重要因素，藏着等候选人问才答的"偷懒式介绍"会显著降低报名率。福利字段为空时按"空头承诺禁忌"如实说"这个我再确认"
- **挑选式开场禁忌**：直接展示 1~2 个最匹配岗位的完整详情，不要先发"有 A/B/C 三个岗位/门店你想看哪个"再等候选人选；候选人挑选式开场容易直接放弃
- **岗位卡片必须紧凑**：单个岗位的"门店名/距离/薪资/班次/要求/工作内容"应**集中在 1-2 段**内描述（行内可用顿号/逗号/空格分隔），不要把同一岗位的各字段用"段间空行（即两个连续换行符）"拆成 5-8 个独立段落——后置的消息切分器（MessageSplitter）按段间空行拆成独立微信消息发出，会导致候选人几秒内连续收到 6-8 条同岗位碎片消息，体验"轰炸式人机"
- **薪资字段必须带单位**：所有薪资数字必须明示单位（如"元/小时""元/月""元/单"）；**严禁**把月薪和时薪并排展示而不带单位（反例：把"X 元/月"和"X 元/小时"写成"X、X"形式，候选人会误读单位）。多岗位混合展示时，所有岗位的薪资单位都要一并标出
- **同会话内同岗位不重复介绍**：同一会话内已经介绍过的岗位（同 jobId 或同门店名），后续轮**不要**重复发"薪资 X 元/班次 X 时间"等已说过的字段；后续轮只补新信息或推进流程，候选人追问某具体字段时再单独答
- 工作内容里出现"清洗灶台/打荷/收档/拖盘/出货"等行业短语时，必须用一句口语化解释展开，让候选人明白具体做什么；不要原样复读简短关键词

## 硬规则
- **品牌/区域分布判断必须基于本工具结果**：候选人说出品牌不得用"XX是吧"直接确认，需先在当前已知范围验证在招；"杨浦没岗、虹口有岗"这类分布结论也必须先查。未查前只能说"我先帮你查下"
- **具体岗位/门店推荐必须带位置**：候选人给了商圈/地标/街道/详细地址/位置分享/经纬度等具体位置线索、且本轮要输出具体岗位或门店推荐时，必须先 geocode 或使用位置分享经纬度再调用本工具；不要因对方没明说"附近/离我近"就跳过。学校、校区、学院、小学部等地点名只代表位置，不代表学历
- **推荐距离是硬约束**：只要本轮在推荐具体岗位/门店，结果必须满足业务距离阈值；超出阈值即使其他条件匹配也不得推荐。无有效 location 时只能回答在招情况或区域分布，不得输出具体推荐
- **同品牌按距离最近优先**：候选人有 brand intent 时（明确说出品牌名 / 反复指代某品牌），先看 queryMeta.brandNearestStores 同品牌最近门店列表；同品牌返回多家时，必须按 brandNearestStores 的距离升序展示，不得跳过更近的同品牌门店转推更远的同品牌门店
- **明确品牌意向时不静默换品牌**：候选人明确说出"找成都你六姐 / 我想去肯德基"时，brand 必须进 brandIdList；该品牌在范围内 0 条岗位时，先告知"暂时没有 X 品牌的岗位"，按下面"无岗时的动作链"收口拉群，**不得**主动反问"看看其他品牌吗"，更不得默默换成其他品牌推荐
- **Agent 自推岗位不适用品牌锁死**：如果候选人并未主动指定品牌，而是你上一轮先推荐了某品牌/门店，候选人只是说"可以"或补收资资料，则该品牌不是硬性 brand intent。后续发现该岗位年龄/性别/班次/学历等条件不匹配时，必须先去掉 brandIdList / brandAliasList，保留候选人的位置、年龄、身份、时间窗等硬约束重查，并基于新结果推荐可匹配岗位；不要直接 request_handoff，也不要用"明确品牌意向"规则阻止换岗自救
- **工时长度反查**：候选人说"时间长一点的 / 工时长 / 全天班 / 想做半天以上"等工时偏好时，必须开 includeWorkTime=true 并基于工作时间字段重新筛选；若结果集仍以短班为主，先告知"附近主要是短班"再问是否扩大区域，不要继续把短班包装成"差不多"
- **首次推荐必须开 includeHiringRequirement + includeWorkTime**，把关键要求 + 工作班次时间随岗位信息一起告知让候选人自行判断；严禁推完岗位再逐个追问个人条件去做比对，更严禁反问"班次能不能接受"自己却没说班次时间
- **无岗时的动作链**：候选人范围内 0 条结果时，按以下顺序收口：
   1. 第一次 0 条 → 在合理范围内放宽一次（同城邻区 / 同品牌邻店 / 放宽距离阈值），且本轮直接执行放宽查询，不向候选人多问一句
   2. 放宽后仍 0 条 = "无替代"，必须直接告知候选人"暂时没有合适岗位"并调用 invite_to_group 拉群维护
   3. 严禁继续反问候选人"那别的区域 / 别的品牌 / 别的城市看看吗"；候选人主动表达扩张意愿前不再继续扩查，否则会陷入"反复问位置→反复无岗"的空转
   4. **候选人主动追问"别的地区有吗 / 别的品牌呢 / 还有其他吗"时本规则同样适用**——必须基于本轮工具结果直接告知"该品牌/城市暂时无岗 + 拉群维护"，不得借候选人的追问继续展开"其他品牌可以吗 / 看看长沙吗 / 上海杭州看看"等扩张推荐
   5. **历史轨迹打破**：即使 [会话记忆] 或对话历史里 Agent 自己上一轮提议过"换品牌/换地区/看看其他城市"，本轮一旦工具结果证实无岗，也必须打破这条轨迹直接收口，不得顺承延续旧的反问思路
- **包餐/工作餐/餐补硬偏好**：候选人说"没饭吃不去了 / 拉倒了 / 不考虑 / 必须包饭"等，视为硬性拒绝或强偏好；不要安慰成"附近吃饭方便"，也不要继续收面试资料。若要继续推荐，必须本轮调用本工具且带 includeWelfare=true 查包餐/餐补/福利信息；没有匹配就说明暂时没有合适的包餐岗位，并调用 invite_to_group 维护
- **面试相关字段**：推进面试时优先读工具结果中的「约面重点」；工具没明确时间不得编造；相对当前时间已过期的日期限制视为历史备注，不得当作当前规则输出

## 空头承诺禁忌
- 工具未返回某福利字段（工作餐/包餐/餐补/班车/补贴等）时，不得说"有 / 没有 该福利"；只能说"这个我再帮你确认下"
- 阶梯薪资必须保留基础时薪 + 阶梯规则原文（例如"基础 25/小时，做满 4 小时再加 5"），禁止简化为"约 X 元"或"固定 X 元/小时"
- 历史助手回复说过的门店事实不能当本轮事实复述；本轮要给候选人新的具体推荐时，必须以本轮工具结果为准；只有 [当前焦点岗位] 等记忆字段是稳定的，可以直接承接
- **工具未返回的业务事实禁止用训练知识/通识补充**：候选人追问"日结具体哪天到账 / 这家面试是线上还是线下 / 同品牌能不能跨店 / 全职岗还是兼职岗 / 排班是固定还是灵活 / 试用期多久 / 经验要求"等业务规则时，若本轮工具结果没明示该字段，必须说"这个我再帮你确认下"或按 request_handoff 转人工，**严禁**用"一般日结当天结 / 同品牌跨店没问题 / 应该是全职"等通识/经验性回答
- **学生身份不能由缺省反推**：候选人是学生/在读/准研究生时，只有工具明确写"学生可/接受学生/学生兼职和社会兼职都可"才能说接受学生；figure=不限、学历够、未写学生限制、工具未返回学生字段，都不能说"身份没限制/没问题"，必须说"这个身份我再确认下"。
- **门店运营状态禁编造**：候选人问"X 店关了吗 / 是不是搬了 / 撤店了"等门店状态问题时，本工具只能确认"是否有在招岗位"（jobs 数组是否为空），**不掌握**门店实际营业 / 装修 / 关店 / 搬迁 / 招满 等运营状态。本轮工具结果为空时只能答"目前查不到 X 在招岗位"，**严禁**用"可能关店调整了 / 应该是搬了 / 估计招满了 / 可能在装修"等推测措辞（badcase z1u2ntbg）。候选人坚持要门店实际状态时，按 request_handoff 转人工。
- **同会话同字段多次查询结果不一致时相信最新一次**：本会话先后多次调用本工具，若同一门店/品牌/区域的"是否在招/班次/薪资/年龄要求"等字段前后返回不同，必须以**最新一次**结果为准，并自洽地回复；不得既承认上轮的"在招"又承认本轮的"无空缺"造成人格分裂。同时必须用一句衔接（"刚再核了一下，这家目前看下来确实没空缺了"），不要让候选人在前后矛盾间困惑`;

export function buildJobListTool(spongeService: SpongeService): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        cityNameList = [],
        regionNameList = [],
        brandAliasList = [],
        brandIdList = [],
        projectNameList = [],
        projectIdList = [],
        storeNameList = [],
        jobCategoryList = [],
        jobIdList = [],
        location,
        responseFormat = ['markdown'],
        includeBasicInfo = true,
        includeJobSalary = true,
        includeWelfare = false,
        includeHiringRequirement = true,
        includeWorkTime = false,
        includeInterviewProcess = false,
        candidateScheduleConstraint,
      }) => {
        const normalizedCityNameList = cityNameList.map((city) => city.trim()).filter(Boolean);
        const normalizedRegionNameList = regionNameList
          .map((region) => region.trim())
          .filter(Boolean);

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
              '查询前必须先确定候选人所在城市。处理顺序：' +
              '(1) 先检查 [会话记忆] / [历史对话] 中候选人是否已明示城市；' +
              '(2) 若候选人提到的地点是公认唯一对应某城市的著名地标，可基于通识补 city 后先调 geocode 验证，再重新调本工具；' +
              '(3) 地点存在多城市同名、属于连锁名称、或无法确认唯一指向时，反问候选人所在城市；反问必须中性，不得带具体城市名。',
          });
        }

        // 兜底：剔除 jobCategoryList 中的用工形式词（兼职/全职/小时工/寒假工/暑假工 等）。
        // 平台所有岗位都是兼职岗位，用工形式不是岗位工种，不应作为 category 查询条件。
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

        const fetchBaseParams = {
          cityNameList: normalizedCityNameList,
          regionNameList: normalizedRegionNameList,
          brandAliasList,
          brandIdList,
          projectNameList,
          projectIdList,
          storeNameList,
          jobCategoryList: sanitizedJobCategoryList,
          jobIdList,
          location: effectiveLocation,
          options,
        };
        try {
          let storeMatchStrategy: 'api_exact' | 'local_fuzzy_match' = 'api_exact';
          let jobCategoryMatchStrategy: 'api_exact' | 'local_keyword_match' = 'api_exact';
          let distanceScanPages = 1;
          let distanceScanTruncated = false;

          // 首次请求
          let { jobs, total } = await spongeService.fetchJobs(fetchBaseParams);

          // 门店名模糊匹配回退
          if (jobs.length === 0 && storeNameList.length > 0) {
            const fallback = await spongeService.fetchJobs({ options });
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
            const fallback = await spongeService.fetchJobs({
              cityNameList: normalizedCityNameList,
              regionNameList: normalizedRegionNameList,
              brandAliasList,
              brandIdList,
              projectNameList,
              projectIdList,
              storeNameList,
              jobIdList,
              options,
            });

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
                const pageResult = await spongeService.fetchJobs({
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
                    '若扩面后仍无结果，按"无岗动作链"直接告知候选人"暂时没有合适岗位"并调用 invite_to_group 拉群维护，' +
                    '禁止反问"换品牌 / 换城市 / 别的区域"。',
                  details: { maxKm },
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

          if (jobs.length === 0) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
              outcome: '未找到符合条件的岗位',
              replyInstruction:
                '本次查询无匹配岗位。先核对是否用了 storeNameList / brandAliasList 等低稳定字段；' +
                '是则换 regionNameList / brandIdList 重试一次。' +
                '若已是高稳定字段仍为 0，如实告知候选人"暂时没有合适岗位"并调用 invite_to_group 拉群维护，' +
                '禁止反问"换品牌 / 换城市 / 别的区域"；候选人主动追问扩张时同样按此动作链处理。',
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
                '先如实告知候选人"在你的班次约束下，附近暂时没有合适的岗位"，' +
                '再询问是否可以放宽时段；若候选人不愿放宽，调用 invite_to_group 拉群维护。' +
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
              },
            });
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

          // 始终计算 brandNearestStores（不再仅在 hasUserCoords 时计算）：
          // 即使没有用户坐标，同品牌≥2 家时也需要 displayLine 让 LLM 区分。
          const brandGroups = buildBrandNearestStoreSummary(jobs);
          const multiStoreGroups = getMultiStoreBrandGroups(brandGroups);

          if (formatSet.has('markdown')) {
            result.markdown = sanitizeBrandName(
              formatJobsToMarkdown(
                jobs,
                total,
                DEFAULT_PAGE_NUM,
                DEFAULT_PAGE_SIZE,
                flags,
                brandGroups,
              ),
            );
          }
          if (formatSet.has('rawData')) {
            result.rawData = { result: jobs, total };
          }
          result.queryMeta = {
            storeMatchStrategy,
            jobCategoryMatchStrategy,
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
            brandNearestStores: brandGroups,
            // 同品牌≥2 家的硬约束信号（badcase laybqxn4）：LLM 必须按 displayLine
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
          };

          // 通知调用方已获取岗位数据
          if (context.onJobsFetched && jobs.length > 0) {
            await context.onJobsFetched(mapJobsToSummaries(jobs));
          }

          return result;
        } catch (err) {
          logger.error('获取岗位列表失败', err);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.JOB_LIST_FETCH_FAILED,
            outcome: '岗位查询接口失败',
            replyInstruction:
              '岗位查询接口暂时不可用。不要把异常信息原文转述给候选人；用招募者口吻安抚"这边稍等下"，' +
              '基于 [会话记忆] 已展示岗位维持上下文，必要时调用 request_handoff 转人工。',
            details: { reason: err instanceof Error ? err.message : '未知错误' },
          });
        }
      },
    });
  };
}
