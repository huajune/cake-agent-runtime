# 代码重复治理 · 全库审计与执行清单（修订版 v2）

> 审计日期：2026-08-13 ｜ 基线分支：`codex/candidate-profile-domain-refactor`
> v2 修订：补入 jscpd 结构级克隆检测结果（v1 只做了指纹扫描，漏掉 3912 行成块重复）。
> 用途：交接给执行方落地。**每一项都给了 file:line、判据、改法、验收手段、雷区**。

---

## §0 开工前必读

### 0.1 已完成的部分，不要重做

本清单 v1 的两项已在本地完成，**执行方跳过**：

| 项 | 状态 | 核验方式 |
|---|---|---|
| 日期格式化统一（原 P0-1，7 步） | ✅ **全部完成** | `date.util.ts:89` 已有 `formatLocalDateWithWeekday`；`context.service.ts:123`、`datetime.section.ts` 已改用；`fact-lines.formatter.ts` / `reengagement.agent.ts` / `interview-window.util.ts` 的私有副本均已删除（grep 计数为 0） |
| 中文数字/星期映射（原 P0-3） | 🟡 **大部完成** | `src/infra/utils/chinese-numeral.util.ts` 已建；`repair-regression.util.ts` 已改用。**剩余**：核对 `schedule-window-claims.rule.ts`、`precheck/date.util.ts`、`booking-reply-format.util.ts:24`、`ops-daily-report.cron.ts:123` 是否全部切完 |

开工第一步先跑核验，确认上表，再动手。

### 0.2 分层硬约束（违反必挂 CI）

`.eslintrc.js:29-59`：**`src/resolution/**` 只允许 import `@infra/utils/date.util`**，
其余 `@infra/utils/*` 一律禁止；`src/resolution/geo/**` 更严，取零出向依赖。

⇒ 本清单新增的 `error.util.ts` / `async.util.ts` / `object.util.ts` 扩充
**不得被 resolution 层引用**。resolution 内同类代码原地保留（数量极少：`instanceof Error` 仅 1 处）。

其余：`infra/` 禁 import `biz/`/`channels/`/`agent/`；`memory/` 禁 import `tools/`。

### 0.3 并发避让（本仓库常有多会话同时改码）

1. 开工前 `git status --short`，把所有非空状态文件存成**避让清单**，本次一律不碰。
2. **每个 commit 前重跑一次** `git status --short`，清单可能变长。
3. commit 一律 pathspec 显式列文件：`git commit -- <file1> <file2>`。
   **禁止 `git add -A` / `git add .` / `git commit -a`。**
4. 不动 stash（有 12 条，含他人未完成工作），不 `git stash drop`、不 `git checkout .`。
   发现不认识的改动，停下报告。
5. **就在当前分支做，不拉新分支、不切分支。做完不要 push**，由仓库主人决定推送时机。

### 0.4 跑测试

```bash
nvm use 22.16.0
pnpm run test <spec路径> --watchman=false
```

⚠️ **不要写 `pnpm run test -- <spec>`** —— 字面 `--` 原样传给 Jest，watchman 参数失效，
表现为静默 0 测试无输出。全量跑也**禁用** `pnpm test -- --watchman=false`（flag 被当路径 pattern）。

### 0.5 代码规范

禁 `any`（用 `unknown` + 收窄）；禁 `console.log`（用 NestJS `Logger`）；文件名 kebab-case；
lint 是 `--max-warnings=0`。

---

## §1 扫描方法与范围（"是否全局"的自证）

**范围**：`src/**`（124,486 行，非 spec）+ `web/src/**`（28,172 行）。

**两轮互补的扫描**：

**第一轮 · 指纹扫描** —— 对 22 类工具型代码找语法指纹全库统计。
优点是精确，缺点是**只能找到预设的形状**。

**第二轮 · 结构级克隆检测（jscpd）** —— 不依赖预设形状，直接找成块复制。
```bash
npx jscpd src web/src --min-lines 8 --min-tokens 70 --ignore "**/*.spec.ts"
```
结果：**169 处克隆，3912 行重复，占全库 2.06%**。
（2.06% 在行业里属健康区间——一般项目 5–15%——但 3912 行是实打实的工作量。）

