# 废弃/退役设计的全库残留清理（执行清单 · 交接 GPT 执行）

> **起因**：代码评审发现 `src/types/guardrail.contract.ts` 在 replan 于 2026-07-27 退役后仍定义着
> `GUARDRAIL_DECISION.REPLAN`。清理该项（见 §6，已完成）后做了一次全库同类扫描——还有多少
> "已废弃/下线/退役、却仍有残留"的设计，不限代码、注释、文档。
> **扫描范围**：`src/` `web/src/` `tests/` `docs/` `supabase/migrations/` `.env.example`。
> **扫描方法**：中英文废弃词表（退役/废弃/弃用/不再/已删除/死代码/不可达/恒为空/仅保留/兼容历史
> + deprecated/legacy/obsolete/unused/no longer）→ 逐条 grep 反查真实引用 → 关键项打生产库核验。
> **本清单是唯一交接物，自包含，不依赖审计会话。**
> **执行分支**：`codex/candidate-profile-domain-refactor`（当前分支）。

## 0. 执行前必读

### 0.1 纪律

1. **§0.2 是已核验的假阳性，勿"顺手清理"**——那批 DROP 出来的函数生产库里全都在跑，删了就是生产事故。
2. **§2.1 需要人裁定，GPT 不得自行选择方案**，其余各节可直接执行。
3. **行号会随编辑漂移**：本文给了行号，但定位一律**用原文片段做字符串匹配**，不要信行号。
4. **注释类改动的红线**：本轮去重**只删重复表述，不删信息**。判断标准——删掉后，"这里为什么
   没有某段逻辑"这个信息是否仍能从代码或保留下来的注释里得到。得不到就不能删。
5. 每节改完跑 `pnpm run lint:check && pnpm run typecheck && pnpm run test --watchman=false`
   （注意：不带 `--`，字面 `--` 会让 watchman 参数失效；Node 用 22.16.0）。

### 0.2 已核验的假阳性（勿重开）

| 疑似项 | 核验结论 |
|---|---|
| 10 个 `DROP FUNCTION`（`aggregate_hourly_stats` / `upsert_long_term_profile_facts` / `record_reengagement_touch` / `upsert_user_activity` / `null_agent_invocation` / `get_dashboard_overview_stats` / `record_candidate_blacklist_hit` / `append_long_term_summary_atomic` / `get_reengagement_candidate_overview` / `get_active_users_from_user_activity_by_range`） | **全部仍存在于生产库**（实查 `pg_proc`）。迁移里的 DROP 是 CLAUDE.md 规定的 `DROP IF EXISTS + CREATE` 重定义写法（`IF NOT EXISTS` 只查名字不查定义会静默跳过），不是废弃 |
| 已 DROP 列 `is_synthetic` / `memory_key` / `feishu_app_token` / `is_primary` | 代码零引用，已干净 |
| `increment_booking_count` / `upsert_profile_with_confidence_guard` / `append_summary_atomic` | 生产库已无 + 代码零引用，干净 |
| `src/sponge/sponge.types.ts` 那批 `@deprecated` 字段（`requirementNum`/`minAge`/`maxAge`/`storeName`/`storeAddress`/`cityName`/`regionName`） | **必须保留**。`JobBasicInfo` 带 `[key: string]: unknown` 索引签名，删掉声明后从 `basicInfo` 顶层取这些字段**照样编译通过**、只是恒得 `undefined`。这几行 `@deprecated 现网在 hiringRequirement…` 是唯一的防线 |

---

## 1. 死代码删除（零引用，可直接执行）

**状态：☑ 已完成（2026-08-13）**

三处都已核验全仓零调用方。删除符号本体 + 其上方 JSDoc。

