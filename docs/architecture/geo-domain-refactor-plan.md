# 地理领域改造方案：resolution/geo 迁移与现网行为修复

> 状态：定稿待批（v3）
> 适用仓库：`cake-agent-runtime`
> 定稿日期：2026-07-21（修订历史见第 22 节）
> 关联问题：候选人输入"延吉市/延吉"时岗位查询返回 0 条（点位修复已随 2026-07-10 PR #499 上线，见 2.1）；2026-07 反馈池地理类 badcase 复核（见 3）

## 1. 结论

本方案包含两条并行工作流：

- **工作流 A（领域迁移与收口）**：将 `src/memory/facts/geo-mappings.ts` 的地理知识和确定性算法迁入 **`src/resolution/geo`**，成为地理解析域的唯一真相源；
- **工作流 B（现网行为修复）**：修复反馈数据显示的三类现网地理痛点——区级锚点距离表述、geocode 已解析城市的消费收口、定位选点回归（见 11.3–11.5）。B 线不依赖迁移进度，可先行；其优先级高于 A 线（由 badcase 量级决定，见 3）。

### 1.1 落位裁决

- **不放顶层 `src/geo`**：仓库已建立 `src/resolution` 确定性解析层（首个子域 `resolution/brand`），其定义——纯确定性、零 LLM、"用户表达 → 标准实体 + 证据/置信度"——与地理解析完全同构；本方案 8.2 的 `GeoResolution` 契约就是品牌 `resolve()` 契约的地理版。同一概念只设一个居所，避免"品牌解析在 resolution、地理解析在顶层"的双轨，也为后续解析域（薪资、排班等）立下先例。
- **不留 memory**：该文件被 memory 之外的 agent、infra、tools 三个顶层模块共 6 个文件依赖（见 4），infra 反向依赖 memory 内部实现是当前最刺眼的边界破坏。
- **不放 utils**：见 6.3。
- **工程红利**：`@resolution/*` 路径别名在 tsconfig paths 与 jest `moduleNameMapper` 中均已存在，迁移不需要任何工具链配置改动。

依赖方向：

```mermaid
flowchart LR
  subgraph Resolution["src/resolution 确定性解析层"]
    Brand["brand（品牌解析）"]
    Geo["geo（地理解析，本方案）"]
  end
  Memory["memory 事实提取与记忆"] --> Geo
  Agent["agent 提示与运行时决策"] --> Geo
  Tools["tools 查询编排 + 海绵行政区适配"] --> Geo
  Geocoding["infra/geocoding 高德供应商集成"] --> Geo
  Brand --> Sponge["sponge 海绵 API 客户端"]
  Tools --> Sponge
```

硬约束（详见 12）：

- `resolution/geo` **零出向依赖**：不 import memory / agent / tools / infra / sponge，也不 import `resolution/brand`；
- sponge **禁止** import resolution（现行"禁止反向 import"规则保持），因此海绵行政区适配器落 tools 层，不落 `src/sponge`；
- CLAUDE.md 的 resolution 允许依赖方名单需补入 `infra`（geocoding classifier/ranker 需要）。

## 2. 背景与现状

### 2.1 "延吉市"问题与已上线的点位修复

消息处理流水中出现了三套都合理、但曾经没有被显式转换的口径：

| 环节 | 字段/含义 | 实际值示例 |
| --- | --- | --- |
| 用户表达 | 求职目标城市 | `延吉市` / `延吉` |
| 地理编码 | 地级行政区 + 区县 | `延边朝鲜族自治州` + `延吉市` |
| 海绵岗位检索 | `cityNameList` + region | `延边朝鲜族自治州` + `延吉市` |

直接把用户的 `延吉` 作为海绵 `cityNameList`，即使经纬度完全正确，服务端行政区过滤也会先把岗位排除，返回 0 条（生产 badcase `6a4f83a5ce406a6aeeeab4b2`）。

**点位修复已随 2026-07-10 PR #499（`dd85c550`）上线**，包含：

- 工具边界规范化 `normalizeSpongeCityFilters`：`cityNameList=["延吉"]` 转换为 `city=延边朝鲜族自治州 + region=延吉市`，无坐标的全城查询也能命中；
- 数据表 `COUNTY_LEVEL_CITY_TO_PREFECTURE`（当前含延边州六个县级市）；
- 0 条且有坐标时的 location-only 恢复查询，结果强制经 `filterJobsToRequestedAdministrativeArea` 串城过滤；
- `cityFilterRecovery` 观测字段（attempted / applied / 过滤前后数量）随工具结果记录。

**本方案不重做以上行为**——它们全部转为 Phase 0 的回归基线。

### 2.2 点位修复之后仍需改造的理由

1. 修复以 tools 直接 import memory 内部数据表的方式落地，跨层依赖进一步加深；
2. 行政区层级关系仍未成为独立领域知识，同类隐患没有收口——余姚/慈溪疑似同一类问题（见 9.2）；
3. `geo-mappings.ts` 同时承担数据、匹配算法、歧义策略和供应商相关映射，职责持续混合；
4. infra/geocoding 的 classifier/ranker 反向依赖 memory 的内部实现。

### 2.3 现有设计的演进史

从提交历史看，现有设计经历了四次演进，"集中管理地理映射"这个方向本身是正确的：

1. 2026-04-16（`ed0cc59e`）：把散落在事实提取和 `LocationCityResolver` 的规则合并为单一真相源；
2. 2026-05-18（`f6a12905`）：引入"白名单驱动、最长优先"扫描，解决 `浦东新区航头镇` 被贪婪正则吞并；
3. 2026-05-26（`77622daa`）：引入全国显式"XX市"表，替代宽泛正则，避免"大超市、夜市"误识别为城市；
4. 2026-07-10（`dd85c550`）：引入县级市→地级行政区映射与工具边界转换，修复延吉查询。

要修正的是**所有权和内部边界**，而不是回到规则分散的状态。

## 3. 现网数据依据

对 2026-07-07~07-21 飞书 BadCase 反馈池做了地理专项复核：窗口内 510 条反馈（集中在 07-07~09 的语义评审 shadow 批量观测），地理相关 136 条。数据与决策的对应关系：

**证实优先级排序的**：

- 延吉/余姚类县级市口径问题**零新反馈**——低频长尾，据此把全国数据生成化（Phase 4）定为独立后续项，近期只做业务足迹补录；
- 白名单误命中、通用商业体歧义（万达广场类）无新反例，现有匹配与歧义策略稳定，迁移严格行为等价即可。

**据此新增的设计**：

- 地理信号冲突检测（8.2 关键规则、Phase 3 第 6 步、15.2 用例）：实测出现"成都的 + 静安区"（badcase `xnp1u820`，chat `6a4f2d52ce406a6aee2a420c`）和"回复称成都、geocode 与岗位全为上海"（badcase `i2vljy1u`，chat `6a4f4df8ce406a6aeef5e2f2`）——现有 `resolveCityFromGeoSignals` 先命中先赢，无冲突出口；
- `GeoQueryMeta` 锚点精度字段（16.1）：区级定位被包装成精确距离是当前**最大地理类拦截源**（`district_level_distance_claim` 44 条/2 天），观测必须能按锚点精度切分。

**并入工作流 B 的现网行为修复**（设计见 11.3–11.5）：

| 问题 | 量级 | 根因层 | 修复落点 |
| --- | --- | --- | --- |
| 区级定位下回复输出精确距离 | 44 条/2 天（守卫已拦截，降级话术引发二次投诉） | 工具输出 / prompt | 11.3（B-1，可先行） |
| geocode 已精确解析仍反问城市 | 4 例 | 工具披露 / agent 消费层 | 11.4（B-2，可先行；与 07-20 invite 城市门修复同族） |
| 导航定位卡片选点错误 | 1 例 | geocode 候选选择 | 11.5（B-3，并入 Phase 0 ranker spec） |