第二轮找到了第一轮**完全没命中**的三大块：

| 类别 | 克隆数 | 重复行 | 第一轮是否命中 |
|---|---|---|---|
| SCSS 样式 | 66 | 1652 | ❌ |
| TS 逻辑块 | 92 | 1636 | ❌ |
| 类型 / DTO | 11 | 624 | ❌ |

**第一轮已确认无问题的类别**（列出以证明覆盖面，不必复查）：
深拷贝 0 处、防抖节流 0 处自造、数组分块 0 处、前端 HTTP 全走 `api/client.ts`、
env 解析全走 ConfigService、手机号正则已收拢 `resolution/candidate/phone.ts`、
`redactCandidatePhones` / `stripNullish` / `maskApiKey` / `fetchWithTimeout` 均单一实现、
Redis key 已各自封装、NFKC 归一 7 处但语义各异（品牌/证据/入站各有口径，非重复）。

**总判断**：不是"到处都是重复"，而是**集中在 5 个板块**。基础设施抽屉
`src/infra/utils/` 只有 4 个文件 317 行——不是没建统一方法，而是**建了没有机制让人发现**
（`date.util` 只被 23 个文件 import）。所以本次治理的核心交付物是**防回流的 ESLint 规则**，
不只是这一轮的替换。

---

## §2 板块 A · 工具函数收拢（剩余 4 项）

### A-1 · `asRecord` / `isRecord`：18 份实现，6 种语义，其中 1 种会放行数组

| 文件:行 | 排除数组 | 排除 null |
|---|---|---|
| `src/agent/guardrail/output/output-rule.types.ts:112`（唯一 export） | ✅ | ✅ |
| `src/sponge/sponge-job.util.ts:11` | ✅ | ✅ |
| `src/tools/utils/job-policy-parser.ts:97` | ✅ | ✅ |
| `src/tools/utils/schedule-semantic.util.ts:162,166` | ✅ | ✅ |
| `src/tools/duliday/job-list/render.util.ts:213` | ✅ | ✅ |
| `src/tools/duliday/job-list/salary-settlement.util.ts:3` | ✅ | ✅ |
| `src/tools/duliday/job-list/sponge-area-filter.util.ts:54` | ✅ | ✅ |
| **`src/tools/duliday/job-list/hard-requirements.util.ts:23`** | ❌ **数组会被当 Record** | ✅ |
| `src/tools/duliday-job-list.tool.ts:370` | ✅ | ✅ |
| `src/memory/stores/deep-merge.util.ts:1` `isPlainObject` | ✅ | ✅ |
| `src/biz/monitoring/services/dashboard/analytics-dashboard.util.ts:120` | ✅ | ✅ |
| `src/biz/test-suite/utils/scenario-turn-count.util.ts:9` | ✅ | ✅ |
| `src/agent/generator/tool-call-analysis.ts:47` | ✅ | ✅（返回 undefined） |
| `src/agent/reengagement/booking-context.ts:122` | ✅ | ✅（返回 undefined） |
| `web/src/view/message-processing/.../MessageProcessingDetailDrawer/utils.ts:35` | ✅ | ✅ |
| `web/src/view/reengagement/.../ReengagementDetailDrawer/index.tsx:127` | ✅ | ✅ |
| `web/src/view/test-suite/list/utils/agentRenderableMessage.ts:13` | ✅ | ✅ |

**改法**：`src/infra/utils/object.util.ts` 新增

```ts
/** 值是普通对象（非 null、非数组）时按 Record 读取，否则 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** asRecord 的类型守卫形态。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}
```

`output-rule.types.ts:112` 改为 re-export（守卫规则文件散在各处引它）。
返回 `undefined` 的 3 处，调用点改 `?? undefined`，**不要另造 `asRecordOrUndefined`**。
`web/src/` 的 3 处新建 `web/src/utils/object.ts` 放同一实现（前后端不共享代码）。