| # | 文件 | 锚点（字符串匹配） | 说明 |
|---|---|---|---|
| 1.1 | `src/tools/duliday/precheck/age.util.ts:66` | `export type AgeBoundarySignal = AgeScreeningSignal;` 及上一行 `/** @deprecated 使用 AgeScreeningSignal */` | 全仓只剩定义行本身 |
| 1.2 | `src/infra/redis/redis.service.ts:69` | `getClient(): Redis {` 整个方法 + 其上 JSDoc（含 `@deprecated 直接使用原始客户端会绕过环境前缀`） | 注释自称"当前 src/ 内无调用方"，核实属实：grep 命中的 `getClient` 全部来自 `infra/supabase/base.repository.ts` 的同名方法 |
| 1.3 | `src/biz/message/services/chat-session.service.ts:102` | `async getChatTrend(days: number = 7)` 整个方法 + 其上 JSDoc（含 `当前无生产调用方`、`待删`） | 注释自己写了"待删"。`message.controller.ts:69` 走的是 `analyticsQueryService.getChatTrend`，本方法是孤儿 |

**验收**：删除后 `pnpm run typecheck` 必须过；`grep -rn "AgeBoundarySignal\|getChatTrend" src/` 只剩
`analytics-query.service.ts` 与 `message.controller.ts` 里的那条链路。

### 1.4 `GEOCODE_CITY_REQUIRED`——需裁定，**本轮不动**

`src/tools/types/tool-error-types.ts:127`，零引用。注释称"常量保留只为兼容历史 badcase 记录"。

该理由站不住（历史记录存的是字符串 `geocode.city_required`，不依赖 TS 常量存在），但它属于
**错误码目录**，按既有原则"外部/权威码表零引用也保留作码表，不当死代码删"。

**本轮处置**：不删。只把注释里站不住的理由改掉，改成如实说明：

```
/**
 * @deprecated 自 [松绑 city 必填 + 引入多候选验证] 之后，geocode 工具不再因为 city 缺失
 * 硬报错——除非命中「通用后缀黑名单」，那条路径报的是 GEOCODE_AMBIGUOUS_SUFFIX。
 * 代码零引用，保留仅为错误码目录完整性（历史观测数据里存的是字符串字面量，
 * 不依赖本常量存在）。
 */
```

**执行记录（2026-08-13）**：已删除 1.1–1.3 的三个退役符号及对应 JSDoc；
`GEOCODE_CITY_REQUIRED` 按 1.4 保留，只将注释理由改为“错误码目录完整性”。交接清单原称全仓零调用方，
但完整测试发现 `getClient` / `getChatTrend` 仍各有退役单测；经确认同步删除这些测试，并移除
`getChatTrend` 专用的 `MonitoringRecordRepository` 注入，无其他偏离。

---

## 2. 幽灵配置：文档教人用，代码根本不读

### 2.1 `ENABLE_BULL_QUEUE`——已裁定方案 B

**状态：☑ 已完成（2026-08-13）**

- `CLAUDE.md:28`：「本地无 Redis 时设 `ENABLE_BULL_QUEUE=false`（.env.local）」
- `docs/db/redis-schema.md:469`：同样示例
- `.env.example`：有该变量定义
- **全仓零读取**——`src/infra/queue/bull.module.ts` 里没有任何对它的判断

**危害**：这是本次审计唯一有实际危害的一条。照文档做的人（含并发 AI 会话，本仓库常态）设了
`ENABLE_BULL_QUEUE=false` 后会以为队列已关，实际毫无效果。文档承诺了一个不存在的开关。

**备选方案（已由人裁定采用 B）**：

- **(A) 补实现**——在 `bull.module.ts` 真的接上开关，无 Redis 时跳过队列注册。贴合文档原意，
  但要先确认"不注册队列"时消息链路的降级路径是否成立（debounce 合并依赖 Bull job）。
- **(B) 删文档 + 删变量**——若结论是队列本就不该关，则从 `CLAUDE.md`、`docs/db/redis-schema.md`、
  `.env.example` 三处一并删除，并在 CLAUDE.md 补一句本地无 Redis 的真实做法。

**降级链路调研结论（2026-08-13，仅回写，未改代码）**：

- **完全无 Redis 时应用不能启动**：`UPSTASH_REDIS_REST_URL/TOKEN` 是必填配置，且
  `RedisService.onModuleInit()` 会 `ping`，失败后直接抛错；因此当前不存在“无 Redis 但应用照常运行”
  的基础降级。