这些修复不属于 `resolution/geo` 纯域（6.2 的边界不变），但与迁移共享同一批观测落点与测试资产，作为并行工作流一起交付。

采样口径说明：样本实际集中在 07-07~09 三天（该时段的 shadow 批量回放 + 人工集中提交），不是均匀的两周覆盖；县级市类零反馈的结论受此限制，作为优先级依据而非"问题不存在"的证明。

## 4. 当前职责盘点

`src/memory/facts/geo-mappings.ts`（671 行）当前混合了以下职责：

| 当前内容 | 正确归属 |
| --- | --- |
| 直辖市、全国显式城市名、业务城市前缀 | `resolution/geo/admin` 行政区数据 |
| 县级市/区县 → 上级地级行政区映射 | `resolution/geo/admin` 行政区关系 |
| 热门地点、商圈、地标 → 城市映射 | `resolution/geo/places` 地点别名数据 |
| 城市、区县名称归一化 | `resolution/geo/normalization` |
| 最长优先白名单扫描（原语） | `resolution/geo/matching` |
| 三轮扫描编排（现内嵌 high-confidence extractor） | `resolution/geo/matching` 公共 API（见 8.4） |
| 通用地点后缀歧义判断 | `resolution/geo/policy` |
| 海绵 `cityNameList + region` 转换（现内嵌岗位工具） | tools 层海绵行政区适配 util（见 11.2） |
| 高德请求、候选排序和响应解释 | `infra/geocoding` 供应商集成（不动） |
| 从会话事实补全城市 | memory 消费 geo，不再拥有规则 |

当前直接依赖者（与代码逐一核对过）：

- `src/memory/facts/high-confidence-facts.ts`（导入五张数据表 + 扫描原语，见 8.1）
- `src/memory/services/session.service.ts`
- `src/agent/generator/geocode-location-anchor.util.ts`
- `src/infra/geocoding/geocoding-query-classifier.util.ts`
- `src/infra/geocoding/geocoding-candidate-ranker.util.ts`
- `src/tools/geocode.tool.ts`
- `src/tools/invite-to-group.tool.ts`
- `src/tools/duliday-job-list.tool.ts`

一个 memory 内部文件被 memory 之外三个顶层模块依赖，已具备独立领域特征。

## 5. 设计目标与非目标

### 5.1 目标

1. 建立 `src/resolution/geo`，成为地理确定性知识和纯算法的唯一真相源；
2. 消除 agent、infra、tools 对 memory 内部文件的依赖；
3. 明确行政区领域模型，区分用户表达、标准行政区和供应商查询口径；
4. 保留白名单最长匹配、三轮扫描顺序、歧义策略和事实提取行为，迁移阶段不改变线上语义；
5. 海绵行政区转换从岗位工具抽为独立适配 util（tools 层）；
6. 验证并补录业务足迹内的县级市映射（余姚类），闭环延吉同类隐患；
7. 修复现网地理行为三类痛点（工作流 B，见 11.3–11.5）；
8. 支持可回滚的渐进迁移。

### 5.2 非目标

1. 不自研完整 GIS 或地址解析引擎；
2. 不把高德 SDK/API 调用迁入 geo；
3. 不把所有地点都自动推断到城市，跨城同名保持保守；
4. 不替换 LLM 对开放世界地点的理解能力；
5. 不让 geo 知道 `sessionFacts`、岗位 DTO 或海绵请求 DTO；
6. 不把适配器放入 `src/sponge`（分层规则禁止 sponge → resolution）；
7. 不以一次大提交删除所有旧入口，先兼容门面再逐步清理；
8. 全国行政区数据生成化不阻塞主线（独立后续项，见 Phase 4）。

## 6. 领域边界

### 6.1 `resolution/geo` 负责什么

- 行政区层级和标准名称；
- 城市、区县、地点别名的确定性归一化；
- 高置信白名单匹配：原语（最长优先扫描）与编排（三轮扫描顺序、字符覆盖继承）；
- 跨城同名和通用后缀的歧义策略；
- 从多个地理信号解析标准城市，返回证据，冲突时显式暴露；
- 与供应商无关的地理值对象和解析结果类型。

### 6.2 `resolution/geo` 不负责什么

- 网络请求、缓存、重试和限流；
- 高德的 `adcode`、返回 DTO 或错误码；
- 海绵的 `cityNameList`、`regionNameList`、岗位响应 DTO；
- memory 的事实合并和置信度生命周期；
- tool 的重试策略、用户话术或最终岗位排序。

### 6.3 为什么不是 utils，也不是顶层 `src/geo`

**不是 utils**：utils 适合无领域所有权、可在任意上下文复用的机械函数。"延吉市属于延边州""万达广场是高歧义地点""区县白名单最长优先"都是会随业务和行政区数据演进的领域决策，放 utils 会隐藏决策所有权。

**不是顶层 `src/geo`**：brand 与 geo 是同一个架构概念（确定性解析域）的两个实例——输入用户表达，输出标准实体加证据。为地理另立顶层目录意味着同一概念两个居所、两套分层规则、两份工具链配置，且下一个解析域出现时还要再裁决一次。resolution 层现行规则（"只依赖 sponge，可被 memory/agent/tools/guardrail 依赖"）对 geo 完全适用：geo 取"零依赖"，是"至多依赖 sponge"的子集；唯一需要的修订是允许依赖方补入 infra（见 12）。

两个子域的差异不构成分家理由：brand 目录数据是动态的（来自 SpongeService，故有 DI 门面 `brand-resolution.service.ts`），geo 数据是静态的（纯数据 + 纯函数，不需要 NestJS module）。resolution 层容纳"带 DI 门面的子域"和"纯函数子域"没有任何障碍。

## 7. 目标目录结构

```text
src/resolution/geo/                          # 文件平铺，与 resolution/brand 风格一致（v3.3 裁定）
├── index.ts                                # 稳定出口（见 8.1）
├── geo.types.ts                            # GeoResolution 等与供应商无关的类型
├── administrative-division.data.ts         # 直辖市/县级市映射/区县映射/业务城市前缀
├── explicit-city.data.ts                   # 全国显式 "XX市" 表
├── administrative-area.resolver.ts         # resolveCityFromDistrict / resolveParentAdministrativeArea / resolveCityFromGeoSignals / detectGeoSignalConflict
├── geo-name.normalizer.ts                  # normalizeCityName / normalizeDistrictForLookup
├── whitelist-scanner.ts                    # scanWhitelistKeysByLongest / matchInUncoveredSegments（原语）
├── geo-text-scan.ts                        # scanGeoSignalsFromText（三轮扫描编排，见 8.4）
├── place-alias.data.ts                     # 地标/商圈 → 城市
├── place-alias.resolver.ts                 # resolveCityFromLocation
└── ambiguous-place.policy.ts               # GENERIC_AMBIGUOUS_SUFFIXES / hasGenericAmbiguousSuffix

src/tools/duliday/job-list/
└── sponge-area-filter.util.ts              # 海绵行政区适配（自岗位工具抽出，见 11.2）

scripts/geo/                                 # Phase 4 独立后续项，主线不建
├── generate-administrative-divisions.ts
└── validate-administrative-divisions.ts
```

说明：

- `resolution/geo` 保持纯 TypeScript：不声明 NestJS module、不注入服务（对比：`resolution/brand` 因品牌目录来自 SpongeService 才需要 DI 门面）；
- v3.3 起目录不再按 admin/matching/places/policy 分子目录（与 brand 平铺风格一致）；§4 职责表中的分域概念（admin/places/policy…）仍是文件命名与职责边界的依据，只是不再体现为物理目录；
- 复用现有 `@resolution/*` 别名，tsconfig 与 jest 均无需改动；
- `src/infra/geocoding` 保持原位——它是外部地理编码供应商集成，不是地理领域本身。

## 8. 模块职责与公开 API

### 8.1 顶层出口