⚠️ **`hard-requirements.util.ts:22` 的注释写着"等价于原先的 `typeof x === 'object'` 守卫"——
这是刻意保留的兼容语义。替换前必须确认没有数组输入依赖它**；确认后再替换，
并在 commit message 写明行为收紧。不确认就跳过这一处。

**验收**：`pnpm run typecheck && pnpm run test tests/tools tests/agent/guardrail --watchman=false`

---

### A-2 · 错误信息提取：268 处，214 处逐字相同

- `error instanceof Error ? error.message : String(error)` —— **214 处逐字相同**
- 换变量名的同形态 —— 合计 **238 处**
- 自定义兜底文案 **9 处**：`'未知错误'`×7、`'Redis 连接失败'`、`'Supabase 连接失败'`
- 取 stack **7 处**
- 最密文件：`reply-workflow.service.ts`(12)、`data-cleanup.service.ts`(12)、
  `invite-to-group.tool.ts`(10)、`accept-inbound-message.service.ts`(8)、
  `conversation-test.service.ts`(8)、`follow-up-scheduler.service.ts`(8)

**改法**：新建 `src/infra/utils/error.util.ts`

```ts
/** 从 unknown 提取可读错误信息；非 Error 走 String()。 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提取错误堆栈，无堆栈时回退到消息。 */
export function toErrorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
```

机械替换 `src/**`（**除 `src/resolution/**`**——那里只有 1 处，留着）。
9 处自定义兜底**保持行为不变**：改成 `toErrorMessage(error) || '未知错误'`，不要吞掉原文案。

**必做 · 防回流规则**（本项真正的价值），`.eslintrc.js` 的 `rules` 段：

```js
'no-restricted-syntax': ['error', {
  selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error']",
  message: '用 @infra/utils/error.util 的 toErrorMessage / toErrorStack（resolution 层除外）',
}],
```

在 `overrides` 里对 `src/resolution/**` 与 `error.util.ts` 自身关闭该规则。
**不加这条，268 处半年后会长回来。**

**验收**：`pnpm run lint:check && pnpm run typecheck && pnpm run test --watchman=false`
（等价变换，任何测试变红都说明改错了，回去改代码，不要改测试。）

---

### A-3 · `sleep` / `delay`：15 处，12 个逐字相同的私有方法

实现体全部是 `return new Promise((resolve) => setTimeout(resolve, ms));`：

`sponge-bi.service.ts:336`(delay)、`infra/feishu/services/webhook.service.ts:195`(sleep)、
`infra/supabase/base.repository.ts:117`(sleep)、`llm/llm-executor.service.ts:558`(sleep)、
`biz/test-suite/repositories/test-execution.repository.ts:275`(delay)、
`biz/test-suite/services/test-write-back.service.ts:490`(sleep)、
`biz/group-task/queue/group-task.processor.ts:580`(delay)、
`biz/group-task/services/notification-sender.service.ts:260`(delay)、
`channels/wecom/message/runtime/simple-merge.service.ts:136`(delay)、
`channels/wecom/message/delivery/delivery.service.ts:261`(async sleep)、
`channels/wecom/message/application/image-description.service.ts:447`(delay)、
`tools/invite-to-group.tool.ts:1031`(模块级 function sleep)

另 3 处内联：`main.ts:90`、`infra/queue/bull.module.ts:27`（**带 `.unref()`**）、
`channels/wecom/message/application/image-brand-backfill.service.ts:151`

**改法**：新建 `src/infra/utils/async.util.ts`

```ts
/** 等待指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待指定毫秒，且定时器不阻止进程退出（shutdown / 后台轮询用）。 */
export function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** 指数退避毫秒数：base * 2^(attempt-1)，上限 max。attempt 从 1 起。 */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}
```

统一叫 `sleep`（`delay` 全部改名）。
⚠️ `bull.module.ts:27` 用 `sleepUnref` —— **`.unref()` 不能丢**，丢了会拖住进程退出。