- **只有 Bull TCP Redis 不可用时也不会自动直发**：`BullQueueModule` 会依次尝试
  `UPSTASH_REDIS_TCP_URL`、`REDIS_URL`，最后回退到本机 `localhost:6379`，没有跳过队列注册的分支。
  debounce 开启时，`SimpleMergeService.addMessage()` 先把消息写入 REST Redis pending，再创建 Bull
  delayed job；`queue.add` 最终抛错时，上游只记录 merge failure 并把该 messageId 标记为已处理，
  **不会**回退调用 `processSingleMessage()`，所以该消息不会得到单条直发回复。
- **现有唯一的“去 debounce”路径是关闭消息聚合开关**：运行时
  `message_merge_enabled=false` 会让 `MessageService` 直接走 `processSingleMessage()`，代价是多条消息
  不再合并。但这个开关来自 Dashboard/Supabase（`ENABLE_MESSAGE_MERGE` 只在缺省时充当种子），且
  `BullQueueModule` / `message-merge` queue 仍会照常初始化，因此它不能让本地环境真正脱离 Redis/Bull。
- 因而方案 A 若被选择，不能只“少注册一个 queue”：还需同时定义 merge 关闭/直发语义，并处理
  `@InjectQueue('message-merge')` 的模块依赖；方案 B 则需明确本地必须提供可用 Redis。

**执行记录（2026-08-13）**：人工核验调研结论后裁定采用方案 B。已从 `CLAUDE.md`、
`docs/db/redis-schema.md`、`.env.example` 删除幽灵开关，并写明本地必须提供 REST + TCP Redis；
未改任何队列或消息处理代码。

### 2.2 `SUPABASE_BRAND_CONFIG_PATH` / `SUPABASE_BUCKET_NAME`

**状态：☑ 已完成（2026-08-13）**

只存在于 `.env.example`，全仓（代码/脚本/CI/Dockerfile/文档）零引用。直接从 `.env.example` 删除
这两行。

**执行记录（2026-08-13）**：已从 `.env.example` 删除两行，未改动其他 Supabase 配置。无偏离。

---

## 3. 废弃表的注释去重

**状态：☑ 已完成（2026-08-13）**

`recruitment_cases`（表已 DROP）在代码里留下 15 处注释、`interview_booking_records` 1 处，**全部是
注释，零代码引用**。

**先说清楚为什么不是全删**：这些注释绝大多数是"这里为什么**没有**某段逻辑"的负空间说明。删掉
它们，下一个人看到 booking 没有本地查重，很可能"顺手加回来"——那正是当初有意移除的东西。所以
它们指向已删对象，但携带的信息是**当前设计为什么长这样**。

**真正的问题是重复**：同一个事实在一个文件里被说了三遍。处置原则——**每个事实留一处权威说明
（信息最全的那处），其余去掉 `recruitment_cases` 提法但保留句子本身**。

### 3.1 `src/biz/intervention/intervention.service.ts`（3 处说同一事实）

| 行 | 原文锚 | 处置 |
|---|---|---|
| ~107 | `handoff 运行时状态只用 pause 一层（recruitment_cases 状态机已废弃，不再 markHandoff）。` | **保留作权威**——它紧贴代码位置，是防止有人加回 `markHandoff` 的锚点 |
| ~41 | `人工介入（handoff）。recruitment_cases 已废弃后 handoff 不再区分 onboard/general，` | 改为 `人工介入（handoff）。不区分 onboard/general，` |
| ~73 | `输出：执行「暂停托管 + 飞书告警」的原子组合（recruitment_cases 状态机废弃后不再更新业务状态）` | 改为 `输出：执行「暂停托管 + 飞书告警」的原子组合（不更新任何业务状态机）` |

### 3.2 `src/notification/types/general-handoff-notification.types.ts:12`

原文锚：`recruitment_cases 废弃后 handoff 不再区分 onboard/general（见 intervention.service），`

改为：`handoff 不区分 onboard/general（见 intervention.service），`
（下一句「本 payload 是人工介入告警的唯一形状，不依赖任何 case 状态机」**保留**，它是设计约束。）

### 3.3 `src/agent/generator/preparation.service.ts`（3 处说同一事实）

