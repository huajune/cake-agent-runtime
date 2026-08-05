# 图片信息结构化 · 代码改造技术方案

> 配套文档：[产品方案](../product/visual-fact-structuring-plan-2026-08-05.md)（目标/分期/验收）·[链路盘点](./visual-fact-pipeline-inventory-2026-08-05.md)（现状证据）
> 本文是工程视角：改哪些文件、动哪些函数、按什么顺序发版。
> 基准 `origin/develop @ 5a6ce7c3`，所有行号与函数签名均实际核对过。

---

## 1. 端到端链路：现状 → 目标

### 现状

```
候选人发图
  │
  ├─ P1 渠道预描述（异步 fire-and-forget）
  │    ImageDescriptionService.describeAndUpdate
  │      → llm.generate(role=Vision, messages 含 image)     ← 自由文本
  │      → formatDescription() 拼 "[图片消息] <描述>"
  │      → writeBackDescription → chatSession.updateMessageContent
  │           → chat_messages.content 整条替换 + del Redis 窗口缓存
  │
  └─ P2 Agent 工具（主模型看图后主动调）
       save_image_description.execute({messageId, description})   ← 自由文本
         → 同上 updateMessageContent
         → 品牌旁路：brandResolution.resolve(description,'image_description')
              → context.onImageBrandResolved(resolutions,{messageId})

之后：7 个消费点把 content 当候选人原话读（盘点 §2），无 kind / 无归属 / 无可信度
```

### 目标

```
候选人发图
  │
  ├─ P1: llm.generateStructured(VisualFactSheetSchema)  ─┐
  └─ P2: inputSchema 扩 kind/fields，工具内 finalize     ─┤
                                                          ▼
                                    VisualFactSheet { kind, fields[], rawDescription }
                                                          │
              ┌───────────────────────────────────────────┼──────────────────────────┐
              ▼ 文本轨（不变）                             ▼ 结构化旁路（新）          ▼ 回合旁路（镜像品牌域）
    content = "[图片消息] <raw>"              chat_messages.visual_facts jsonb   onVisualFactsResolved
    （Phase 3 起前缀带 kind 标注）             （与描述同一次回写落库）            → turnState.visualFactSheets
              │                                           │                          → turn-finalizer/onTurnEnd
              ▼                                           ▼
      C1 主模型窗口（兼容）              C2/C3/C4/C6 从窗口对象取 sheet 消费判据
```

---

## 2. 新域 `src/resolution/visual/`

与 brand/geo 同构：纯确定性、零 LLM、零出向依赖（仅 zod）。LLM 调用留在 channels（P1）/ tools（P2）调用方。

```
src/resolution/visual/
├── visual-fact.types.ts      # zod schema + TS 类型（唯一定义点）
├── ownership-defaults.ts     # kind → 字段归属默认规则 + finalize 校验
├── visual-fact-render.ts     # 窗口文本渲染（含 kind 标注前缀）+ 旧文本兼容判定
└── index.ts                  # barrel
```

### 2.1 `visual-fact.types.ts`

```ts
import { z } from 'zod';

export const VISUAL_FACT_KINDS = [
  'job_posting',      // 招聘平台岗位截图/海报
  'map_location',     // 地图/定位/门店位置截图
  'resume',           // 简历（拍照/手写/截图）—— isResumeImageDescription 的正名
  'chat_screenshot',  // 聊天记录截图（双方信息混合）
  'certificate',      // 健康证/学生证/证件类
  'other',            // 兜底：只有 rawDescription，行为等同现状
] as const;

export const VisualFactFieldSchema = z.object({
  key: z.enum([
    'phone', 'name', 'age_range', 'brand', 'publisher', 'store',
    'address', 'city', 'salary_text', 'shift_text', 'cert_type', 'other',
  ]),
  value: z.string().min(1),
  ownership: z.enum(['candidate', 'publisher', 'third_party', 'unknown']).optional(),
  // optional：生产端可缺省，finalize 按 kind 补默认值
});

export const VisualFactSheetSchema = z.object({
  kind: z.enum(VISUAL_FACT_KINDS),
  fields: z.array(VisualFactFieldSchema).default([]),
  rawDescription: z.string().min(1),
});
export type VisualFactSheet = z.infer<typeof VisualFactSheetSchema>;
```

### 2.2 `ownership-defaults.ts`