**指数退避** 2 份：`infra/supabase/base.repository.ts:110-114`、`providers/reliable.service.ts:86-98`。
⚠️ **`reliable.service.ts` 的 `Retry-After` 解析与抖动逻辑留在原地**（那是 LLM provider 特有的），
只把 `Math.pow(2, attempt - 1)` 那一行换掉。

**验收**：`pnpm run typecheck && pnpm run test --watchman=false`

---

### A-4 · 前端 `formatPercent` 与日期格式化

**`formatPercent` 5 份，4 份逐字相同**：
`conversion-analysis/list/components/` 下的 `BotComparisonTable/index.tsx:468`、
`CohortFunnel/index.tsx:495`、`HandoffPieChart/index.tsx:112`、`KpiCards/index.tsx:111`
（四者完全相同）、`KpiTrendChart/index.tsx:257`（**不同**：null 返回 `'—'`）。

往 `web/src/utils/format.ts` 加：

```ts
/** 比率 → 百分比文案。null/undefined 返回 nullText（默认 '0.0%'，兼容既有 4 处）。 */
export function formatPercent(value?: number | null, nullText = '0.0%'): string {
  if (value == null) return nullText;
  return `${(value * 100).toFixed(1)}%`;
}
```

`KpiTrendChart` 传 `formatPercent(value, '—')` 保住空值行为。

**日期格式化**：13 个 view 组件绕过 `utils/format.ts` 自己 `toLocale*`
（chat-records ×3、test-suite ×3、system/ExtractionAccuracyCard ×3、
BotComparisonTable、message-processing ×2、reengagement、strategy、users ×2）。

⚠️ **本项只做"收拢到 format.ts"，不要顺手加 `timeZone`**。
现状是前端全部不传 timeZone、跟浏览器时区走，后端全部 `Asia/Shanghai`——
加 timeZone 是行为变更（要评估 Dashboard 是否有海外时区用户），单独提，本次不做。

**验收**：`pnpm run build:web`（web 无单测，构建通过 + 人工看一眼转化页数字即可）

---

## §3 板块 B · 类型跨层重复（624 行）

| 行数 | A | B | 性质 |
|---|---|---|---|
| 178 | `channels/wecom/message/types/storage-message.types.ts:1` | `enums/storage-message.enum.ts:16` | **后端内部** |
| 89 | `biz/conversion-analytics/types/conversion-analytics.types.ts:27` | `web/src/api/types/conversion-analytics.types.ts:16` | 跨前后端 |
| 75 | `biz/strategy/types/strategy.types.ts:3` | `web/src/api/types/strategy.types.ts:1` | 跨前后端 |
| 38 | `biz/candidate-blacklist/entities/candidate-blacklist.entity.ts:5` | `web/src/api/types/candidate-blacklist.types.ts:8` | 跨前后端 |
| 32 | `biz/monitoring/types/analytics.types.ts:159` | `biz/monitoring/types/repository.types.ts:29` | **后端内部** |
| 19 | `biz/strategy/entities/strategy-config.entity.ts:14` | `web/src/api/types/strategy.types.ts:59` | 跨前后端 |
| 18 | `biz/test-suite/dto/conversation-test.dto.ts:73` | `web/src/api/types/agent-test.types.ts:304` | 跨前后端 |
| 18 | `channels/wecom/bot/bot.service.ts:6` | `web/src/api/types/bot.types.ts:1` | 跨前后端 |

**分两类处理，不要一刀切**：

**B-1 后端内部（210 行）—— 直接合并。**
- `storage-message.types.ts` ↔ `enums/storage-message.enum.ts` 178 行：
  判断哪边是权威（enum 在 `src/enums/` 是共享枚举抽屉，倾向以它为准），
  另一边改为 re-export 或直接 import。
- `analytics.types.ts:159` ↔ `repository.types.ts:29` 32 行：同上。

**B-2 跨前后端（239 行）—— 不要合并，加校验。**
`web/` 是独立 Vite 构建，让它 import `src/` 会打破构建边界与分层规则。
正确处理是**保留两份 + 让漂移可被发现**，二选一（执行方按实际情况判断，在报告里说明选了哪个及理由）：