业务代码只从 `@resolution/geo` 导入。终态原则：**数据常量不作为公共 API**，行政区关系一律通过 resolver 查询。但现状是消费者直接把数据表当扫描字典用（`high-confidence-facts.ts` 一次导入五张表，classifier 导入两张，岗位工具导入县级市映射表）——所以 index 必须分两段：

```ts
// src/resolution/geo/index.ts

// —— 稳定 API（长期保留）——
export type {
  GeoResolution,
  GeoResolutionEvidence,
  GeoTextScanResult,
  WhitelistScanHit,
  WhitelistScanResult,
} from './geo.types';

export { normalizeCityName, normalizeDistrictForLookup } from './normalization/geo-name.normalizer';
export {
  resolveCityFromDistrict,
  resolveCityFromGeoSignals,
  resolveParentAdministrativeArea,
} from './admin/administrative-area.resolver';
export { resolveCityFromLocation } from './places/place-alias.resolver';
export { scanGeoSignalsFromText } from './matching/geo-text-scan';
export { scanWhitelistKeysByLongest, matchInUncoveredSegments } from './matching/whitelist-scanner';
export { hasGenericAmbiguousSuffix, GENERIC_AMBIGUOUS_SUFFIXES } from './policy/ambiguous-place.policy';

// —— 过渡期导出（消费者收口后随 Phase 5 删除）——
// Phase 1 门面必须兜住现存全部导入符号，否则迁移首日即编译失败。
/** @deprecated 请改用 scanGeoSignalsFromText / resolveParentAdministrativeArea 等 API */
export {
  MUNICIPALITIES,
  SUPPORTED_CITY_PREFIXES,
  DISTRICT_TO_CITY,
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
} from './admin/administrative-division.data';
/** @deprecated 同上 */
export { NATIONAL_CITY_SUFFIX_TO_CITY } from './admin/explicit-city.data';
/** @deprecated 同上 */
export { LOCATION_TO_CITY } from './places/place-alias.data';
```

过渡期导出的收口条件：三轮扫描编排迁入 `scanGeoSignalsFromText`（8.4）且岗位工具改用 `resolveParentAdministrativeArea`（11.2）之后，全库不再有任何文件需要触碰底层 `Record`。

### 8.2 核心类型

迁移第一阶段保持现有字符串签名，避免大范围类型噪音；行为等价迁移完成后，逐步统一到以下结果模型：

```ts
export type AdministrativeLevel =
  | 'municipality'
  | 'prefecture'
  | 'county_level_city'
  | 'district'
  | 'county'
  | 'township'
  | 'place';

export type GeoResolutionEvidence =
  | 'explicit_city_name'
  | 'unique_district_alias'
  | 'county_parent_relation'
  | 'hotspot_alias'
  | 'geocode_resolved';

export interface GeoResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  city: string | null;
  district: string | null;
  level: AdministrativeLevel | null;
  evidence: GeoResolutionEvidence | null;
  matchedText: string | null;
  candidates?: string[];
}
```

关键规则：

- `resolved` 必须带 `evidence`；
- 不确定时返回 `ambiguous/unresolved`，禁止猜测；
- **多信号冲突必须显式暴露**：`resolveCityFromGeoSignals` 现状是先命中先赢（先区县后地标，命中即返回），多个信号指向不同城市时静默取第一个。改为冲突时返回 `ambiguous` + `candidates`，由上游澄清（现网实证见 3）。这是**显式行为变更**，不混入行为等价迁移，落在 Phase 3 独立提交；
- geo 结果不包含高德/海绵字段；
- memory 可把 `evidence` 映射为事实置信度，geo 不反向依赖 memory 类型。

（与 `resolution/brand` 的 resolve 契约刻意同构：状态 + 标准实体 + 证据，评审与观测可以复用同一套心智。）

### 8.3 行政区解析

用查询函数替代直接读取 `COUNTY_LEVEL_CITY_TO_PREFECTURE`：

```ts
interface ParentAdministrativeArea {
  input: string;
  canonicalName: string;
  level: 'county_level_city' | 'district' | 'county';
  parentCity: string;
}

resolveParentAdministrativeArea('延吉')
// => {
//   input: '延吉',
//   canonicalName: '延吉市',
//   level: 'county_level_city',
//   parentCity: '延边朝鲜族自治州'
// }
```

允许兼容裸名称，是因为调用方（工具的 `cityNameList` 参数）已在结构化字段中表达了明确语义；自由文本扫描仍只命中 `延吉市` 这种显式后缀，避免把道路名、门店名中的"延吉"误识别为城市。

### 8.4 自由文本扫描编排归属 geo

现状：三轮扫描的编排——显式城市 → 高置信区县 → 唯一地标 → 未覆盖段正则兜底，字符覆盖逐轮继承——以私有代码内嵌在 `high-confidence-facts.ts`（约 1480 行起）。扫哪张表、按什么顺序、覆盖如何继承，本身就是地理领域决策，不该留在 memory。编排随原语一起迁入 geo，收口为一个公共 API：

```ts
scanGeoSignalsFromText(message: string): GeoTextScanResult
// 返回三类命中（各带白名单来源、位置、推导 city 与 evidence）+ 未覆盖段的 raw district
```

memory 只消费扫描结果，决定如何写入 sessionFacts（置信度生命周期仍归 memory）。这一步完成后，8.1 的过渡期数据表导出即可删除。抽取属于"平移私有代码"，行为等价由 Phase 0 golden cases 锁定。

## 9. 数据设计与治理

### 9.1 分离三类数据

1. **行政区基础数据**：城市、县级市、区县、父子关系（客观行政区事实）；
2. **业务高置信别名**：`光谷 → 武汉`、`陆家嘴 → 上海`（业务运营决策，人工维护）；
3. **歧义策略数据**：`万达广场`、`人民广场` 等跨城通用后缀（防误判策略）。

三类数据来源、更新频率和置信原则不同，不能继续放在同一个大对象中。

### 9.2 已知数据一致性缺陷与业务足迹补录

盘点现有数据发现三处需要处理的缺陷，它们同时是数据校验（9.4）要防的问题类型：

1. **余姚/慈溪双轨规范化（疑似延吉同类，待验证）**：全国显式表把 `余姚市` 规范化为独立城市"余姚"，而 `DISTRICT_TO_CITY` 映射"余姚 → 宁波"，县级市映射表又没有余姚。结果是：候选人说"余姚"能查到（走宁波），说更标准的"余姚市"反而疑似 0 结果（city=余姚 直查海绵，无坐标时不可恢复）——**说得越标准越查不到**。余姚/慈溪在区县白名单里，说明宁波业务足迹覆盖它们，这不是理论风险。处置：Phase 3 先用真实海绵查询验证县级市存储口径，确认后把业务足迹内县级市补录进映射，并按同样思路排查全国显式表中位于业务城市辖下的其他县级市。
2. **朝阳 → 北京是业务偏置，不是"无歧义"**：现实中北京/长春都有朝阳区、辽宁有朝阳市，白名单把"朝阳"判给北京是刻意的业务决策（其余朝阳不在业务区域）。这类条目必须显式标注为业务偏置 override——将来接入国家数据交叉校验（Phase 4）时按 override 豁免，而不是被"纠正"掉。
3. **`SUPPORTED_CITY_PREFIXES` 混入省份"江西"**：它已不是"支持城市表"，而是"高置信裸地名别名表"，且混入了非城市值。拆出独立语义并改名（9.5）。

### 9.3 行政区数据来源与治理原则

现有全国显式城市表的文件头已注明来源（lcn 整理的民政部县以上行政区划数据）——这个"注明来源"的实践保留并强化。终态原则（实施于 Phase 4 独立项）：

- 行政区基础数据由脚本生成，文件头记录数据集名称与版本、获取日期、生成脚本版本、记录数量与校验摘要；
- 生成产物只接受代码生成更新，不接受零散手改；
- 供应商口径差异（海绵非标准命名）与业务偏置（朝阳 → 北京）分别记录在独立 override 文件，不污染生成数据：