```ts
/** kind → 归属默认值。字段显式给了 ownership 则尊重；缺省按此补。 */
const KIND_DEFAULT_OWNERSHIP: Record<VisualFactKind, FieldOwnership> = {
  job_posting: 'publisher',      // 岗位截图上的一切默认是发布方的
  resume: 'candidate',           // 简历默认全是候选人自陈
  map_location: 'candidate',     // 候选人用地图指自己的位置
  chat_screenshot: 'unknown',    // 双方混合，判不了 → unknown（按第三方消费）
  certificate: 'candidate',
  other: 'unknown',
};

/** finalize：补归属默认值 + 剔除空值字段 + kind 不合法降级 other。
 *  两条生产路径共用；解析失败/校验失败一律降级 {kind:'other', fields:[], rawDescription}，
 *  行为逐字等同现状——降级不是失败，是回到今天。 */
export function finalizeVisualFactSheet(raw: unknown, rawDescription: string): VisualFactSheet;
```

### 2.3 `visual-fact-render.ts`

```ts
/** 窗口文本渲染。Phase 1/2 与现状逐字一致；Phase 3 切换带 kind 标注。 */
export function renderWindowText(sheet: VisualFactSheet, opts: { kindLabel: boolean }): string;
// kindLabel=false → "[图片消息] <raw>"        （Phase 1/2）
// kindLabel=true  → "[图片消息·岗位截图] <raw>"（Phase 3，表情消息不标注）

/** 旧数据兼容：无 visual_facts 的历史行按 kind='other' 处理。 */
export function isVisualDescriptionText(content: string): boolean; // 从 PR #870 的 visual-description.ts 迁入
```

### 2.4 依赖方向审计

| import 方向 | 合规性 |
|---|---|
| `channels/wecom → resolution/visual` | ✅ 已有先例（`image-brand-backfill.service.ts` import `@resolution/brand`） |
| `tools → resolution/visual` | ✅ 规则明文允许；**并修掉现存违规**：`save-image-description.tool.ts:19-21` 今天 import `@channels/wecom/message/utils/message-parser.util`，Phase 1 把 `isResumeImageDescription`/`stripResumeAttachmentLines` 迁入本域后转正 |
| `memory → resolution/visual` | ✅ 规则明文允许 |
| `resolution/visual → *` | 仅 zod。**零仓内出向依赖**（比 brand 还干净，brand 依赖 sponge 目录） |

---

## 3. 存储层

### 3.1 迁移 SQL

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_add_chat_messages_visual_facts.sql
-- 可空 jsonb 列：仅图片/表情消息行非空；PG 11+ 加可空列为元数据级 DDL，不重写表。
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS visual_facts jsonb;
COMMENT ON COLUMN chat_messages.visual_facts IS
  'VisualFactSheet：图片/表情消息的结构化事实（kind/fields/rawDescription），与 content 的文本描述同源同时机写入。NULL=旧数据或非视觉消息，消费端视同 kind=other。';
