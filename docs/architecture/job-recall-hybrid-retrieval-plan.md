# 岗位召回混合检索方案（本地索引 + 向量/词法检索）

> 状态：技术方案（2026-07-07，待评审）
> 设计原则依据：[rules-vs-semantics-design-philosophy.md](./rules-vs-semantics-design-philosophy.md)
> ——检索技术的合法位置是**召回与路由**，不是裁决；本方案严守"索引只负责找到岗位，
> 事实永远来自实时 API"这条红线。

---

## 0. 一句话概括

在 Supabase 建一张岗位搜索索引表（pgvector 语义检索 + 分词词法检索 + 地理近邻），
由定时任务从海绵 API 同步语料；`duliday_job_list` 工具在**结构化召回不足时**用它扩面，
命中的 jobId 再经海绵 API `jobIdList` 精确回查拿实时数据——
**索引负责"找得到"，API 负责"说得对"**，jobId 溯源闸门与守卫接地语义完全不变。

---

## 1. 背景：现有召回链路与四个已知缺口

### 1.1 现状

岗位数据无本地存储，每次查询实时调海绵网关（`src/sponge/sponge.service.ts` 的
`fetchJobs`，`POST {SPONGE_API_BASE_URL}/ai/api/job/list`）。查询参数：
`cityNameList` / `regionNameList` / `brandAliasList` / `storeNameList` /
`searchJobName` / `jobCategoryList` / `jobIdList` / `location{longitude,latitude,range}`
/ `onlySignableJobs`，分页返回 `jobs + total`。

召回智能全部在查询参数构造层（`src/tools/duliday/job-list/search.util.ts` 等）：

- 品牌：`brandAliasList` 精确/子串匹配，0 命中时拼音模糊回指
  （`brand-fuzzy-match.util.ts`，拼音重叠 ≥0.5）；
- 品类词（"咖啡"）：人工维护的品类→品牌清单展开（目前仅咖啡品类启用）；
- 工种：`scoreJobAgainstRequestedCategories` 做完全相等 +10 / 包含 +6 / 字符重叠 +2
  的软评分，**无同义词能力**；
- 门店：`storeNameList` 是 API 侧精确匹配；
- 距离：geocode 得坐标 → 带 `location` 扫最多 10 页 × 20 = 200 条，页序非服务端
  距离排序。

### 1.2 四个已知缺口（本方案的靶子）

| # | 缺口 | 证据 | 后果 |
|---|------|------|------|
| G1 | **语义/同义鸿沟**："想找做咖啡的""有没有骑手的活""洗碗的工作" 无法映射到品牌/工种，除非人工品类表恰好覆盖 | 品类表仅咖啡启用；工种评分无同义词库（"骑手"vs"配送员"不命中） | 有岗说没岗，候选人流失 |
| G2 | **门店名对不上**：企微备注/候选人口述的门店名与后台门店名不一致时，`storeNameList` 精确匹配 0 结果 | 团队已有裁定"备注门店名易对不上需慎用" | 兜底靠本地子串，覆盖有限 |
| G3 | **密集城市距离截断**：单城市在招 >200 条时，10 页扫描可能漏掉真正最近的门店 | 已知 backlog（距离召回 200 上限） | "附近没有岗位"的假阴性 |
| G4 | **品牌口误超出拼音容错**：错字、简称、旧名超出拼音重叠 0.5 的能力半径 | 拼音模糊只覆盖同音/近音 | 误判"该品牌没岗" |

四个缺口的共性：**都是召回问题（找不到），不是事实问题（说错了）**——
恰好落在检索技术的能力区间内。

---

## 2. 设计红线（先于一切实现细节）

1. **索引只做召回，不做事实源**。任何展示给候选人的岗位事实（薪资/班次/距离/要求）
   必须来自本轮海绵 API 的实时返回。索引命中的 jobId 一律经 `jobIdList` 参数回查
   API 后才进入渲染管线。理由：索引必有同步延迟（岗位下架/改薪资），直接渲染索引
   字段会制造新的幻觉面；回查时 `onlySignableJobs` 默认过滤自然剔除已下架岗位。
2. **jobId 溯源闸门不变**。booking/precheck 的 `isRecalledJobId` 依赖"本会话
   `duliday_job_list` 真实召回集"；本方案的扩面结果同样经该工具的 API 回查产出，
   召回集语义自动成立，闸门零改动。