| 行 | 原文锚 | 处置 |
|---|---|---|
| ~546 | `不再读 recruitment_cases 本地字段（历史 booking_id 全 NULL、状态与海绵脱节）。` | **保留作权威**——唯一给出了原因（booking_id 全 NULL、状态脱节），是最强的防补回锚点 |
| ~203 | `// [当前预约信息] 改由 active_booking 指针 + 海绵工单实时状态渲染（不再依赖 recruitment_cases 本地字段）。` | 改为 `// [当前预约信息] 由 active_booking 指针 + 海绵工单实时状态渲染（理由见 loadBookingContext）。` |
| ~237 | `// recruitment_cases 已废弃，不再由 case 推导 onboard_followup）。` | 改为 `// 不由任何本地 case 状态推导 onboard_followup）。` |

### 3.4 `src/tools/duliday-interview-booking.tool.ts`（3 处，其中 2 处重复）

| 行 | 原文锚 | 处置 |
|---|---|---|
| ~469 | `// recruitment_cases 已废弃：不再用 active case 查重。重复预约由海绵侧约束 +` | **保留作权威**（查重这件事的完整说明） |
| ~1171 | `// 不再写 recruitment_cases（已废弃，状态全部实时查海绵）。` | **保留**——它讲的是"不再写库"，与查重是不同的点，且是防补回锚点 |
| ~1025 | `// 提交前软查重：recruitment_cases 废弃后，重复预约主要靠海绵约束 + active_booking` | 改为 `// 提交前软查重：重复预约主要靠海绵约束 + active_booking`（完整理由见 ~469 处） |

### 3.5 `src/sponge/sponge.types.ts:340`——真墓碑，可精简

原文锚：`⚠️ 历史 bug：旧 schema 未解析 \`data.workOrder\`，导致 recruitment_cases.booking_id`

这处指向的表已不存在，且讲的是**已修复的历史 bug**，对现在的代码无指导作用。但同一段 JSDoc 的
后半句（`修复后这里携带真正的 workOrderId，供 active_booking 指针与 ops_events(booking.succeeded) 使用`）
是有用的现状说明，**必须保留**。

处置：删掉"历史 bug"那一句，保留字段用途说明。

### 3.6 `src/tools/request-handoff.tool.ts:181`——保留不动

原文锚：`（recruitment_cases 废弃后已无 case.bot_im_id`

**保留**——它解释的是"为什么这里必须显式告警、而不是静默兜底"：原本可兜底的来源
（`case.bot_im_id`）随表一起没了。删掉这句，下一个人会觉得这个 warn 是多余的。

### 3.7 `src/memory/types/long-term.types.ts:271`（`interview_booking_records`）

原文锚：`本指针的前身 interview_booking_records 是以日期、品牌、门店为联合唯一维度的聚合`

**保留不动**——它解释的是当前指针设计为什么是这个形状（对比前身），属于有信息量的设计留痕。

### 3.8 tests 里的 3 处

`tests/agent/generator/preparation.service.spec.ts:212 / 1130 / 1148`——测试注释，解释断言为什么这么写。
**保留不动**，本轮不碰测试注释。

### 3.9 验收

`grep -rn "recruitment_cases" src/ | wc -l` 应从 **12 降到 5**。剩下的 5 处必须正好是这些"防补回"
锚点，一处不多一处不少：

| 文件 | 保留理由 |
|---|---|
| `intervention.service.ts` ~107 | 防有人加回 `markHandoff` |
| `preparation.service.ts` ~546 | 唯一给出原因（booking_id 全 NULL、状态脱节） |
| `duliday-interview-booking.tool.ts` ~469 | 查重这件事的完整说明 |
| `duliday-interview-booking.tool.ts` ~1171 | "不再写库"，与查重是不同的点 |
| `request-handoff.tool.ts` ~181 | 解释这个 warn 为什么不能静默兜底 |

账要对上：12 = 5 保留 + 6 去掉提法（§3.1 两处、§3.2、§3.3 两处、§3.4 一处）+ 1 删句（§3.5）。
`interview_booking_records` 那处（`long-term.types.ts:271`）不在这个计数里。

**执行记录（2026-08-13）**：严格按表完成 6 处去掉提法与 1 处历史 bug 删句；所有指定权威注释、
`request-handoff` 说明、`interview_booking_records` 设计留痕和测试注释均保留。无偏离。