- **方案一（轻，推荐）**：前端类型文件顶部加同源注释
  `// 同源：src/biz/strategy/types/strategy.types.ts —— 改动必须同步`，
  并在 CI 加一条 jscpd 检查，重复率超过当前基线即失败。
- **方案二（重）**：写一个 spec，用字段名集合比对断言两边结构一致。
  只在字段增删时失败，类型细节变化查不出来。

**⚠️ 绝对不要做的**：把后端类型直接 `import type` 进 `web/`。
type-only import 编译后确实会消失，但它会让 `web/tsconfig` 依赖 `src/` 的路径别名，
破坏 web 独立构建，且绕过 `.eslintrc.js` 的分层约束。

**验收**：`pnpm run typecheck && pnpm run build:web`

---

## §4 板块 C · 同文件内自我重复（~500 行，46 处）

典型是"复制一个方法改两行"。按行数排（`:行A ↔ :行B`）：

| 行数 | 文件 | 位置 |
|---|---|---|
| 70 | `biz/test-suite/dto/test-chat.dto.ts` | :740 ↔ :888 |
| 60 | 同上 | :270 ↔ :406 |
| 47 | `biz/test-suite/services/curated-dataset-payload-builder.service.ts` | :152 ↔ :277 |
| 30 | `biz/test-suite/services/curated-dataset-import.service.ts` | :93 ↔ :176 |
| 29 | `biz/test-suite/services/lineage-sync.service.ts` | :216 ↔ :270 |
| 27 | `biz/test-suite/dto/test-chat.dto.ts` | :239 ↔ :340 |
| 24 | `agent/generator/generator.agent.ts` | :116 ↔ :198 |
| 24 | `biz/conversion-analytics/conversion-analytics.service.ts` | :181 ↔ :211 |
| 22 | `curated-dataset-payload-builder.service.ts` | :129 ↔ :254 |
| 21 | `biz/monitoring/repositories/record.repository.ts` | :359 ↔ :419 |
| 20 | `biz/message/repositories/message-processing.repository.ts` | :197 ↔ :283 |
| 20 | `curated-dataset-payload-builder.service.ts` | :224 ↔ :326 |
| 18 | `test-chat.dto.ts` | :807 ↔ :859 |
| 18 | `biz/test-suite/services/test-import.service.ts` | :414 ↔ :491 |
| 16 | `analytics-dashboard.service.ts` | :1413 ↔ :1454 |
| 16 | `biz/test-suite/utils/sse-stream-handler.ts` | :301 ↔ :436 |
| 16 | `channels/wecom/message/telemetry/wecom-message-observability.service.ts` | :468 ↔ :543 |
| 15 | `curated-dataset-import.service.ts` | :52 ↔ :135 |
| 15 | `sponge/sponge.service.ts` | :410 ↔ :657 |
| 15 | `web/src/components/Layout/index.tsx` | :179 ↔ :355 |
| 14×3, 13×5, 12×3, 11×5, 10×3, 9×4 | `test-execution.repository.ts` / `test-import.service.ts` / `reply-workflow.service.ts` / `invite-to-group.tool.ts` / `message-splitter.util.ts` / `duliday-interview-booking.tool.ts` / `conversion-analytics.controller.ts` / `monitoring.controller.ts` / `part-time-job.prompt.ts` / `test-suite.processor.ts` / `render.util.ts` / web 若干 | 完整列表见 jscpd 报告 |

**改法**：抽私有方法/局部函数。**逐个判断，不要机械合并**——
两段相似不等于该合并，如果参数化后需要 3 个以上开关或一个 boolean 参数改变主流程，
说明它们只是长得像，**保持原样并在报告里说明**。

**优先做前 10 项**（占 ~350 行），后面的收益递减。

⚠️ `test-chat.dto.ts` 的 175 行自我重复多半是 Swagger DTO 的重复装饰器块——
先确认合并后 API 文档产物不变，否则跳过。

**验收**：`pnpm run typecheck && pnpm run test --watchman=false`

---

## §5 板块 D · analytics 家族（437 行）