```text
src/resolution/geo/admin/
├── administrative-division.generated.ts    # 脚本生成（Phase 4）
└── administrative-division.overrides.ts    # 人工维护：供应商差异 + 业务偏置
```

在 Phase 4 启动前，行政区数据维持人工白名单 + 小步补录，与现有维护方式一致。

### 9.4 数据校验

校验至少覆盖（Phase 4 前先以单测形式存在，见 15.3；Phase 4 后升级为独立校验脚本）：

- key 重复；同一高置信别名映射到多个城市；
- 父子关系环；县级市缺失父级；
- 标准名称尾缀和行政级别不一致；
- **显式城市表 × 县级市映射交叉一致性**：全国显式表中属于业务城市辖下的县级市，必须在县级市映射表有父级条目（正是余姚 case 的防线）；
- 业务裸地名别名表中不得混入省份（现状"江西"，见 9.2）；
- 生成数据数量相对上一版本异常增减（Phase 4）。

### 9.5 命名调整

逐步淘汰含义过宽的名字，迁移期保留旧别名导出，消费者迁完再删除：

| 旧名称 | 建议名称 | 原因 |
| --- | --- | --- |
| `SUPPORTED_CITY_PREFIXES` | `HIGH_CONFIDENCE_BARE_LOCATION_ALIASES` | 并非完整支持城市表，且混入省份 |
| `DISTRICT_TO_CITY` | `UNIQUE_SUBDIVISION_TO_CITY` | 实际含区、县、县级市和业务片区（光谷、东湖高新区） |
| `LOCATION_TO_CITY` | `UNIQUE_PLACE_ALIAS_TO_CITY` | 强调只收录跨城唯一、高置信别名 |
| `COUNTY_LEVEL_CITY_TO_PREFECTURE` | resolver API（8.3） | 调用方不应依赖底层表结构 |

## 10. 白名单扫描与开放世界解析

现有"最长优先 + 字符覆盖"的扫描机制原样保留，它解决的是确定性解析中的真实问题：

1. 先扫描显式城市；
2. 再扫描高置信区县；
3. 再扫描唯一地点别名；
4. 后续扫描继承前一步字符覆盖，避免重叠消费；
5. 未覆盖片段才交给正则识别 raw district（只标注，不补 city）；
6. 白名单外的开放世界地点交给地理编码和多候选验证，不由代码猜城市。

这一机制——**包括第 1–4 步的顺序编排**——属于 geo matching，而不是 memory extractor 的私有实现（见 8.4）。memory 只负责决定如何把命中结果写入事实。

## 11. 供应商适配边界与现网行为修复

### 11.1 高德地理编码

`src/infra/geocoding` 继续负责：请求参数与供应商 DTO、网络调用/超时/重试/缓存、高德候选结果解析、转换为与供应商无关的候选模型。

它可以调用 `@resolution/geo` 完成：名称归一化、歧义地点策略判断、候选行政区一致性比较（classifier/ranker 现状就在这么用，只是 import 路径要修正）。

`resolution/geo` 不能反向 import `@infra/geocoding`。

### 11.2 海绵行政区适配

**落位：`src/tools/duliday/job-list/sponge-area-filter.util.ts`**，与 `search.util.ts`、`hard-requirements.util.ts` 同级。

为什么不是 `src/sponge`：分层规则禁止 sponge 反向 import resolution（12 节），且该转换目前只有岗位查询编排一个消费方，放 tools 层符合现状与规则，无需为它开分层例外。

现状：主体链路已在岗位工具内实现（`normalizeSpongeCityFilters`、location-only 恢复、`filterJobsToRequestedAdministrativeArea` 串城过滤、`cityFilterRecovery` 观测）。本阶段工作是**抽取归位 + 换数据入口 + 补录**，不是新建：

1. 两个函数从 1599 行的岗位工具文件抽出为独立 util（现有 `SpongeCityFilterNormalization` 类型随迁，可顺势更名对齐）；
2. 县级市查询从直读 `COUNTY_LEVEL_CITY_TO_PREFECTURE` 改为 `resolveParentAdministrativeArea`（8.3）；
3. 海绵非标准命名如出现，维护在适配 util 本地 override，不进 geo。

```mermaid
sequenceDiagram
  participant Tool as duliday-job-list tool
  participant Geo as @resolution/geo
  participant Adapter as sponge-area-filter.util
  participant API as Sponge API

  Tool->>Adapter: 规范化城市过滤条件（["延吉"]）
  Adapter->>Geo: resolveParentAdministrativeArea('延吉')
  Geo-->>Adapter: 延吉市 / county_level_city / 延边朝鲜族自治州
  Adapter-->>Tool: city=延边州, region=延吉市, mappings
  Tool->>API: 首次查询（行政区 + 经纬度）
  API-->>Tool: 岗位结果
  Tool->>Adapter: 0 条兜底后校验结果仍属请求行政区
  Adapter-->>Tool: 串城过滤后的合法结果
```

经纬度兜底的约束（1–4 已上线，作为回归基线；5 是编排归属原则）：

1. 仅在首次严格查询为 0 时触发；
2. 兜底结果必须经过请求行政区校验；
3. 无法读取岗位 city/region 的结果不得静默放行；
4. 观测记录触发原因、原过滤条件、过滤前后数量；
5. 兜底属于 tool 编排，不进入 geo。

### 11.3 工作流 B-1：区级锚点下的距离表述（badcase 最大簇，可先行）

链路事实（证据链完整，44 条/2 天）：候选人只报区/市名（"海淀区/嘉定/市北"）→ geocode 正确返回 `areaLevelQuery=true`（锚点为行政区代表点）→ 岗位距离按区中心计算 → 模型照抄工具文本输出"3.2km"等精确数字 → 守卫 `district_level_distance_claim` 拦截 → 拦截后的降级话术引发二次投诉（badcase `1qe8rhks` / `jv7b34t4`，chat `6a4e13e0ce406a6aee6175ec` / `6a4e10ebce406a6aee0dfe4a`）。

修复设计——**杠杆放在工具输出文本**（门店名照抄类 badcase 证明模型会高保真照抄工具文本，把正确表述放进被照抄的文本里是最稳的一层）：

1. **锚点精度与坐标均确定性传递**：geocode 的 `areaLevelQuery` 经回合上下文（ToolBuildContext / `GeoQueryMeta.anchor`）传给岗位工具，**不依赖模型转抄参数**。坐标本身同样不可信任模型转抄：实证 chat `6a60528bce406a6aee8004f9`（2026-07-22）中，模型在"5km 复查"轮未调 geocode、自编了一组与真实锚点偏差约 3.7km 的坐标，导致该轮 5 公里圈画错位置（4.5km 的门店被算成 1.2km，本轮结论未出错纯属年龄过滤兜住）。修法：岗位工具边界校验模型传入坐标与会话内最近一次 geocode 结果的偏差，超过 1km 记 `GeoQueryMeta.anchor.source='model_supplied'` 观测（shadow 先行，是否强制回退 geocode 坐标待观测数据决策）；
2. **距离渲染带估算标记**：区级锚点下，岗位工具输出的距离一律渲染为"约 X.Xkm（按 XX 区估算）"，结果头部声明"本次定位为区级代表点，距离为估算值"；
3. **工具 description 补一条约束**（prompt 分层原则：工具强绑定约束放工具侧）：区级定位下回复须用估算表述，或先追问具体位置/商圈/定位；
4. **守卫规则保留为后盾，不下线**：上游修复生效后 `district_level_distance_claim` 拦截量应趋零——这本身就是验收指标（16.2 的对账口径）。

验收：test-suite 回放典型 chat（`6a4f71fbce406a6aee3f39c9` 海淀区、`6a4f5cbace406a6aeee9206a` 长宁区）；上线一周后拦截量环比显著下降。