---

## 4. 写了到期条件、却没人回来复查的临时并跑

**状态：☑ 已执行（2026-08-17）——5 条全部复查完毕，实删 1 条（4.2），其余 4 条按判据维持并跑并回写复扫记录**

这一类最容易烂成永久债——**每条都自带拆除判据，只是判据没人执行**。

> **建议（需人裁定）**：给这一类定个统一机制，比如到期日进定时任务或每日 badcase 日报的检查项。
> 否则本节只会继续变长——今天这 5 条就是这么攒出来的。
>
> **2026-08-17 裁定：本次不做**，建议原文保留。

### 4.0 本轮执行记录（2026-08-17）

| # | 结论 | 依据 |
|---|---|---|
| 4.1 | **不删**，注释追加 A2 复扫记录 | 本地无生产容器日志访问权，取不到完整 7 天窗口，判据无法证实 |
| 4.2 | **已删墓碑** | 生产 factsv2 全量复扫：444/444 会话 `preferences.brands` 存量为 null，计数 = 0 |
| 4.3 | **不删**，判据已失效 → 改写为新前置条件 | 计数虽为 0，但发现该信封另有**活跃非兼容用途**，删了会抛错（下方详述） |
| 4.4 | **不删**，判据改写为指向现行裁定 | enforce 开关语义已被收资表单状态机取代，原判据挂靠对象已不存在 |
| 4.5 | **不删字段**，补齐可判门槛 | 原注释只写"正在退役"无到期条件 |

**Redis 存量复扫方法（一次性只读脚本，未入库）**：`.env.production` 的 UPSTASH REST 凭证，
只发 `SCAN`（COUNT=500）+ `HGET`，批间 sleep 250ms，无任何写命令。key 前缀取自
`src/memory/services/session-key.ts` 的 `factsv2:{corpId}:{userId}:{sessionId}` +
`RedisService` 的 `production:` 环境前缀。

**扫描结果**：全键空间 7280 个 key（15 轮），其中 factsv2 = 456~457（三次扫描间有自然增减）。

| 指标 | 计数 |
|---|---|
| 解析成功的 facts 份数 | 443 |
| §4.2 `preferences.brands != null` | **0**（444/444 均为显式 null） |
| §4.3 `confidence='unknown'` 或 `source='archive'` | **0** |
| 裸标量 / 旧 CityFact 形态字段槽位 | **0**（13733 槽位全部是信封或 null） |

**量具自检**（防"0 是因为量具坏了"）：同一批数据里读出 2881 个正常信封，
`confidence` 分布 medium 1717 / high 1162，`source` 分布 llm 1717 / rule 990 / derived 103 /
candidate 68 / tool 1。量具能读出值，所以两个 0 是真的 0。
（附带发现：存量 `source` 存的仍是旧生产者名 llm/candidate，靠
`LEGACY_SESSION_FACT_PRODUCERS` 前置映射成 model/candidate_quote——**那是另一条活着的兼容层，本轮没碰**。）