3. **守卫接地语义不变**。出站守卫的 `ungrounded_job_recommendation` 与值对账规则
   以"本轮 `duliday_job_list` 可用结果"为 ground truth；扩面结果就是该工具的正常
   返回，规则无感知。
4. **索引不可用即静默回退**。索引查询失败、或 `synced_at` 过期超阈值（默认 24h），
   完全回退现有召回路径，行为与今天一致。检索层永远不能成为岗位查询的单点。

---

## 3. 总体架构

```
                    ┌─────────────────────────────────────────┐
                    │  同步管线（Bull cron）                    │
                    │  海绵 fetchJobs 分页枚举 → 规整 → 分词    │
                    │  → doc_hash 比对 → 变更才重新 embedding  │
                    └──────────────┬──────────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────────┐
                    │  Supabase: job_search_index              │
                    │  结构化列 + tsv(词法) + embedding(向量)   │
                    │  + 门店坐标(地理)                         │
                    └──────────────┬──────────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────────┐
                    │  JobRetrievalService（混合检索）          │
                    │  向量 KNN ⊕ 词法 ts_rank ⊕ 地理近邻       │
                    │  → RRF 融合 → top-N jobId/brand           │
                    └──────────────┬──────────────────────────┘
                                   ▼
   duliday_job_list 工具：Stage1 结构化查询（现状不变）
      └─ 0 结果/低置信时 → Stage2 检索扩面 → jobIdList 回查 API → 合并渲染
```

---

## 4. 数据同步管线

### 4.1 语料枚举

新增 `src/biz/job-index/` 模块（业务数据依赖，放 biz 层）：

- **全量同步**（每日一次，低峰时段）：按城市枚举——城市清单来源于
  `fetchBrandList()` + 现有配置的服务城市集（实现时确认：`fetchJobs` 不传
  `cityNameList` 是否允许全量拉取；允许则直接全量分页，`total` 字段可预估页数）；
- **增量同步**（每小时）：同样分页拉取，仅 `doc_hash`（见 4.3）变化的行 upsert；
- **下架标记**：本轮全量未出现的 job_id 置 `is_active=false`（不物理删除，保留
  评估用）；
- 使用 Bull cron（参考现有 `biz/monitoring` 清理任务的模式），带分布式锁防多实例
  重复同步。

**实施前 discovery 项**（写在 PR-A 任务里）：
① 全量岗位量级（决定 embedding 成本与索引参数）；
② 网关分页拉取的限速要求；
③ API 返回中门店坐标字段是否存在（`basicInfo.storeInfo` 内）——
   若无坐标，同步管线需对门店地址做一次性 geocode（结果按地址 hash 缓存，
   增量只补新门店），复用现有 geocode 基础设施。

### 4.2 表结构

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS earthdistance CASCADE;  -- 依赖 cube