### 11.4 工作流 B-2：geocode 已解析城市的消费收口（可先行）

现象（4 例）：本轮 geocode 已成功解析出城市甚至具体门店坐标（`hasResolvedCoordinate=true`），回复仍反问"你在哪个城市"或宣称"这边没找到"——badcase `k1kfdc22`（西岗区沃尔玛已解析到大连具体门店）、`xpkhj9w1`（"同济店"）、`ela0e6pt`（"凯德"）、人工提交 `ecehwb8m`（五角场太平洋森活）。与 07-20 invite 城市门 badcase 同族：geocode 结果不被当作城市依据。

修复设计（按兜底边界原则：工具结果知情披露优先，不做硬干预）：

1. geocode 工具结果文本把解析结论**前置明示**："已确认城市：大连市；已定位到 XX 门店（精确坐标）"，并在工具 description 声明"解析成功后禁止再向候选人反问城市，应直接据此查岗"；
2. geocode 解析出的城市进入 `resolveCityFromGeoSignals` 的输入源（evidence `geocode_resolved`，8.2），与会话事实冲突时走 ambiguous 出口由模型澄清，**不静默覆盖**；
3. 语义评审 `brand_or_geo_ambiguity_ignored` 保留为观测后盾。

验收：4 例源 chat 回放不再反问城市/不再误报"没找到"。

### 11.5 工作流 B-3：定位卡片选点回归（低优先，并入 Phase 0）

badcase `0m4zs1h6`（chat `6a4dcef8ce406a6aeec56fd8`，人工提交"定位一点不准"）：发给候选人的导航定位选点错误。处置：并入 Phase 0 的 ranker spec 补写——以该 chat 为回归用例排查 `geocoding-candidate-ranker` 选点逻辑；`GeoQueryMeta` 落库后此类问题可直接按 trace 排障，不再靠候选人投诉发现。

## 12. 依赖约束

分层规则（需同步修订 CLAUDE.md 的 resolution 条目）：

```text
允许：memory / agent / tools / guardrail / infra  →  resolution/geo
      （现行允许名单为 memory/agent/tools/guardrail，本方案补入 infra）
允许：tools → sponge

resolution/geo 零出向依赖：不 import memory/agent/tools/infra/sponge，
      也不 import resolution/brand（子域互不依赖；"resolution 至多依赖 sponge"
      是层级上限，geo 取零）

禁止：sponge → resolution（现行"禁止反向 import"保持不变；
      海绵行政区适配器因此落 tools 层，见 11.2）
```

**固化机制**：仓库现无 dependency-cruiser，不为此新增工具；用 ESLint `no-restricted-imports` 在 `.eslintrc.js` 固化两条（`resolution/brand` 同样受益，可与 brand 收口一并落地）：

1. `src/resolution/**` 内禁止 import `@memory/* @agent/* @tools/* @infra/* @biz/* @channels/*`（brand 子域按现行规则豁免 `@sponge/*`，geo 子域不豁免）；
2. `src/**`（门面自身除外）禁止 import `memory/facts/geo-mappings`——Phase 5 删除门面后此条随文件消失。

路径别名：复用现有 `@resolution/*`（tsconfig paths 与 jest `moduleNameMapper` 均已配置），无需新增。业务消费者从 `@resolution/geo` 导入；geo 内部使用相对路径，避免经由 barrel 自引发循环。

## 13. 实施计划

### 前置条件

- **brand 分支（`codex/brand-resolution`）先收口合入 develop**：两个改造在 `high-confidence-facts.ts`、`session.service.ts`、`duliday-job-list.tool.ts` 三处重叠，并行必然互相覆盖；
- 开工前工作树 clean，确认无其他会话的未提交改动（本仓库多会话并发是常态）。

### 工作流划分

- **工作流 A：领域迁移与收口**（Phase 0–5，本章主体）；
- **工作流 B：现网行为修复**（11.3–11.5）——**不依赖迁移进度，可先行或并行**：B-1、B-2 各自独立小 PR（badcase 量级决定其优先级高于工作流 A），B-3 并入 Phase 0。两个工作流共享 Phase 0 的基线测试与 16 节的观测落点。

### Phase 0：行为基线与证据固化

目标：移动代码前锁定线上行为。

- **补写** `geocoding-candidate-ranker` 单测（当前无 spec；`tests/infra/geocoding/` 仅有 classifier 与 service 两个 spec），并把工作流 B-3 的选点错误 chat（`6a4dcef8ce406a6aeec56fd8`）作为回归用例纳入；
- 扩充 geo-mappings 基线测试（现仅 91 行）：golden cases 至少覆盖 `浦东新区航头镇`、`漕宝路地铁站`、`万达广场`、`上海火车站`、`延吉市`、`余姚市`、`朝阳区`——**按现状行为断言**（含业务偏置与余姚现状），行为修正留给后续阶段显式提交；
- 固化 #499 已上线链路的回归测试：县级市转换、0 条恢复查询、串城 guard、`cityFilterRecovery` 观测字段；
- 记录关键测试数量与执行时间。

完成标准：不改代码位置时，所有基线测试稳定通过。

### Phase 1：建立 `resolution/geo`，行为等价迁移

目标：只改所有权和依赖，不改业务语义。

1. 创建 `src/resolution/geo`（复用 `@resolution/*`，不动 tsconfig/jest）；
2. 按 admin / normalization / matching / places / policy 拆分现有文件，内部相对路径；
3. 建 `index.ts` 稳定出口 + 过渡期数据表导出（8.1）；
4. 原测试迁至 `tests/resolution/geo`；
5. 旧路径保留**全量**兼容门面：

```ts
// src/memory/facts/geo-mappings.ts
/** @deprecated 请从 @resolution/geo 导入。 */
export * from '@resolution/geo';
```

   门面必须覆盖现存全部导入符号——包括五张数据表、`COUNTY_LEVEL_CITY_TO_PREFECTURE` 与 `WhitelistScanResult` 类型——以第 4 节依赖清单逐文件核对；
6. ESLint `no-restricted-imports` 规则同步落地（12 节），新代码禁止旧路径。

完成标准：新旧入口测试结果完全一致，生产行为无差异。

### Phase 2：迁移消费者与扫描编排

按低风险到高风险顺序，每个提交只迁移一个消费边界并跑定向测试：

1. infra/geocoding 的 classifier / ranker；
2. geocode、invite-to-group 工具；
3. agent 的 geocode anchor；
4. memory high-confidence extractor——同一步把三轮扫描编排抽为 `scanGeoSignalsFromText`（8.4），golden cases 锁行为；
5. session service 的事实兜底；
6. 测试与辅助脚本。

完成标准：`rg "facts/geo-mappings" src tests` 只剩门面自身。

### Phase 3：海绵行政区适配器抽取 + 业务足迹县级市补录

1. `normalizeSpongeCityFilters` 与 `filterJobsToRequestedAdministrativeArea` 抽至 `tools/duliday/job-list/sponge-area-filter.util.ts`；
2. 适配器改用 `resolveParentAdministrativeArea`，岗位工具不再 import 任何行政区映射常量；
3. **补录前先验证**：用真实海绵查询抽样确认县级市存储口径（余姚、慈溪、昆山至少各一例）——延边一例不足以外推；
4. 业务足迹内县级市补录进映射（如 `余姚市/慈溪市 → 宁波`，9.2），这是延吉类隐患在在营城市的直接闭环，**不等 Phase 4**；
5. 补测试：县级市、普通地级市、直辖市、未知城市、混合多城市、兜底防串城；
6. **地理信号冲突检测**（独立提交，显式行为变更，**shadow → enforce 两段发版**，见 17.4）：`resolveCityFromGeoSignals` 多信号指向不同城市时返回 `ambiguous` + `candidates`，不再先命中先赢（8.2，现网实证见 3）；先 shadow 观测冲突频率 1~2 周，enforce 后 memory 消费侧同步处理 ambiguous 分支（保守留空，交上游澄清）。