| # | 位置 | 自带的拆除判据 | 怎么查 |
|---|---|---|---|
| 4.1 | `src/tools/save-image-description.tool.ts:125` legacy resume 判据并跑 | "连续 7 天复扫仍为 0 后删除本并跑与 OR 路径" | 数生产日志里 `[visual-fact] resume 判定分歧` 的 warn 条数。注释里 A1（2026-08-11）记录已覆盖连续 92h23m、分歧为 0。**注意**：本地 `logs/` 只有本机数据，需查生产容器日志或已接的告警通道；**取不到 7 天完整数据就不要删**，只把本次复扫结果追加进注释 |
| 4.2 | `src/memory/services/session.service.ts:222` `preferences.brands` 退役墓碑 | "A1 及后续复扫中 `preferences.brands` 旧值存量计数归零后删除本墓碑；factsv2 无短 TTL，不能以自然过期代替数据侧确认" | 扫 Redis factsv2：统计 `facts` 里 `preferences.brands != null` 的会话数 |
| 4.3 | `src/memory/types/session-facts.types.ts:527` 裸值兼容信封 `legacySessionFactValue` | "A1 及后续复扫中 unknown/memory 旧档计数归零后删除；factsv2 无短 TTL，不能以自然过期代替" | 扫 Redis factsv2：统计字段值里 `confidence='unknown'` 或 `source='archive'` 的条数 |
| 4.4 | `src/tools/duliday-interview-booking.tool.ts:541` `allowLegacyConfirmRegex: !enforcing` | shadow 期负向证据解锁用，enforce 起即无用（偏离⑥） | 取决于候选人事实裁决 §10 灰度进度，查 `tool-registry.service.ts:97` 附近的模式配置与生产开关 |
| 4.5 | `src/tools/duliday-interview-precheck.tool.ts` 的 9 个 `candidateXxx` 裸字段（`candidateName`/`Phone`/`Age`/`Gender`/`Education`/`HealthCertificate`/`Height`/`Weight`/`HouseholdProvince`） | 标了 deprecated「过渡期兼容通道，正在退役」，**但没写到期条件** | **本轮只补判据，不删字段**。需先定一个可判的门槛（如"claims 通道覆盖率连续 N 天 100% 且裸字段调用为 0"），写进工具注释；否则这条过渡通道永远退不掉 |

### 4.3 详记：判据满足但**不能删**——本条是本轮最重要的发现

数据侧判据（unknown/archive 计数归零）**已满足**，但按判据删除会造成生产故障，已回退。

**根因：`legacySessionFactValue` 不只是旧数据兼容层，它同时是 `saveFacts` 的活跃入参强制层。**

- `SessionService.saveFacts(facts: EntityExtractionResult | SessionFacts)` 经
  `ensureSessionFacts()` 走的是同一个 `SessionFactsSchema`；
- `EntityExtractionResult` 的字段**本来就是裸标量**，全靠 `NullableSessionFactSchema`
  的裸值分支把它升成信封；
- 活跃调用方：`src/biz/test-suite/services/memory-fixture.service.ts:54`
  `MemoryFixtureService.seed()` —— 用例种子注入，**生产 Dashboard 的 test-suite 在跑**，
  它传的就是 `resolveSessionFacts()` 返回的 `EntityExtractionResult`。

**实测证据**（临时 spec，跑完即删）：删掉裸值分支后
`SessionFactsSchema.safeParse({interview_info:{name:'张三',age:'24'}})` → `success=false`，
报 `invalid_union … expected object, received string`。即该调用会直接抛错。

⚠️ 注意：`tests/biz/test-suite/services/memory-fixture.service.spec.ts` **抓不到这个回归**
（它 mock 了 `sessionService`，真 schema 根本没跑）。只看该 spec 绿灯会误判为安全。

**新的拆除前置条件**（已写进代码注释）：先把 `saveFacts` 入参收成 `SessionFacts` 单一形态，
调用方显式经 `toSessionFacts` 带上 confidence/source/evidence；届时本信封才成为纯死码。
那是 `saveFacts` 契约变更，**不属于残留清理范围**，需另立项。

> **对本清单方法论的教训**：本节其余各条的"存量计数归零"判据都隐含假设「该符号只服务于旧数据」。
> 下次执行任何一条前，除了数据侧计数，必须先确认该符号没有第二个活跃用途——
> 计数为 0 只证明"旧数据没了"，不证明"没人用了"。

---

## 5. 空操作 / 半死代码（保留理由需复查是否还成立）

**状态：☑ 已完成（2026-08-17）——两条均由人裁定为"计划已死/无人使用"，已删除**

| # | 位置 | 情况 | 要确认什么 |
|---|---|---|---|
| 5.1 | `src/biz/conversion-analytics/conversion-analytics.service.ts:1005` | `source_channel` 写入侧恒为 `'unknown'`（暂无渠道埋点），故 channels 过滤"当前为空操作"；注释称保留以便将来接真实渠道维度（§7） | 渠道埋点计划是否还在。不在就删掉这段空过滤 |
| 5.2 | `src/biz/feishu-sync/bitable-sync.service.ts:227` | "旧版消息处理片段同步，仅保留为手动维护入口" | 这个手动入口最近是否还有人用。没有就删 |

