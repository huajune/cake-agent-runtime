# 群任务定时通知系统

群任务模块负责定时向企业微信群推送业务通知，涵盖抢单、兼职岗位、面试名单、工作小贴士四种场景。

> 架构细节参见 [群任务通知流水线](../architecture/group-task-pipeline.md)

---

## 目录

- [整体架构](#整体架构)
- [任务类型与调度表](#任务类型与调度表)
- [核心流程（Bull 四段队列）](#核心流程bull-四段队列)
- [策略详解](#策略详解)
  - [抢单群（ORDER_GRAB）](#抢单群order_grab)
  - [兼职群（PART_TIME_JOB）](#兼职群part_time_job)
  - [店长群（STORE_MANAGER）](#店长群store_manager)
  - [工作小贴士（WORK_TIPS）](#工作小贴士work_tips)
- [场次机制（抢单群）](#场次机制抢单群)
- [群标签与分组规则](#群标签与分组规则)
- [配置管理](#配置管理)
- [运维操作](#运维操作)
- [数据流图](#数据流图)

---

## 整体架构

```
src/biz/group-task/
├── group-task.module.ts              # 模块注册（含 Bull 队列注册）
├── group-task.controller.ts          # 管理端点：trigger / retry / status / test-send
├── group-task.types.ts               # 类型定义
├── queue/
│   ├── group-task-queue.constants.ts # 队列名、四类 Job payload、Redis key、TTL 常量
│   └── group-task.processor.ts       # Plan / Prepare / Send / Summarize worker
├── providers/
│   └── group-channel.provider.ts     # 企微能力域内抽象（GROUP_ROOM_QUERY / GROUP_MESSAGE_SENDER
│                                     #   注入令牌，依赖倒置：biz/ 不 import channels/wecom）
├── services/
│   ├── group-task-scheduler.service.ts   # Cron 触发 + 配置闸门 + plan 入队
│   ├── group-task-admin.service.ts       # trigger/retry/status/test-send 实现
│   ├── group-resolver.service.ts         # 群列表获取 & 标签解析（10 分钟缓存）
│   ├── group-membership.service.ts       # 实时群成员关系（invite_to_group 共用）
│   ├── notification-sender.service.ts    # 企业级消息发送 & 小程序卡片 & 飞书通知
│   └── brand-rotation.service.ts         # 品牌轮转（兼职群专用，Redis 7 天 TTL）
├── strategies/
│   ├── notification.strategy.ts          # 策略接口
│   ├── order-grab.strategy.ts            # 抢单群策略
│   ├── part-time-job.strategy.ts         # 兼职群策略
│   ├── store-manager.strategy.ts         # 店长群策略
│   └── work-tips.strategy.ts             # 工作小贴士策略
├── prompts/
│   ├── order-grab.prompt.ts              # 抢单群模板
│   ├── part-time-job.prompt.ts           # 兼职群 AI Prompt + 薪资行兜底
│   ├── store-manager.prompt.ts           # 店长群模板（含跟随消息）
│   └── work-tips.prompt.ts               # 工作小贴士 AI Prompt
└── utils/
    └── humanized-delay.util.ts           # 人类化随机延时（跨群间隔 / 小程序卡片延迟）
```

**设计模式**：策略模式定义四种通知内容（`NotificationStrategy`）；执行链路由 Bull 队列驱动（`GroupTaskProcessor`），`GroupTaskSchedulerService` 只负责触发与入队。

---

## 任务类型与调度表

| 任务类型 | 标签前缀 | Cron 表达式 | 触发时间 | 触发周期 | 生成方式 |
|---------|---------|------------|---------|---------|---------|
| 抢单群 `ORDER_GRAB` | `抢单群` | `0 10 * * *` | 10:00（上午场） | 每天 | 纯模板 |
| 抢单群 `ORDER_GRAB` | `抢单群` | `0 13 * * *` | 13:00（下午场） | 每天 | 纯模板 |
| 抢单群 `ORDER_GRAB` | `抢单群` | `30 17 * * *` | 17:30（晚上场） | 每天 | 纯模板 |
| 兼职群 `PART_TIME_JOB` | `兼职群` | `30 13 * * 1-5` | **13:30** | 工作日 | 数据 + AI 润色 |
| 店长群 `STORE_MANAGER` | `店长群` | `30 10 * * 1-5` | 10:30 | 工作日 | 纯模板 |
| 工作小贴士 `WORK_TIPS` | `兼职群` | `0 15 * * 6` | 15:00 | 每周六 | 纯 AI 生成 |

> 所有 Cron 时区为 `Asia/Shanghai`。非生产环境 Cron 自动禁用，仅支持手动触发。

---

## 核心流程（Bull 四段队列）

发送过程全部由 Bull 队列 `group-task` 驱动，拆成四类 Job：**Plan → Prepare → Send → Summarize**。任何阶段进程崩溃/部署重启，未完成 job 仍在 Redis，Bull stalled recovery 迁回 waiting，新进程起来自动续跑——整次推送不会在部署窗口被"腰斩"。

```
Cron / API 手动触发（GroupTaskSchedulerService）
  ├── 配置闸门：enabled 开关（system_config；手动 forceEnabled 可绕过）
  ├── dryRun / sendDelayMs 在入队时决定并【冻结进 plan job data】
  │     —— 中途改配置不影响正在执行的 exec
  └── 入队 Plan job，确定性 jobId 去重：
        cron   → plan:cron:{type}:{分钟级UTC}:{timeSlot}（同分钟重复触发被去重）
        manual → plan:manual:{type}:{execId}
        ↓
【Plan】（并发 1）
  ├── GroupResolverService.resolveGroups(tagPrefix)（10 分钟缓存 + stampede 防护）
  │     0 个群 → 飞书告警（token 失效/标签被抹是历史真实事故）+ 空汇总
  ├── strategy.prepareTask()（抢单群：刷新 BI 数据源并等待）
  ├── 按 (城市+行业) 分组（抢单群按多地区 scope 分组）
  ├── 写 exec 元信息快照到 Redis（48h TTL）
  ├── 每分组入队 Prepare job（jobId: {execId}:prepare:{groupKey}，attempts 3）
  └── 按最坏串行发送时长估算 delay，入队 Summarize job
        —— 估早了会把发送中的群误报"未收到结果"
        ↓
【Prepare】（并发 3，每分组一个）
  ├── strategy.fetchData(代表群)（无数据 → 全组写 skipped 结果）
  ├── 生成消息：模板策略 buildMessage() / AI 策略 buildPrompt()
  │     → LlmExecutorService.generateSimple() → appendFooter()（兼职群薪资行兜底）
  ├── 消息缓存写 Redis（48h TTL，同组群共享一份文案）
  └── 每群入队 Send job（jobId: {execId}:send:{imRoomId}，
        delay = globalIndex × sendDelayMs 先做 Bull 层错峰）
        ↓
【Send】（每群一个，幂等发送）
  ├── 日内幂等键 group-task:sent:{type}:{YYYYMMDD}[-场次]:{groupId}（48h TTL）
  │     已存在 → skipped。幂等键只在发送成功后写入，失败留白可重试；
  │     跨 exec 有效 —— 手动补发不会对当日已成功的群二次发送
  ├── bot 级串行锁 group-task:bot-dispatch-lock:{imBotId}（TTL 20 分钟，
  │     owner token + Lua 原子释放）。Bull named processor 的 concurrency 不是
  │     job 名级隔离，同 bot 真正串行只由这把 Redis 锁保证；锁内复查幂等键
  ├── 跨群间隔：距同 bot 上次发送尝试 ≥ sendDelayMs × 随机 1~2
  │     （基准 120s → 实际 2~4 分钟，跨 exec、跨任务类型统一遵守）
  ├── 发送：主消息 → 跟随消息（如店长群）→ 兼职群小程序卡片（40~120s 随机延迟）
  │     dryRun：只发飞书预览，不发企微
  └── 成功后：写幂等键 → 记品牌轮转（兼职群）→ 写单群结果快照
        ↓
【Summarize】（延迟触发）
  ├── 按 groupIds 回收各群结果快照，聚合成功/失败/跳过
  ├── 飞书卡片汇报（🟢 全部成功 / 🟡 部分失败 / 🔴 全部失败）
  ├── 无结果快照的群标记 failed，避免静默遗漏
  └── 整次 exec 零成功（全失败或全跳过）→ 硬告警（飞书汇总之外的第二重保险；
        任一 job 重试耗尽也单独告警）
```

---

## 策略详解

### 抢单群（ORDER_GRAB）

- **数据源**：观远 BI（`SpongeService.fetchBIOrders`，任务开始前先刷新 BI 数据源）
- **查询范围**：按场次决定订单日期范围（见[场次机制](#场次机制抢单群)），按"实际城市 + 所属企业"查询（多地区群合并多城市并去重），只取待接单状态
- **生成方式**：纯模板拼装，不需要 AI
- **去重规则**：按门店去重，每个门店保留收入最高的订单
- **展示数量**：每次最多展示 4 条订单

**消息格式示例**：
```
🍕【上海】早间好单推荐~

💰预计收入：¥380
📍地点：塔可贝尔（人民广场店）
📋内容：餐饮服务
📅日期：2026-03-27
⏰时间：11:00 ~ 14:00
🔗报名链接：https://...

🍕可直接通过上面的链接进入【独立客小程序】查看更多上海区域订单~
❗有任何问题可随时联系沟通哦~
```

（标题按场次/订单特征动态选择：明日单、周末单、特定地区单各有专属标题；部分城市 footer 带群内联系人指引。）

### 兼职群（PART_TIME_JOB）

- **数据源**：海绵招聘数据库（`SpongeService.fetchJobs`，含薪资/福利/工作时段）
- **生成方式**：真实数据 + AI 排版润色，`appendFooter` 对 AI 产出做薪资行确定性兜底（`enforcePartTimeSalaryLine`）
- **品牌轮转**：同一群 7 天内不推相同品牌（Redis 记录推送历史，`BrandRotationService`）
- **行业过滤**：按 `jobCategoryName` 层级类目解析一级行业（餐饮/零售），匹配群标签
- **附加内容**：文本消息发送后，随机等待 40~120 秒再发独立客找工作小程序卡片

**AI 排版规则**：
- 根据门店数量自动选择展示模式（独立展示 / 统一薪资 / 区域分组），最多展示 15 家门店
- 严禁编造福利，保留真实门店名
- 总字数不超过 800 字

### 店长群（STORE_MANAGER）

- **数据源**：海绵面试名单（`SpongeService.fetchInterviewSchedule`）
- **生成方式**：纯模板
- **查询范围**：当天面试列表，固定品牌「成都你六姐」（硬编码于 `store-manager.strategy.ts`）
- **特殊逻辑**：即使无面试也发送"今日无面试安排"；模板可产出跟随消息（`followUpMessage`），随消息缓存进 Redis、主消息发完后单独发送

### 工作小贴士（WORK_TIPS）

- **数据源**：无（纯 AI 生成）
- **生成方式**：纯 AI
- **触发频率**：每周六 15:00，发送到所有兼职群
- **内容种子**：把 ISO 周数写进提示词作主题提示，**降低同周主题漂移（非硬保证）**——各 city+industry 分组独立生成，同周不同分组文案可能不同
- **内容方向**：安全提醒、职场礼仪、效率技巧等（7 个方向轮换）

---

## 场次机制（抢单群）

抢单群每天发送 3 次，每场**查询的订单日期范围**与**选单逻辑**都不同：

| 场次 | 订单日期范围 | 选单逻辑 | 附加规则 |
|------|-------------|---------|---------|
| 上午场 `MORNING` | **当天** | 收入最高的前 4 条 | 只发最早开工时间 **≥ 10:30** 的订单（已开工/即将开工的不推） |
| 下午场 `AFTERNOON` | **次日** | 收入排名第 5~8 条（不足时从头部补齐） | 次日无单时**逐天顺延**到本周日，取最近有单的一天 |
| 晚上场 `EVENING` | **本周六~周日** | 按日期最近排序前 4 条 | 以「即将到来的周末」为维度 |
| 手动无场次 | 今天 → 本周日 | 收入最高前 4 条 | 兜底行为，保留手动触发语义 |

---

## 群标签与分组规则

企业微信群通过标签标识类型和区域，标签解析规则：

```
标签 1（类型）  标签 2（城市）  标签 3（行业，可选）
   抢单群         上海
   兼职群         北京          餐饮
   店长群         广州
```

- 多地区抢单群支持多个地区标签（如 [抢单群, 景德镇, 上饶]）
- 兼职群容错：第二标签是行业词（餐饮/零售）且存在第三标签时，按 [类型, 行业, 城市] 换序解析

**分组逻辑**：同城市 + 同行业的群视为一组，共享数据和文案。

示例：5 个 `兼职群_上海_餐饮` → 一组 → 拉 1 次数据 → 生成 1 次文案 → 发 5 个群（发送仍按群逐个排队、独立幂等）。

---

## 配置管理

### 运行时配置（Supabase）

配置存储在 `system_config` 表，key 为 `group_task_config`，由 `SystemConfigService` 管理：

```json
{
  "enabled": true,
  "dryRun": false
}
```

代码默认值（`DEFAULT_GROUP_TASK_CONFIG`）：`enabled: false, dryRun: true`

> `dryRun` 与 `sendDelayMs` 在 plan 入队时**冻结**进 job data：一次 exec 内配置一致，中途改配置只影响下一次触发。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GROUP_TASK_TOKENS` | - | 小组 token 映射（格式: `名称:token,名称:token`） |
| `GROUP_TASK_SEND_DELAY_MS` | `120000` | 不同群间最小间隔（实际随机 1~2x，即 2~4 分钟）；兼职群小程序卡片在文案后随机等待 40~120 秒 |
| `MINIPROGRAM_APPID` | - | 小程序 appid（兼职群卡片） |
| `MINIPROGRAM_USERNAME` | - | 小程序 username |
| `MINIPROGRAM_THUMB_URL` | - | 小程序封面图 URL |

### 前端管理面板

在配置页面的「群任务通知」标签页中可以：
- 切换定时任务开关（enabled）
- 切换试运行模式（dryRun）
- 手动触发任意任务类型

---

## 运维操作

### 管理端点

（`GroupTaskController`，均需 API token；type 取值 `order_grab | part_time | store_manager | work_tips`）

```bash
# 手动触发：入 plan 队列后立即返回 execId（forceEnabled 绕过 enabled 开关，仍遵守 dryRun）
curl -X POST http://localhost:8585/group-task/trigger/order_grab

# 补发：把该类型下 failed 的 send job 整体 retry 一遍
# 日内幂等键保证已成功的群不会被重发，失败群走新一轮 attempts + backoff
curl -X POST http://localhost:8585/group-task/retry/part_time

# 队列状态：waiting/active/delayed/failed/completed 计数 + 失败 send 的群名与原因
# 供 dashboard 判断"今天发到哪一步了 / 还有多少待发"
curl http://localhost:8585/group-task/status/part_time

# 单群测试：按群名定位目标群，同步跑完整策略流程（fetchData → 生成 → 发送），不走 Bull
# 默认 dryRun（飞书预览）；forceSend: true 真实发送
curl -X POST http://localhost:8585/group-task/test-send \
  -H "Content-Type: application/json" \
  -d '{"type": "part_time", "groupName": "上海餐饮群", "city": "上海", "industry": "餐饮"}'
```

### 配置切换

```bash
# 通过前端面板：配置页面 → 群任务通知 → 切换开关

# 通过 API
curl -X POST http://localhost:8585/config/group-task-config \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "dryRun": false}'
```

### 试运行 → 生产切换

1. 先开启 `enabled = true`，保持 `dryRun = true`
2. 观察飞书预览消息，确认内容正确
3. 确认无误后，切换 `dryRun = false` 进入生产模式

### 告警清单

| 告警 | 触发条件 |
|------|---------|
| `group_task.no_groups_resolved` | resolveGroups 返回 0 个群（token 失效/标签被抹/缓存污染） |
| `group_task.{plan\|prepare\|send\|summarize}_exhausted` | 任一 job 重试耗尽 |
| `group_task.all_skipped` / `group_task.total_failure` | 整次 exec 零成功（非 dryRun） |
| `group_task.summary_failed` | 飞书汇总上报失败 |

---

## 数据流图

```
┌─────────────┐    ┌────────────────┐    ┌─────────────────────────────┐
│  Cron 调度   │───▶│ Scheduler 入队  │───▶│  Bull 队列 group-task        │
│  / API 触发  │    │ (配置冻结+去重) │    │  Plan→Prepare→Send→Summarize │
└─────────────┘    └────────────────┘    └──────────┬──────────────────┘
                                                    │
                            ┌───────────────────────┼─────────────┐
                            ▼                       ▼             ▼
                     ┌──────────┐            ┌──────────┐  ┌──────────┐
                     │ 观远 BI  │            │  海绵 DB  │  │  AI 生成  │
                     │ (抢单群)  │            │(兼职/店长)│  │ (小贴士)  │
                     └────┬─────┘            └────┬─────┘  └────┬─────┘
                          └───────────────────────┴─────────────┘
                                             │
                                             ▼
                              ┌──────────────────────────┐
                              │  NotificationSender      │
                              │ （Send job 内，bot 锁串行）│
                              ├──────────┬───────────────┤
                              ▼          ▼               ▼
                         ┌────────┐ ┌────────┐     ┌────────┐
                         │企微群   │ │飞书预览 │     │飞书报告 │
                         │(生产)   │ │(dryRun) │     │(汇总)   │
                         └────────┘ └────────┘     └────────┘
```

---

## 外部依赖

| 服务 | 用途 | 模块 |
|------|------|------|
| **SpongeService** | 拉取 BI 订单、兼职岗位、面试安排 | `@sponge` |
| **LlmExecutorService** | AI 文案生成 | `@/llm` |
| **GROUP_MESSAGE_SENDER**（`MessageSenderService` 实现） | 企业级群消息发送 + 小程序卡片 | `providers/group-channel.provider.ts` |
| **FeishuWebhookService** | 飞书通知（预览 + 结果报告） | `@infra/feishu` |
| **GROUP_ROOM_QUERY**（`RoomService` 实现） | 企微群列表获取 | `providers/group-channel.provider.ts` |
| **RedisService** | Bull 队列 + 幂等键 + bot 串行锁 + 消息/结果缓存 + 品牌轮转历史（7 天 TTL） | `@infra/redis` |
| **SystemConfigService** | 运行时配置持久化（enabled/dryRun） | `@biz/hosting-config` |
| **IncidentReporterService** | 队列失败/零成功硬告警 | `@observability` |