完成标准：岗位工具零行政区知识；余姚类查询有测试锁定；冲突信号用例（15.2）通过。

### Phase 4：全国行政区数据生成化（独立后续项，不阻塞收口）

Phase 0–3 + Phase 5 构成工作流 A 主线；Phase 4 单独立项排期。它的价值是把县级市修复从"逐城补录"升级为"全国覆盖"，启动前提：

1. 海绵县级市口径的全国一致性已有抽样结论（Phase 3 产出的外推评估）；
2. "业务偏置 vs 国家数据"冲突规则已定：朝阳 → 北京 这类条目在交叉校验中以 override 显式豁免（9.2/9.3）；
3. 数据源与版本策略确定（沿用现有 lcn 民政部数据来源并脚本化）；
4. generated / overrides 文件分离，校验脚本进 CI，验证生成产物无漂移；
5. 全国父子关系批量接入用短期开关 `GEO_NATIONAL_COUNTY_MAPPING_ENABLED` 灰度（17.2）。

### Phase 5：收口与删除兼容层

1. 观察至少一个发布周期；
2. `rg` 确认无旧路径引用后，删除 `src/memory/facts/geo-mappings.ts` 门面；
3. 编排迁移（Phase 2.4）与适配器换入口（Phase 3.2）完成后，删除 index 的过渡期数据表导出；
4. 更新 CLAUDE.md：架构树补 `resolution/geo`，resolution 允许依赖方名单补 infra；
5. 更新 memory 与 tools 相关架构文档。

## 14. 文件迁移映射

| 现有符号 | 目标位置 |
| --- | --- |
| `MUNICIPALITIES` | `resolution/geo/admin/administrative-division.data.ts` |
| `SUPPORTED_CITY_PREFIXES` | 同上（改名见 9.5） |
| `NATIONAL_CITY_SUFFIX_TO_CITY` | `resolution/geo/admin/explicit-city.data.ts` |
| `COUNTY_LEVEL_CITY_TO_PREFECTURE` | `resolution/geo/admin/administrative-division.data.ts`，对外以 `resolveParentAdministrativeArea` 暴露 |
| `DISTRICT_TO_CITY` | `resolution/geo/admin/administrative-division.data.ts` |
| `LOCATION_TO_CITY` | `resolution/geo/places/place-alias.data.ts` |
| `normalizeCityName` / `normalizeDistrictForLookup` | `resolution/geo/normalization/geo-name.normalizer.ts` |
| `resolveCityFromDistrict` / `resolveCityFromGeoSignals` | `resolution/geo/admin/administrative-area.resolver.ts` |
| `resolveCityFromLocation` | `resolution/geo/places/place-alias.resolver.ts` |
| `scanWhitelistKeysByLongest` / `matchInUncoveredSegments` | `resolution/geo/matching/whitelist-scanner.ts` |
| `WhitelistScanHit` / `WhitelistScanResult` | `resolution/geo/geo.types.ts`（经 index 透出） |
| 三轮扫描编排（`high-confidence-facts.ts` 私有段） | `resolution/geo/matching/geo-text-scan.ts`（新 API `scanGeoSignalsFromText`） |
| `GENERIC_AMBIGUOUS_SUFFIXES` / `hasGenericAmbiguousSuffix` | `resolution/geo/policy/ambiguous-place.policy.ts` |
| `normalizeSpongeCityFilters` / `filterJobsToRequestedAdministrativeArea` | `tools/duliday/job-list/sponge-area-filter.util.ts` |

## 15. 测试策略

### 15.1 单元测试目录

```text
tests/resolution/geo/
├── normalization/geo-name.normalizer.spec.ts
├── matching/whitelist-scanner.spec.ts
├── matching/geo-text-scan.spec.ts
├── admin/administrative-area.resolver.spec.ts
├── places/place-alias.resolver.spec.ts
└── policy/ambiguous-place.policy.spec.ts

tests/tools/duliday/job-list/
└── sponge-area-filter.util.spec.ts
```

### 15.2 必测用例矩阵

| 场景 | 输入 | 期望 |
| --- | --- | --- |
| 县级市显式名称（基线） | `延吉市` | 标准名 `延吉市`，父级 `延边朝鲜族自治州` |
| 结构化裸城市参数（基线） | `延吉` | 结构化字段内兼容为 `延吉市` |
| 自由文本裸名称（基线） | `延吉路附近` | 不因"延吉"自动认定为延吉市 |
| 最长优先（基线） | `浦东新区航头镇` | 先命中 `浦东新区`，不被 `浦东` 抢占 |
| 唯一区县 | `青浦区` | 解析为上海，证据 `unique_district_alias` |
| 业务偏置区名 | `朝阳区` | 解析为北京（刻意业务偏置；Phase 4 交叉校验以 override 豁免） |
| 真跨城歧义 | `鼓楼区` | 不在白名单（南京/福州/开封/徐州同名），city 不解析 |
| 冲突信号（行为变更，Phase 3） | districts=[`静安区`] + 会话城市 `成都` | 返回 `ambiguous` + candidates，不静默取先命中（现网 badcase `xnp1u820`） |
| 唯一地标 | `陆家嘴` | 解析为上海，证据 `hotspot_alias` |
| 通用商业体 | `万达广场` | 命中歧义策略 |
| 专名交通站 | `漕宝路地铁站` | 不因通用后缀被提前判歧义 |
| 海绵转换（基线） | `延吉` | city=延边州，region=延吉市 |
| 待补录县级市 | `余姚市` | 补录后 city=宁波、region=余姚市（前提：Phase 3 海绵口径验证通过） |
| 海绵普通城市 | `上海` | 保持城市过滤，不派生县级市 region |
| 未知城市 | `火星市` | 不猜父级，保留或返回未解析状态 |
| 兜底防串城（基线） | 请求延吉，返回其他城市岗位 | 过滤掉跨城结果 |

标注"基线"的行现状已满足（#499），验收口径是**不回归**。工作流 B 的验证不走单测矩阵，走 test-suite 对源 chat 的回放（见 11.3/11.4 验收）。

### 15.3 性质测试与数据测试

不变量：

- `normalizeCityName` 幂等；名称归一化不产生空白 key；
- 最长优先扫描结果不重叠；`covered.length === message.length`；
- 任何 resolved 行政区有且只有一个标准父级；
- 高置信 place alias 不得映射多个城市；
- 显式城市表 × 县级市映射交叉一致（9.4，余姚 case 的防线）；
- 适配器输出数组去重且不含空字符串。

### 15.4 回归测试范围

每阶段至少运行（Node 20+，`nvm use 22.16.0`）：

```bash
pnpm run test -- tests/resolution/geo --watchman=false
pnpm run test -- tests/tools/duliday/job-list/sponge-area-filter.util.spec.ts --watchman=false
pnpm run test -- tests/memory/high-confidence-facts.spec.ts --watchman=false
pnpm run test -- tests/tools/tool/duliday-job-list.tool.spec.ts --watchman=false
pnpm run test -- tests/tools/tool/geocode.tool.spec.ts --watchman=false
pnpm run typecheck
pnpm run lint:check
```

## 16. 可观测性

复用现有观测栈（结构化数据落库 + 飞书告警），**不引入 Prometheus 类指标系统**（仓库无此设施）。只打日志不算观测——关键判定必须落库可查或触发告警。

### 16.1 查询链路结构化观测

现状：#499 已随工具结果记录 `cityFilterRecovery`（attempted / applied / requestedCities / candidateCount / recoveredCount）。本方案将其扩展为统一的 `GeoQueryMeta`，随工具 queryMeta 进入回合观测：