```
biz/monitoring/services/dashboard/analytics-dashboard.service.ts   2186 行  ┐
biz/monitoring/services/dashboard/analytics-query.service.ts        697 行  ├ 互重 297 行
analytics/trends/analytics-trend-builder.service.ts                 193 行  ├ 再重 140 行
analytics/metrics/analytics-metrics.service.ts                       86 行  ┘
```

**克隆明细**：

| 行数 | A | B |
|---|---|---|
| 101 | `analytics-dashboard.service.ts:1955` | `analytics-query.service.ts:472` |
| 48 | `analytics-dashboard.service.ts:2098` | `analytics-query.service.ts:649` |
| 33 | `analytics-dashboard.service.ts:2119` | `analytics-query.service.ts:670` |
| 30 | `analytics-trend-builder.service.ts:64` | `analytics-query.service.ts:623` |
| 23 | `analytics-trend-builder.service.ts:95` | `analytics-dashboard.service.ts:2011` |
| 22 | `analytics-dashboard.service.ts:96` | `analytics-query.service.ts:53` |
| 20 | `analytics-dashboard.service.ts:1298` | `analytics-query.service.ts:383` |
| 20 | `analytics-dashboard.service.ts:1322` | `analytics-query.service.ts:397` |
| 19 | `analytics-metrics.service.ts:7` | `analytics-query.service.ts:456` |
| 18 | `analytics-dashboard.service.ts:1508` | `analytics-query.service.ts:431` |
| 17 | `analytics-trend-builder.service.ts:22` | `analytics-dashboard.service.ts:2043` |
| 16 | `analytics-trend-builder.service.ts:43` | `analytics-query.service.ts:581` |
| 15 | `analytics-dashboard.service.ts:1534` | `analytics-query.service.ts:328` |
| 13 | `analytics-trend-builder.service.ts:124` | `analytics-dashboard.service.ts:2116` |
| 12 | `analytics-metrics.service.ts:51` | `analytics-dashboard.service.ts:1977` |
| 10 | `analytics-metrics.service.ts:76` | `analytics-dashboard.service.ts:2108` |

已实测：`analytics-dashboard.service.ts:1955` 与 `analytics-query.service.ts:472`
**连续 46 行逐字相同**，包含整个 `calculateQueueMetrics` 私有方法。

**改法**：抽到 `src/biz/monitoring/services/dashboard/analytics-calc.util.ts`（纯函数，无 DI），
两边 import。**只做去重，不做拆分**（见下方雷区）。

**⚠️ 分层注意**：`src/analytics/**` 与 `src/biz/monitoring/**` 是两个域。
公共计算函数放哪边要看依赖方向——若只依赖 `MessageProcessingRecord` 这类类型，
放 `src/biz/monitoring/` 下，`src/analytics/` 引它；反向不行。执行前先确认无循环依赖。

**验收（这是本板块的关键，覆盖很好）**：

```bash
pnpm run test tests/biz/monitoring/services/dashboard tests/analytics --watchman=false
```

现有 **2167 行 spec** 精确覆盖被重复的方法：

| spec 断言 | 覆盖的克隆 |
|---|---|
| `should return queue with avgQueueDuration calculated from records` | 101 行克隆的 `calculateQueueMetrics` |
| `should return metrics data with percentiles` / `should filter out records exceeding MAX_DURATION_MS (60s)` | 48 行克隆（百分位，含 `p999`） |
| `should use 24/168/720/1440/2160 hourly stats for X range` | 33 行克隆（趋势窗口） |
| `should limit slowestRecords to top 10` / `should sort slowestRecords by totalDuration descending` | 排序段 |

去重是等价变换，这些断言全绿即通过。**任何一条变红都说明抽错了，回去改代码。**

**⚠️ 不在本次范围**：`analytics-dashboard.service.ts` **2186 行**远超 CLAUDE.md
"超过 ~500 行考虑拆分"的规约。但拆文件是架构决策（拆成几个、边界怎么切），
**不是去重**，且这条链路是生产监控盘数据源（本仓库有过"连接池打爆全线 522"事故史）。
本次**只抽公共计算、不拆文件**。把拆分建议写进报告，单独立项。