### 5.1 执行记录（2026-08-17）

**裁定**：渠道埋点计划已死 → 删空过滤。

链路 grep 结论：`web/src/` 前端**完全没有**渠道筛选 UI 或传参（唯一命中是
`web/src/api/types/bot.types.ts` 里一条与本域无关的同源注释）。即整条 `channels` 链路
从前端到 SQL 无人使用。因此不止删过滤，整条死管道一并清掉：

| 文件 | 改动 |
|---|---|
| `conversion-analytics.service.ts` | 删 `source_channel` 过滤块 + "保留以待将来"注释；删缓存键里的 `channels` 项 |
| `types/conversion-analytics.types.ts` | 删 `ConversionFilter.channels` 字段 |
| `conversion-analytics.controller.ts` | 删 4 个端点的 `@Query('channel')` 形参与 `toFilter` 的 `rawChannels` 参数 |
| `tests/…/conversion-analytics.controller.spec.ts` | 4 处调用实参与 5 处期望对象同步去掉 channels |
| `tests/…/conversion-analytics.service.spec.ts` | 3 处 filter 字面量去掉 `channels: []` |

**行为影响交代（不是零，但可接受）**：原过滤是"空操作"仅因为无人传参；若有人真传
`?channel=wecom`，因 `source_channel` 恒为 `'unknown'`，命中结果必为**空集**。删除后同样的请求
改为返回不过滤的全量。即唯一的行为差异发生在"传了参数"这条无人走且只会返回空集的路径上，
实际流量下外部可观测行为零变化。

### 5.2 执行记录（2026-08-17）

**裁定**：手动入口连所有者都不知道存在 → 核实零调用方后删除。

**零调用方核实**：全仓 grep `syncYesterday` —— 除自身定义与其专属 spec 外无任何命中；
无 controller 路由（`feishu-sync.controller.ts` 的 `POST /feishu/sync/manual` 走的是
`ChatRecordSyncService.manualSync()`，与本方法无关）、无 cron 注册、无脚本调用。
⚠️ 勿与 `ChatRecordSyncService.syncYesterdayChatRecords()` 混淆——那是**现行同步链路**，一行没碰。

删除清单（`src/biz/feishu-sync/bitable-sync.service.ts`）：

- `syncYesterday()` 方法本体
- 只为它服务的私有 helper：`buildFeishuRecord()` / `getYesterdayWindow()` / `isReadOnlyPreview()`
- 随之失效的 DI：`messageProcessingService`、`configService`、`exceptionNotifier` 三个构造器参数
  （`FeedbackSourceTraceService` 仍自行注入 `MessageProcessingService`，其 spec provider 保留）
- 随之失效的 import：`MessageProcessingService` / `MessageProcessingRecord` /
  `BatchCreateRequest` / `AlertLevel` / `IncidentReporterService` / `ConfigService`
- 类 JSDoc 的"每日同步聊天记录到飞书"职责项（本就不准确：无 cron，该职责属 ChatRecordSyncService）
- 专属测试：`tests/biz/feishu-sync/bitable-sync.service.spec.ts` 的 `describe('syncYesterday')`
  6 个用例，及随之无用的 `chatTableConfig` / `batchCreateRecords` mock

DI 构造器变更已过 `pnpm run test:di-smoke`（AppModule 完整依赖图可实例化）。

---

## 6. 本轮已完成：replan 档退役残留清理

**状态：☑ 已完成（2026-08-13）**

- **类型层**：`GUARDRAIL_ACTION` / `GUARDRAIL_DECISION` / `OUTPUT_DECISIONS` /
  `GUARDRAIL_REPAIR_MODE(S)` 删除 REPLAN 值，`repairMode` 收成 `rewrite` 单档
- **死代码**：`buildReplanToolConstraint` + 两处 `hasReplan` 分支删除
- **提示词**：语义审查 system 里"不要 revise/replan/block"摘除该词——模型唯一一次吐出 replan
  就是照抄这句
- **安全闸改写**：`applyConfidenceBackstop` 从"硬编码折叠 replan"改为"按合法集校验、未知值折叠为
  revise"，覆盖面严格更大（历史档案重放、mock 注入、未来新增档位漏登记）且不依赖死值