```

- 不建索引（无按 kind 检索场景）；不回填历史。
- **为什么不复用已有 `payload` 列**：`payload` 存的是企微回调原始报文（`fileUrl` 等，被 precheck 简历链路消费），语义是"渠道给我们的"；`visual_facts` 是"我们理解出来的"。混写会让两类生命周期与信任级别纠缠。
- 发版红线照旧：测试库先行（`pnpm run db:push:test`）→ 生产 push 与代码发版同步 → 上线后真实写入验证。

### 3.2 `chat-message.repository.ts`

| 函数 | 改动 |
|---|---|
| `updateContentByMessageId(messageId, content)` | 扩可选参 `visualFacts?: VisualFactSheet` → update 语句多一列 |
| `getChatHistoryDetail(chatId)`（:241） | select 列表追加 `visual_facts`；返回行对象追加 `visualFacts?: VisualFactSheet`（已有 `payload` jsonb 透传先例，:255 同款） |

### 3.3 `chat-session.service.ts`

`updateMessageContent(messageId, content)`（:227）扩可选参 `visualFacts`，透传 repository。

**缓存一致性零新增工作**：该方法现有机制就是「DB 更新成功 → `del` 该会话短期记忆 list 缓存 → 下次读取 cache miss 从 DB 回填」（:233）。visual_facts 走同一次 update、同一次 del，回填时 `getChatHistoryDetail` 自然带出新列。**不需要碰缓存写入侧**（`shouldMirrorToShortTermCache` 镜像的是发消息时刻的原始行，视觉消息彼时本来就没有描述，现状亦然）。

### 3.4 窗口对象透传

短期记忆窗口消息类型（`memory.shortTerm.messageWindow` 元素）追加可选 `visualFacts` 字段，从 repository 行透传。C2/C3/C4/C6 由此取数。

---

## 4. 生产者改造

### 4.1 P1 `ImageDescriptionService`（channels/wecom）

| 位置 | 现状 | 改动 |
|---|---|---|
| `:219` vision 调用 | `this.llm.generate({ role: ModelRole.Vision, messages: [...含 image] })` 出自由文本 | 换 `this.llm.generateStructured({ role: ModelRole.Vision, schema: VisualFactSheetSchema, outputName: 'VisualFactSheet', messages, validateOutput })`——executor `generateStructured`（`llm-executor.service.ts:143`）复用 `generate` 的重试/降级/无输出重试策略，vision 输入兼容 |
| vision 提示词 | 描述指令 | 增写 kind 判定口径 + 逐字段抽取 + 归属规则（`chat_screenshot` 逐字段判）；简历段落沿用现有「简历图片：」指令措辞迁移 |
| `:246-249` 简历分支 | `isResumeImageDescription` 硬编码 | 改判 `sheet.kind === 'resume'`；「简历附件：URL」行**保留原样**（下游 F3 正则、precheck、booking 均不动） |
| 结构化失败 | — | catch 后 `finalizeVisualFactSheet` 降级 `kind='other'` + 整段文本作 rawDescription；**再失败走现状纯文本路径**——P1 永远至少产出今天的产物 |
| `writeBackDescription` | 只回写 content | 带 `visualFacts` 一并回写 |

### 4.2 P2 `save_image_description` 工具

| 位置 | 改动 |
|---|---|
| inputSchema | 增 `kind: z.enum(VISUAL_FACT_KINDS).optional()` 与 `fields: z.array(VisualFactFieldSchema).optional()`；description 增两行填写指引（岗位截图上的信息 ownership=publisher 等）。**optional 是刻意的**：主模型漏填 → finalize 降级 other，不阻塞描述保存 |
| `:75-85` execute | `finalizeVisualFactSheet({kind, fields}, description)` → `updateMessageContent(messageId, content, sheet)` |
| `:79` 简历分支 | 判 `sheet.kind === 'resume'`（保留旧函数并跑对照一版，见 §8） |
| `:90-94` 品牌旁路 | 保留；Phase 3 起入参改为剔除 publisher 字段后的文本（§6-R2） |
| `:19-21` import | `@channels/...` → `@resolution/visual`（分层违规转正） |

### 4.3 P1/P2 并存语义（现状即如此，不改）

P2 是主模型看图的即时产物，P1 是异步兜底/补写（`describeForBackfill:132`）。两者都走 `updateMessageContent` 整条替换——后写者赢，sheet 与 content 永远同源成对，不会出现"文本是 P2 的、sheet 是 P1 的"撕裂。

---

## 5. 回合旁路：镜像品牌域五点管线

逐点对照（品牌域现管线 → 本专项新增，全部同构）：

| # | 品牌域现状 | 新增 |
|---|---|---|
| 1 | `tool.types.ts:158` `onImageBrandResolved?: (resolutions, {messageId}) => void` | 同文件增 `onVisualFactsResolved?: (sheet: VisualFactSheet, meta: {messageId}) => void` |
| 2 | `tool-context.builder.ts:39` `turnState.imageBrandResolutions: BrandResolution[]`；`:110` 回调 push | 增 `turnState.visualFactSheets: Array<{messageId, sheet}>` + 回调 push |
| 3 | `preparation.service.ts:274` 初始化 `imageBrandResolutions: []` | 增 `visualFactSheets: []` |
| 4 | `generator.agent.ts:374` 传 `memory.onTurnEnd({ imageBrandResolutions })` | 增 `visualFactSheets` 透传 |
| 5 | `memory-lifecycle.service.ts:47/:576` onTurnEnd 消费 | 消费点见 §6（R3 geo 确权走这里，与 `buildLocationShareCityFact` 同位） |

**晚到补写**：P1 异步完成时若本轮已结束，模板同样现成——`image-brand-backfill.service.ts`（channels 层重新持锁补写品牌，§10.3）。Phase 2 若 Phase 0 补盘证实 `oaz6inzf` 确为时序问题，在该 service 同位增加 visual facts 的 late-apply；若证实不是时序（是 C1 行为问题），此点降级为不做。

---

## 6. 消费端改造（R1-R5 逐文件）

### R1 身份自陈判据（Phase 2）—— 根除 `vkikct39`

| 文件 | 现状 | 改动 |
|---|---|---|
| `memory/facts/visual-description.ts`（PR #870 引入） | `keepSelfReportedMessages` 靠**文本前缀猜**"是不是图片、是不是简历" | 判据换源：窗口对象带 `visualFacts` 时按 `kind==='resume'` 放行、其余视觉消息剔除；无 sheet（旧数据）回落前缀判定。**函数签名从 `string[]` 升为窗口对象数组**——这是 R1 的主要波及面 |
| `memory/facts/high-confidence-facts.ts` `extractHighConfidenceFacts` | 入参 `userMessages: string[]`，函数内 `keepSelfReportedMessages` 收窄身份字段 | 入参升级为 `Array<{content, visualFacts?}>`（或平行可选参）；**4 个调用点**（`session.service.ts:812/834`、`memory-lifecycle.service.ts:424`、`geocode-location-anchor.util.ts:106`）同步传窗口对象——判据仍在函数内部，调用点只改传参形状 |
| `session.service.ts` phone 自陈出处门（PR #870） | `hasSelfReportedPhoneProvenance(phone, userMessages)` 文本判 | 同源换判据：自陈语料 = 手打消息 + `resume` kind 的 `candidate` 字段值；`dropInterviewField` reason 细分 `ownership_publisher` |
| C4 `assertExtractionIdentityProvenance` | 出处语料=整个提取 prompt | **保持不动**（它是"防凭空臆造"的最后闸，语料宽是它的职责）；第三方剔除由上游 R1 完成，两门职责分离 |

### R2 发布方剔除（Phase 3）—— 根除品牌劫持

| 文件 | 改动 |
|---|---|
| `save-image-description.tool.ts:90` 品牌旁路 | `resolve()` 入参从整段 description 改为：剔除 `key='publisher'`/`ownership='publisher'` 字段值后的文本（sheet 可用时），无 sheet 回落整段 |
| `high-confidence-facts.ts` `detectBrandAliasHints` | hints 轨对视觉消息：sheet 可用时只喂 `key='brand'` 字段值，不再喂全文 |
| `resolution/brand/*` | **不动**。`BrandResolutionSource` 三值枚举保持——发布方剔除发生在"喂给品牌域之前"，不入侵品牌域内部 |

### R3 地图直通定位（Phase 2）—— 根除 `oaz6inzf`、`x3pdj7qh`

| 文件 | 改动 |
|---|---|
| `memory/facts/location-share.ts` `buildLocationShareCityFact` 同位 | 新增 `buildVisualMapCityFact`：`kind='map_location'` 的 `city`/`address` 字段 → 经 geo 白名单/geocode 确权后按 `source='tool'` 入档（与定位分享 A2 同级证据、同一让位规则：本轮手打高置信城市优先） |
| `tools/shared/invite-city-gate.ts:86` | `inferCitiesFromGeoSignals` 语料按消息过滤：视觉消息只取 `map_location` 的城市字段，**`job_posting` 的门店地址不再进候选人城市推断**（`x3pdj7qh` 拉错群的根除点） |
| `agent/generator/geocode-location-anchor.util.ts:106` | 同判据：锚点候选只认 `map_location` 字段 + 手打文本 |

### R4 截图岗位需查证（Phase 3，prompt 档）—— 缓解 `umr69uqq`

| 文件 | 改动 |
|---|---|
| `resolution/visual/visual-fact-render.ts` | `kindLabel=true` 生效：`[图片消息·岗位截图]` |
| `agent/generator/context/prompts/candidate-consultation.md` | 增一条口径：「`[图片消息·岗位截图]` 里的薪资/班次/在招状态是候选人看到的版本，必须以 `duliday_job_list` 当前结果为准，不得直接确认或比对」。跨工具全局原则 → 放主 prompt（prompt 分层裁定） |
| 守卫 | **不立**。兜底边界原则：等 Phase 3 后观测窗口的 badcase 实证再议 |

### R5 简历硬编码正名（Phase 1 归并，Phase 4 删除）

| 文件 | 动作 |
|---|---|
| `channels/wecom/message/utils/message-parser.util.ts:30/:42` | 两函数迁入 `resolution/visual`，原位 re-export（Phase 1）→ 删除 re-export（Phase 4） |
| `duliday-interview-precheck.tool.ts:258`、booking `:754`、`read-resume-attachment.tool.ts` | **全部不动**——它们消费的是「简历附件：URL」文本行，该行保留 |

---

## 7. 观测埋点

| 事件/指标 | 落点 | 用途 |
|---|---|---|
| `visual_fact_structured {kind, fieldCount, degraded}` | tracer（`agent_execution_events`，P1/P2 各自 emit） | kind 分布、结构化成功率（Phase 1 出口判据 ≥95%） |
| `extraction_field_dropped {reason: 'ownership_publisher'}` | 既有事件 reason 细分（`session.service.ts` dropInterviewField 现成管道） | R1 拦截命中，验收指标 |
| `resume kind ↔ 旧硬编码判定不一致` | Phase 1 并跑期 logger.warn + tracer | §8 并跑对照，出口判据一致率 100% |
| 日报专节 | `daily-auto-scan-report` SKILL 增一条查询：窗口内 `agent_execution_events` 按 kind 聚合 + degraded 率 | shadow 期每日可见 |

---

## 8. 测试与并跑对照

| 层 | 内容 |
|---|---|
| 单测（新增） | `tests/resolution/visual/`：schema 校验、finalize 降级、归属默认、渲染兼容（旧文本 round-trip）；两条生产路径的降级分支 |
| 单测（迁移） | PR #870 的 13 例全保留：其中「城市仍可定位」「简历号码仍提取」两条边界钉子改喂带 sheet 的窗口对象复跑；纯文本入参路径（旧数据兼容）保留原断言 |
| 并跑对照（Phase 1 shadow 期） | `resume` kind vs `isResumeImageDescription` 双判并跑：不一致即 warn + tracer，两周窗口一致率 100% 才允许 Phase 4 删旧函数 |
| 回归 badcase 策展 | `vkikct39` / `oaz6inzf` / `x3pdj7qh` / 品牌劫持 4 条进正式测试集（决策时刻锚点按 SOP；假身份兮兮/18271421690） |
| 全量 | `tests/memory` + `tests/tools` + `tests/agent` 相关目录；`nvm use 22.16.0` + `--watchman=false` |

---

## 9. PR 切分与发版顺序

| # | PR | 内容 | 依赖 | 风险 |
|---|---|---|---|---|
| 0 | （无码）Phase 0 补盘结论回填两份文档 | `awaitVision` 超时率 / P1P2 时序 / 多图 / 表情 / C1 表现 | — | — |
| 1 | `feat(resolution): visual 域 + 存储列 + 双生产者结构化（shadow）` | §2 全部 + §3 全部 + §4 全部 + §5 管线 + §7 埋点 + R5 归并（re-export）。**迁移随本 PR，先 push 测试库；生产 push 与本 PR 发版同一窗口** | Phase 0 结论 | 低——零消费行为变更，降级=现状 |
| 2 | `fix(memory): 身份自陈判据换源 + 地图直通定位` | R1 + R3（含 `visual-description.ts` 判据换源、4 调用点传参升级、invite 城市门、geocode 锚点） | PR-1 发版且 shadow 指标达标 | 中——badcase 复测 + 13 例回归兜底 |
| 3 | `fix(brand+prompt): 发布方剔除 + 截图岗位查证口径` | R2 + R4（kind 标注前缀在此 PR 一并开启） | PR-2 | 低 |
| 4 | `chore: 清债` | 删 `visual-description.ts` 文本猜测、删旧硬编码与 re-export、盘点文档标注取代 | 并跑对照两周达标 | 低 |

回滚：各 PR 独立版本回滚；`visual_facts` 列只增不改语义，回滚后旧代码忽略该列，无数据回滚动作。

---

## 10. 本文相对产品方案的两处修正

1. **Redis 一致性机制**：产品方案 §3.3 早版写"updateMessageContent 同步刷新 Redis 顺带覆盖"——实际机制是 **del 缓存 → 下次读取从 DB 回填**（`chat-session.service.ts:227-236`），对本方案更有利：缓存侧零改动，一致性由回填天然保证。
2. **`payload` 列已存在**：`chat_messages` 已有 jsonb 列 `payload`（渠道原始报文）。不复用的理由见 §3.1——"渠道给我们的" vs "我们理解出来的"，语义与信任级别不同。