---

## §6 板块 E · SCSS（1652 行，66 处克隆）

**好消息：共享层本来就存在，不需要设计。**
`web/src/assets/styles/_variables.scss` 已有 **12 个 mixin**，71 个 `.module.scss` 中
**62 个已 `@use '@/assets/styles/variables'`**。问题是 mixin 采纳率低：

| mixin | 已被 @include 的文件数 |
|---|---|
| `respond-to` | 19 |
| `flex-between` | 10 |
| `card` | 9 |
| `button-primary` / `glass-panel` | 6 |
| `flex-center` | 4 |
| `button-base` / `button-secondary` | 3 |
| `text-ellipsis` | 2 |
| **`custom-scrollbar` / `input-base` / `badge`** | **各 1** |

**主要克隆对**：

| 行数 | A | B |
|---|---|---|
| 187 | `view/users/.../CandidateBlacklist/index.module.scss:61` | `view/users/.../PermanentPause/index.module.scss:64` |
| 80 | `message-processing/.../MessageProcessingTable/index.module.scss:2` | `reengagement/.../ReengagementTable/index.module.scss:2` |
| 56 | `MessageProcessingTable/index.module.scss:11` | `reengagement/.../CandidateTable/index.module.scss:10` |
| 56 | `test-suite/.../ConversationDetailModal/index.module.scss:99` | `test-suite/.../ReviewModal/index.module.scss:172` |
| 55 | `reengagement/.../CandidateTable/index.module.scss:179` | `users/.../UserTable/index.module.scss:143` |
| 47/42/41/29 | `agent-test/.../ChatTester/index.module.scss` | `agent-test/.../MessagePartsAdapter/index.module.scss` 等 |
| 46 | `MessageProcessingDetailDrawer/index.module.scss:15` | `ReengagementDetailDrawer/index.module.scss:4` |
| 41 | `MessageProcessingTable/index.module.scss:107` | `ReengagementTable/index.module.scss:141` |
| 39 | `CandidateBlacklist/index.module.scss:10` | `PermanentPause/index.module.scss:10` |
| 30 | `components/TabSwitch/index.module.scss:64` | `view/test-suite/.../TabSwitch/index.module.scss:66` |

**改法 —— 必须遵守，否则验收手段失效**：

只允许两种动作：
1. 把重复的声明块抽成 `_variables.scss` 里的新 `@mixin`，原处用 `@include` 替换；
2. 直接采纳已有的 12 个 mixin。

**❌ 不允许**：改类名、把类挪到共享 `.module.scss`、调整声明顺序、合并选择器。
CSS Module 的类名哈希由文件路径 + 类名生成，一旦改名，编译产物全变，
下面的 build-diff 验收就完全失效，等于没有任何护栏。

`@include` 必须放在**原声明所在的位置**（mixin 展开是就地插入，位置变了声明顺序就变）。

**⚠️ 特例**：`components/TabSwitch` ↔ `view/test-suite/.../TabSwitch` 是两个同名组件。
这是组件重复不是样式重复，**本次不动**，写进报告建议合并组件。

**验收（无单测，靠编译产物比对）**：

```bash
# 1. 改动前先存基线
pnpm run build:web && cat web/dist/assets/*.css > /tmp/css-before.css

# 2. 改完再 build
pnpm run build:web && cat web/dist/assets/*.css > /tmp/css-after.css

# 3. 比对：必须为空
diff /tmp/css-before.css /tmp/css-after.css
```

`diff` 应当**完全为空**。若非空，逐条确认只是声明顺序差异且无增删；
出现任何类名变化 = 违反了上面的约束，回退重做。

前端零测试（`web/` 无任何 `.test.`/`.spec.` 文件，`package.json` 无 test 脚本），
这个 build-diff 是**唯一的护栏**，不能跳过。

---

## §7 建议的 commit 切分

不要一个 PR 全推。每个 commit 后跑各自的验收，全绿才进下一个。