- **`semantic-reviewer.normalizeDecision`**：去掉恒为假的 `allowed.has('replan')` 判断（行为零变更，
  原判据"没有 finding 要求重查 → 都能靠重写修好"在 replan 退役后恒成立）
- **文档同步**：修了 `06-Agent回合编排与TurnFinalizer.md`（replan 走 generator + 点名了**不存在的类**
  `ReplyRewriteService`）、`07-出站守卫三档裁决链.md`（裁决链与优先级串）、
  `rules-vs-semantics-design-philosophy.md`（veto 档）；`guardrail-quality-system.md` §2.4 标记落地
- **回归闸**：`tests/agent/guardrail/vocab-single-home-guardrail.spec.ts`「replan 不得回到任何出站词表」

**放行判据（生产实证）**：退役后 17 天、5726 条 `guardrail_review_records`，模型**未在任何枚举字段**
产出过 replan；唯一一次出现是 8-03 某条 `feedbackToGenerator` 自由文本里的措辞，而那个词是提示词
自己喂的。历史档案（459 条 `first_decision='replan'`）不受影响——读取链路是 `as OutputDecision`
断言无运行时校验，展示走 web 侧独立词表（已加注释标注为历史专用档）。

**未做**：`repairMode` / `repairToolNames` 字段本身的删除（`guardrail-quality-system.md` 同一条待办
的后半句），涉及 `guardrail_review_records.repair_mode` 列与 Dashboard 展示，另案。

---

## 7. 本次扫描未覆盖的面

- **`ts-prune` 全量死导出**：未跑。上次经验是 167 个候选里约 57% 假阳性，且单文件维度会低估
  （文件内互引被判 used in module），逐条核验成本高，属独立一轮的活。
- **`docs/` 全量逐篇核对**：只逐篇核对了 replan 相关章节。§6 修的两处（幽灵类名 `ReplyRewriteService`、
  过时裁决链）说明知识库里"描述已删机制"的风险真实存在，但没做全量比对。
- **前端废弃视图/路由**：未系统扫描。

---

## 8. 建议执行顺序

1. **§2.1 `ENABLE_BULL_QUEUE`** —— ☑ 已由人裁定方案 B 并完成
2. **§1.1–1.3** —— ☑ 三条零引用死代码，一把删，零风险
3. **§2.2 + §1.4** —— ☑ 删两行环境变量 + 改一处注释理由
4. **§3 注释去重** —— ☑ 8 处改动，纯注释，注意 §0.1 第 4 条红线
5. **§4.2 / §4.3** —— ☑ 已扫。§4.2 计数 0 已删；**§4.3 计数虽 0 但发现活跃非兼容用途，不删**（见 §4.3 详记）
6. **§4.1** —— ☑ 拿不到 7 天生产日志，只更新了复扫记录
7. **§4.5** —— ☑ 补到期判据完成
8. **§5** —— ☑ 两条均已裁定并删除

---

## 9. 全清单收尾状态（2026-08-17）

§1 ☑ / §2 ☑ / §3 ☑ / §4 ☑ / §5 ☑ / §6 ☑ —— **本清单执行完毕**。

仍在代码里"并跑/保留"的 4 条不是欠账，是判据未达成的显式留存，各自注释已写清下次怎么判：

| 位置 | 为什么留 | 下次怎么判 |
|---|---|---|
| §4.1 `save-image-description.tool.ts` legacy resume | 取不到 7 天生产日志 | 先把 warn 接进告警通道或拿到容器日志 |
| §4.3 `legacySessionFactValue` | 仍是 `saveFacts` 活跃入参强制层 | 先收 `saveFacts` 入参为 `SessionFacts` 单形态（需另立项） |
| §4.4 `allowLegacyConfirmRegex` | enforce 切换点已不存在 | 随收资表单状态机重启批一并处置 |
| §4.5 precheck 9 个裸字段 | 过渡通道仍在用 | claims 覆盖率连续 14 天 100% 且裸字段入参为 0 |

§7「本次扫描未覆盖的面」（ts-prune 全量、docs 全量比对、前端废弃视图）仍未做，属独立轮次。