```ts
interface GeoQueryMeta {
  requestedLocations: string[];
  normalizedLocations: string[];
  administrativeMappings: Array<{
    input: string;
    canonical: string;
    parentCity: string | null;
    evidence: string | null;
  }>;
  /**
   * 距离锚点精度：区级定位被包装成精确距离是当前最大地理类拦截源
   * （district_level_distance_claim，44 条/2 天，见 3），观测必须能按
   * 锚点精度切分距离类问题。也是工作流 B-1 的精度传递通道（11.3）。
   */
  anchor: {
    source: 'geocode' | 'session_fact' | 'user_location_share' | 'model_supplied' | null;
    // model_supplied = 模型传入坐标与会话内 geocode 结果偏差超阈值（实证见 11.3 修复点 1）
    precision: 'poi' | 'area_level' | null; // area_level = 行政区代表点
    areaLevelQuery: boolean;
  };
  providerFilters: { cityNameList: string[]; regionNameList: string[] };
  fallbackTriggered: boolean;
  fallbackReason: string | null;
  resultCountBeforeAreaGuard: number;
  resultCountAfterAreaGuard: number;
}
```

落点：

- 随工具执行结果落 `message_processing_records`（`agent_invocation`），与 `agent_execution_events` 同 trace_id 可 join；
- fallback 触发、area guard 拒绝等关键事件经 AgentTracer 记 `agent_execution_events`；
- 日志仅辅助定位，禁止包含用户完整原消息、手机号或精确住址。

### 16.2 落库后可回答的问题

- 解析状态与证据分布（resolved / ambiguous / unresolved × evidence）；
- 县级市映射的应用次数与具体去向（input → canonical → parentCity）；
- fallback 触发率与原因分布；
- area guard 过滤前后数量差；
- 0 结果查询中，行政区映射是否生效；
- 区级锚点（`anchor.precision=area_level`）查询占比，与 `district_level_distance_claim` 拦截量的对账（工作流 B-1 验收口径）；
- 信号冲突（ambiguous + candidates）出现频次与后续澄清率。

### 16.3 告警（飞书，接现有 notification 渠道）

- 某个新行政区映射上线后 0 结果率显著上升；
- fallback 触发率突增；
- area guard 大量过滤岗位（供应商口径漂移信号）；
- ambiguous 比例突降（规则过度推断信号，而非能力提升）。

## 17. 发布、灰度与回滚

### 17.1 发布顺序

工作流 B（B-1、B-2）可先行独立发布。工作流 A：

1. 行为等价的目录迁移（Phase 1）；
2. 消费者与编排迁移（Phase 2）；
3. 适配器抽取 + 业务足迹补录（Phase 3，补录以数据提交与代码提交分离）；
4. （独立项）全国数据生成化（Phase 4）。

每一步独立提交、独立发布，便于定位回归。

### 17.2 灰度开关

- 已上线的县级市转换链路（#499）不加事后开关；
- 业务足迹补录是小步数据变更，海绵口径验证通过后直接上线；
- 仅 Phase 4 全国批量接入使用短期开关 `GEO_NATIONAL_COUNTY_MAPPING_ENABLED`；
- 纯代码目录迁移与工作流 B 的工具输出改动不需要开关。

### 17.3 回滚策略

- 旧路径兼容门面保留至少一个发布周期；
- 补录数据错误按条回退（数据与代码分提交）；
- 全国接入异常时关闭开关，回退到补录白名单行为；
- 不回滚 geo 目录所有权，避免把架构迁移和业务策略回滚绑在一起。

### 17.4 发版后处置与 shadow 判定

**shadow 判定原则**：shadow 双跑给"行为会变、且变化面事先未知"的改动用（品牌解析改造属此类，故全程 shadow_diff）。工作流 A 的迁移是行为等价搬迁，没有"新旧两套判定"可比，等价性由 Phase 0 基线在合入前验掉，**不做 shadow**。全案只有两处需要 shadow 式两段发版：

| 改动 | 处置 | 原因 |
| --- | --- | --- |
| 冲突检测（Phase 3 第 6 步） | 先 shadow 1~2 周再 enforce：新逻辑并行计算，仅把"本应 ambiguous 但现行取了先命中"的案例落 `GeoQueryMeta`，不改返回值；确认冲突频率与样本质量后切换 | 现网实证仅 2 例，真实频率未知；纯函数双跑成本趋零 |
| 全国映射（Phase 4） | 开关关闭状态下 shadow 计算全国映射与补录白名单的 diff 并落观测，确认无害再开 `GEO_NATIONAL_COUNTY_MAPPING_ENABLED` | 海绵口径全国一致性只有抽样结论 |
| B-1 / B-2、县级市补录、迁移本身 | **不新建 shadow**：`district_level_distance_claim` 硬规则与语义评审 shadow 本就在生产运行，即现成观测层；补录靠逐条映射观测 + 0 结果率告警 + area guard + 按条回滚 | 观测网已存在，重复建设无增益 |

**发版后验证清单**（教训来源：`guardrail_review_records` 曾"部署成功但生产 0 行"——每次发版必须用真实流量验证落库，不能只看部署成功）：

- **PR B-1/B-2 上线**：当天抽 1~2 条真实 trace 确认工具输出带估算标记 / 前置城市披露；一周后对账 `district_level_distance_claim` 拦截量环比（16.2）；两周后重跑 badcase 地理专项复核（语义评审持续自动进样本池），确认三个问题簇收敛——此为工作流 B 的最终闭环；
- **PR 2/3（迁移）上线**：当天抽真实 trace 确认 `GeoQueryMeta` 出现在 `message_processing_records`；跑一条延吉真实查询确认转换链路无回归；观察一个发布周期且 `rg` 无旧路径引用后，才进 Phase 5 删门面；
- **PR 4（补录 + 冲突检测）上线**：每条新映射当天用真实海绵查询逐条验证；冲突检测按 shadow → enforce 两段独立发版。

## 18. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 大文件拆分造成循环依赖 | 编译失败或运行时 undefined | geo 内部相对路径；index 仅供外部消费 |
| 门面遗漏现存导入符号 | Phase 1 编译失败 | 门面全量 re-export（含数据表），按第 4 节清单逐文件核对 |
| 编排抽取改变匹配行为 | 地点识别回归 | Phase 0 golden cases 按现状断言；抽取是平移不是重写 |
| 与 brand 分支并行冲突 | 互相覆盖工作区 | 硬前置：brand 收口合入后开工；小步提交用 pathspec 限定 |
| 海绵县级市口径不一致 | 补录后仍 0 结果或串城 | 补录前逐城抽样验证；差异走适配 util 本地 override；area guard 兜底 |
| 全国裸名称误命中 | 道路/门店被当成城市 | 仅结构化字段兼容裸名称，自由文本要求显式后缀 |
| 业务偏置被国家数据"纠正" | 朝阳→北京 等行为漂移 | 偏置条目进 overrides 显式豁免（Phase 4 前提） |
| 公开导出过多底层常量 | 消费者再度耦合数据结构 | 过渡期导出集中标注 `@deprecated`，Phase 5 收口删除 |
| B-1 估算标记改动引发新话术问题 | 候选人体验波动 | 源 chat 回放验证；守卫规则保留为后盾；拦截量对账监控 |

## 19. 验收标准

### 19.1 架构验收

- [ ] 存在 `src/resolution/geo`，零出向依赖（不 import memory/agent/tools/infra/sponge/brand）；
- [ ] 所有业务消费者从 `@resolution/geo` 导入，不再穿透 memory；
- [ ] 三轮扫描编排唯一居所在 `resolution/geo/matching`；
- [ ] 高德集成仍位于 `src/infra/geocoding`；
- [ ] 海绵行政区适配位于 tools 层，岗位工具零行政区知识；
- [ ] ESLint `no-restricted-imports` 依赖规则生效；
- [ ] CLAUDE.md 架构树与 resolution 分层规则已更新（允许名单补 infra）；
- [ ] 旧 memory 路径门面最终删除，index 过渡期数据表导出收口。

### 19.2 行为验收