CREATE TABLE IF NOT EXISTS job_search_index (
  job_id BIGINT PRIMARY KEY,
  brand_id BIGINT,
  brand_name TEXT NOT NULL,
  brand_aliases TEXT[],              -- 同步自 brand/list 的别称
  store_name TEXT,
  city_name TEXT,
  region_name TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  job_category TEXT,
  job_name TEXT,
  labor_form TEXT,
  salary_summary TEXT,               -- 仅供调试/评估，绝不直接渲染给候选人
  doc_text TEXT NOT NULL,            -- 检索文档原文（见 4.3）
  doc_tokens TEXT NOT NULL,          -- Intl.Segmenter 分词后空格拼接
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', doc_tokens)) STORED,
  embedding vector(1024),            -- 维度按选定模型调整
  doc_hash TEXT NOT NULL,            -- doc_text 的 sha256，变更检测
  is_active BOOLEAN NOT NULL DEFAULT true,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jsi_tsv ON job_search_index USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_jsi_trgm ON job_search_index USING gin (doc_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jsi_embedding ON job_search_index
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_jsi_geo ON job_search_index
  USING gist (ll_to_earth(lat, lng)) WHERE lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jsi_city ON job_search_index (city_name) WHERE is_active;
```

### 4.3 检索文档构造（doc_text）

每个岗位拼一段检索文档，覆盖候选人可能的所有表达角度：

```
{brandName} {brandAliases 逐个} {jobCategoryName} {jobName} {jobNickName}
{storeName} {storeAddress 的商圈/路段片段} {laborForm}
{jobContent 职责原文，截断 300 字}
```

- **分词**：Node 20 内置 `Intl.Segmenter('zh-CN', { granularity: 'word' })`
  切词后空格拼接存 `doc_tokens`——零 native 依赖拿到中文词法检索能力
  （Supabase 托管版没有 zhparser/jieba，`to_tsvector('simple')` 吃预分词文本即可，
  `ts_rank` 即得 BM25 同族的词频排序）；
- **embedding**：只在 `doc_hash` 变化时调用（岗位文案基本静态，日常增量成本≈0）。

### 4.4 Embedding 角色接入

Provider 层（`src/providers/`）新增 `ModelRole.Embedding`：

- env：`AGENT_EMBEDDING_MODEL`（如 `openai/text-embedding-3-small` 或国产等价物，
  经现有 registry → reliable → router 三层）；
- Vercel AI SDK 的 `embed()` / `embedMany()`（批量同步用后者）；
- 未配置该角色时：同步管线跳过 embedding 列（词法+地理照常工作），检索服务自动
  退化为词法+地理双路——**向量是增强不是依赖**。

---

## 5. 混合检索服务

新增 `src/biz/job-index/job-retrieval.service.ts`：

### 5.1 接口

```typescript
interface JobRetrievalQuery {
  /** 候选人的自由文本意图，如"想找做咖啡的""洗碗的活" */
  freeText?: string;
  /** 结构化过滤（与索引列对齐） */
  cityName?: string;
  laborForms?: string[];
  /** 地理近邻模式 */
  geo?: { lat: number; lng: number; radiusMeters: number };
  topN?: number; // 默认 20
}

interface JobRetrievalHit {
  jobId: number;
  brandName: string;
  storeName: string | null;
  score: number;          // RRF 融合分
  matchedBy: Array<'vector' | 'lexical' | 'geo'>;
  distanceMeters?: number;
}
```

### 5.2 检索逻辑（单条 SQL RPC，一次往返）

新增 Postgres 函数 `search_jobs_hybrid(query_tokens TEXT, query_embedding vector,
city TEXT, labor_forms TEXT[], geo_lat/geo_lng/geo_radius, top_n INT)`：

1. **向量路**：`embedding <=> query_embedding` cosine top-K（K=50），
   `query_embedding` 为空时跳过；
2. **词法路**：`ts_rank(tsv, plainto_tsquery('simple', query_tokens))` top-K，
   0 命中时 `similarity(doc_text, 原文) > 0.15` 的 pg_trgm 兜底（接住 G2 门店名、
   G4 错字）；
3. **地理路**（仅 geo 模式）：`earth_distance(ll_to_earth(lat,lng), ll_to_earth($lat,$lng))
   < radius` 按距离升序 top-K——**数据库级 KNN，天然解决 G3 的 200 条截断**；
4. **融合**：RRF（`score = Σ 1/(60 + rank_i)`），全路命中加权靠前；
   `is_active AND city 匹配 AND labor_form 匹配` 作为硬过滤先行。

查询侧 embedding：每次检索对 `freeText` 调一次 `embed()`（~50ms，可接受；
freeText 为空的纯地理模式不调用）。

---

## 6. 工具集成（duliday_job_list 流程扩展）

全部改动收敛在 `src/tools/duliday-job-list.tool.ts` + `job-list/search.util.ts`，
由 `agent_reply_config.jobIndexRecallEnabled`（默认 false）门控。

### 6.1 Stage2 扩面（解 G1/G2/G4）

现有结构化查询（Stage1）返回 **0 结果**、或品牌/工种入参存在但全部落空时：

```
候选人意图文本（工具入参新增 searchIntentText，prompt 引导模型透传候选人原话）
  → JobRetrievalService.freeText 检索（带 city/laborForm 硬过滤）
  → top-N jobIds
  → fetchJobs({ jobIdList, cityNameList, onlySignableJobs 默认 })  ← 实时回查
  → 结果走现有渲染/排序/守卫管线，与 Stage1 结果同构
```

- 工具返回中标注 `recallStage: 'expanded'`，渲染层可提示模型
  "以下是按你的描述扩大范围找到的岗位"；
- 回查 0 结果（索引过期岗位已下架）→ 维持现状的 no-match 话术路径；
- 现有拼音品牌模糊回指保留（它做"反问确认"，检索做"直接扩面"，互补不冲突）。

### 6.2 地理近邻模式（解 G3）

geocode 成功拿到唯一坐标、且候选人按距离找岗时：

```
JobRetrievalService.geo 检索（radius 默认 10km，top 30 家最近门店的 jobIds）
  → fetchJobs({ jobIdList }) 回查
  → 与现有 location 扫页结果做并集去重
```

灰度期与现有 10 页扫描**并行跑、结果并集**，观测两路差异（索引路找到而扫页路
漏掉的近岗数量 = G3 缺口的直接度量）；数据稳定后可让索引路成为距离召回主路。

### 6.3 品类词扩展的渐进替代

现有人工品类表（咖啡→品牌清单）保留为快路径；检索扩面天然覆盖未建表的品类
（"奶茶""快餐"）。观测半月后决定是否用检索全面替代人工表维护。

---

## 7. 评估与灰度

### 7.1 离线评测集（先于上线）

- 从生产会话构建 50~100 条评测样本：候选人原话（"想找做咖啡的"“附近有洗碗的吗”）
  → 人工标注期望命中的品牌/岗位集合。样本来源：历史 0 结果会话、品牌纠错会话、
  badcase 池中"有岗说没岗"类反馈；
- 指标：recall@10（期望岗位进前 10 的比例）、无关命中率（top-10 中人工判无关的
  占比）；
- 评测脚本放 `scripts/`（只读索引，不碰生产会话链路）。

### 7.2 线上灰度

- flag 开启后观测三个数：**0 结果率**（Stage1 落空次数/天，应下降）、
  **扩面采用率**（Stage2 触发且回查有结果的比例）、**扩面岗位的转化**
  （扩面结果被候选人跟进/进入 precheck 的比例，从 `ops_events` 口径看）；
- 索引健康：`synced_at` 最大延迟、同步失败率进现有告警体系
  （飞书 ops 告警，遵循"观测必须落库或告警"的团队纪律）。

---

## 8. 成本与规模预估

| 项 | 估算 |
|---|---|
| 语料规模 | 在招岗位预计 10³~10⁴ 量级（discovery ①确认）——对 pgvector 是玩具规模，HNSW 查询 <10ms |
| 全量 embedding | 一次性 10⁴ × ~300 tokens，主流 embedding 定价下 < ¥5 |
| 日常增量 | 只嵌变更文档，≈0 |
| 查询时延 | +1 次 embed（~50ms）+1 次 RPC（~20ms），仅在 Stage2/地理模式触发，Stage1 命中时零开销 |
| 新依赖 | 无 native 依赖（分词用 Node 内置 Intl.Segmenter）；Supabase 扩展 vector/pg_trgm/earthdistance 均为托管版内置 |

---

## 9. PR 拆分

| PR | 内容 | 依赖 |
|----|------|------|
| PR-A | 同步管线 + `job_search_index` 迁移 + embedding 角色接入（含 discovery ①②③ 的确认结论写回本文档） | 无 |
| PR-B | `search_jobs_hybrid` RPC + JobRetrievalService + 单测 | PR-A |
| PR-C | 工具集成（Stage2 扩面 + 地理并行）+ flag + 集成测试 | PR-B |
| PR-D | 离线评测集 + 评测脚本 + 灰度观测口径 | PR-B（可与 PR-C 并行） |

执行须知同 [guardrail-and-memory-redesign-plan.md](./guardrail-and-memory-redesign-plan.md) §8
（分支/测试/迁移/规范），此处不重复。

---

## 10. 风险表

| 风险 | 缓解 |
|------|------|
| 索引过期推荐已下架岗位 | 红线 1：一律 `jobIdList` 实时回查 + `onlySignableJobs` 过滤，索引字段永不直接渲染 |
| 向量检索召回无关岗位（"洗碗"召回"洗车"） | RRF 中词法路权重制衡 + 硬过滤（city/laborForm）+ 离线评测的无关命中率门槛（<10% 才开 flag） |
| 同步管线拉挂海绵网关 | 分页限速 + 低峰全量 + 增量为主；discovery ② 确认限速要求 |
| embedding 服务不可用 | 检索服务自动退化词法+地理双路；同步管线跳过嵌入列，下轮补 |
| 索引成为查询链路单点 | 红线 4：检索失败/过期即静默回退现有路径，Stage1 永远先行 |
| 门店坐标缺失导致地理路空转 | discovery ③；缺坐标时地理路仅对有坐标门店生效，其余走现有扫页 |