| # | commit | 板块 | 验收 |
|---|---|---|---|
| 1 | `refactor(utils): asRecord 收拢至 infra/utils/object.util` | A-1 | typecheck + tools/guardrail spec |
| 2 | `refactor(utils): 错误信息提取收拢 + ESLint 防回流` | A-2 | lint + 全量 spec |
| 3 | `refactor(utils): sleep/backoff 收拢至 infra/utils/async.util` | A-3 | typecheck + 全量 spec |
| 4 | `refactor(types): 后端内部类型重复合并 + 跨层同源标注` | B | typecheck + build:web |
| 5 | `refactor: 消除同文件内重复代码块（前 10 项）` | C | 全量 spec |
| 6 | `refactor(analytics): 抽公共计算，消除 4 服务间 437 行重复` | D | dashboard + analytics spec |
| 7 | `refactor(web): formatPercent 与日期格式化收拢` | A-4 | build:web |
| 8 | `style(web): SCSS 重复块收敛为 mixin` | E | **build-diff 必须为空** |

通用验收：

```bash
nvm use 22.16.0 && pnpm run lint:check && pnpm run typecheck && pnpm run test --watchman=false
```

⚠️ `pre-push` 钩子跑全量 CI（5+ 分钟），worktree 里没装 web 依赖会卡 `build:ci`。
**本次不 push**，无需处理。

---

## §8 雷区清单（违反即返工）

1. **`src/resolution/**` 不能 import 新建的任何 util**（只有 `date.util` 例外）。
2. **`hard-requirements.util.ts:23` 的 asRecord 不排除数组是刻意的**，确认无依赖再改，否则跳过。
3. **`bull.module.ts:27` 的 `.unref()` 不能丢**。
4. **`reliable.service.ts` 的 Retry-After / 抖动逻辑不要抽走**，只换幂次那一行。
5. **前端不要顺手加 timeZone**，那是独立的行为变更。
6. **跨前后端的类型不要合并**，不要让 `web/` import `src/`。
7. **SCSS 不许改类名/挪类/调声明顺序**，否则 build-diff 验收失效。
8. **analytics 只抽公共计算，不拆文件**。
9. **同文件重复逐个判断**，参数化后需 3+ 开关或 boolean 改主流程的，保持原样并说明。
10. **不要改测试去迁就重构**。这些都是等价变换，测试变红 = 改错了。
11. **不要统一 `truncate` 系**——13 个命名点里 2 个已是委托壳，其余省略号差异
    （`...` / `…` / `...(truncated)` / `...[truncated N chars]`）都是刻意的，
    最后一个是给 LLM 看的必须带字数。
12. **不要统一时间常量魔数**（`24*60*60*1000` 等 127 处）——多在常量声明处，收益低噪声大。
13. **commit 用 pathspec 限定文件**，不 `git add -A`，不动 stash，不切分支，不 push。

---

## §9 收尾报告必须包含

1. 八个 commit 的 hash 与各自改动文件数。
2. **因避让清单跳过的文件与漏网点清单**（文件 + 剩余处数），供后续单独清扫。
3. **板块 B 选了方案一还是方案二，理由是什么。**
4. **板块 C 里判定"只是长得像、不该合并"的条目及理由。**
5. 板块 E 的 `diff /tmp/css-before.css /tmp/css-after.css` 实际输出（应为空）。
6. 各类别处理前/后的实测计数，**真跑出来，不要凭印象**：

```bash
grep -rnE "instanceof Error \?" --include="*.ts" src | grep -v spec | wc -l
grep -rnE "setTimeout\(resolve" --include="*.ts" src | grep -v spec | wc -l
grep -rnE "function (asRecord|isRecord|isPlainObject)" --include="*.ts" src web/src | grep -v spec | wc -l
npx jscpd src web/src --min-lines 8 --min-tokens 70 --ignore "**/*.spec.ts" --silent
```

最后一条 jscpd 复跑的克隆数/重复行数，与本文档基线（169 处 / 3912 行 / 2.06%）对比，
是本次治理成效的唯一硬指标。