回归基线（现状已满足，验收口径 = 不回归）：

- [ ] `延吉` / `延吉市` 在结构化城市参数中均转换为"延边州 + 延吉市"；
- [ ] 严格查询 0 条时受控兜底，兜底结果无法跨行政区泄漏；
- [ ] `浦东新区航头镇`、`漕宝路地铁站`、`万达广场` 等历史 badcase 不回归；
- [ ] memory 事实提取和 geocode 三态行为保持一致。

工作流 A 新增行为：

- [ ] `延吉路` 等自由文本不被误判为延吉市（golden case 显式锁定）；
- [ ] 海绵口径验证通过后，`余姚市` / `慈溪市` 等业务足迹县级市正确转换（9.2）；
- [ ] 编排迁移后 `scanGeoSignalsFromText` golden cases 全绿；
- [ ] 冲突信号返回 ambiguous + candidates（Phase 3 第 6 步）。

工作流 B：

- [ ] 区级锚点下岗位工具输出的距离带估算标记，`district_level_distance_claim` 拦截量上线一周后环比显著下降（预期趋零，11.3）；
- [ ] B-2 四例源 chat 回放不再反问城市/误报"没找到"（11.4）；
- [ ] B-3 选点错误 chat 进入 ranker 回归用例（11.5，随 Phase 0）。

### 19.3 工程验收

- [ ] geo、适配 util、memory、tools 定向测试通过（15.4 全量命令）；
- [ ] typecheck 和 lint 通过；
- [ ] `rg "facts/geo-mappings"` 无旧路径消费者；
- [ ] `GeoQueryMeta` 落库可查，告警关注点接入飞书（16）；
- [ ] （Phase 4 启动时）数据校验脚本通过、生成产物无漂移。

## 20. 建议实施拆单

工作流 B（可先行，与下列 PR 并行）：

- **PR B-1：区级锚点距离表述修复**（11.3）——锚点精度确定性传递 + 距离渲染估算标记 + 工具 description 约束；badcase chat 回放验证。
- **PR B-2：geocode 城市消费收口**（11.4）——工具结果前置披露 + description 约束；4 例源 chat 回放验证。

工作流 A（领域迁移）：

1. **PR 1：行为基线补齐**
   ranker spec 补写（含 B-3 回归用例）、geo-mappings golden cases、#499 链路回归测试。纯测试，无生产变更。

2. **PR 2：`resolution/geo` 迁移 + 全量门面**
   目录拆分、index 稳定出口 + 过渡期导出、旧路径 re-export、ESLint 依赖规则。

3. **PR 3：消费者迁移 + 编排入 geo**
   infra / tools / agent / memory 全部切换 `@resolution/geo`；三轮扫描编排抽为 `scanGeoSignalsFromText`。

4. **PR 4：海绵适配器抽取 + 业务足迹补录 + 冲突检测**
   `sponge-area-filter.util.ts` 抽取、换 resolver 入口、海绵口径抽样验证、余姚类补录与测试、信号冲突检测（独立提交）。

5. **PR 5（独立后续项）：全国行政区数据生成化**
   generated / overrides 分离、生成与校验脚本、CI 漂移检查、灰度开关。

6. **PR 6：收口**
   删除门面与过渡期导出、更新 CLAUDE.md 与相关架构文档。

## 21. 最终决策摘要

| 决策项 | 结论 | 依据 |
| --- | --- | --- |
| Geo 是否继续放在 memory | 否 | 跨层依赖清单（4） |
| Geo 是否放在 utils | 否 | 领域决策需要所有权（6.3） |
| Geo 是否另立顶层 `src/geo` | 否 | 与 `resolution/brand` 同构，同一概念不设双居所（6.3） |
| 最终位置 | `src/resolution/geo` | 复用现有 alias 与分层规则；规则允许名单补 infra（12） |
| 是否包含高德 API | 否，保留在 `infra/geocoding` | 供应商集成非领域本身（11.1） |
| 海绵转换逻辑位置 | `tools/duliday/job-list/sponge-area-filter.util.ts` | sponge 禁止 import resolution（12） |
| 白名单扫描 | 保留；原语与三轮编排一并迁入 `geo/matching`，编排收口为 `scanGeoSignalsFromText` | 编排是领域决策（8.4、10） |
| 地标与歧义策略 | 保留，数据与策略拆分 | 9.1 |
| "延吉市"修复落点 | 已随 #499 上线；本方案收口居所并泛化 | 2.1 |
| 余姚类同类隐患 | Phase 3 先验证海绵口径，再补录业务足迹县级市，不等全国数据 | 9.2；badcase 零反馈佐证低频（3） |
| 地理信号冲突 | `resolveCityFromGeoSignals` 冲突时返回 ambiguous + candidates，Phase 3 显式行为变更 | 现网实证（3） |
| 锚点精度观测 | `GeoQueryMeta.anchor` 标记 poi / area_level | 44 条/2 天最大拦截源（3） |
| 现网最大痛点归属 | 区级距离表述 / geocode 城市消费 / 定位选点并入工作流 B，优先级高于迁移 | badcase 量级（3） |
| 行政区数据维护 | 近期：人工白名单 + 小步补录；远期（独立项）：generated + overrides + CI 校验 | 9.3、Phase 4 |
| 观测落点 | `GeoQueryMeta` 随 queryMeta 落库 + 飞书告警；不引入新指标系统 | 仓库观测栈现状（16） |
| 迁移方式 | 全量兼容门面 + 小步迁移 + 一个发布周期后清理 | 13 |
| 开工前置 | brand 分支收口合入 develop | 工作区重叠（13 前置条件） |

本方案的核心是把"地理领域知识与算法"（`resolution/geo`）、"供应商口径转换"（tools 适配 util、infra/geocoding）和"业务流程编排"（岗位工具、memory 事实写入）分成三个稳定边界，同时用工作流 B 直接消化现网反馈量最大的三类地理问题。完成后，memory 只消费地理解析结果，geo 与 brand 在同一个解析层内以同一套契约演进，后续补录县级市或接入全国行政区数据时，不再需要修改任何业务模块。

## 22. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1 | 2026-07-15 | 初稿：提出迁出 memory，落位顶层 `src/geo`，海绵适配器落 `src/sponge/geo` |
| v2 | 2026-07-21 | 评审修订：落位改 `src/resolution/geo`（与 brand 同居所）；适配器改落 tools 层；三轮扫描编排归属收口为公共 API；观测改用现有落库+告警栈；校正"延吉修复已上线"的叙事；Phase 4 降级为独立后续项；补 ESLint 依赖固化机制与 brand 分支前置条件 |
| v2.1 | 2026-07-21 | 按 07-07~21 反馈池 136 条地理类 badcase 复核：新增地理信号冲突检测（Phase 3）与 `GeoQueryMeta` 锚点精度字段；县级市类零反馈佐证 Phase 4 降级 |
| v2.2 | 2026-07-21 | 三类现网痛点（区级距离表述 / geocode 城市消费 / 定位选点）从范围外并入为工作流 B，优先级高于迁移 |
| v3 | 2026-07-21 | 定稿整理：去除过程性表述，统一章节编号与交叉引用，决策摘要补依据列，过程历史收敛至本表 |
| v3.1 | 2026-07-21 | 新增 17.4 发版后处置与 shadow 判定：仅冲突检测与全国映射两处 shadow 两段发版，其余复用现有观测网；补发版后真实流量验证清单 |
| v3.2 | 2026-07-22 | 按 chat 6a60528bce406a6aee8004f9 实证扩展 B-1：模型自编坐标（偏差 3.7km）纳入修复范围——工具边界坐标偏差校验 + `anchor.source` 增加 `model_supplied` 档 |
| v3.3 | 2026-07-22 | 用户裁定：`resolution/geo` 目录改文件平铺（与 `resolution/brand` 一致），§7 树同步；职责分域仅作为命名/边界概念保留 |
