# 群任务定时通知系统

群任务模块负责定时向企业微信群推送业务通知，涵盖抢单、兼职岗位、面试名单、工作小贴士四种场景。

---

## 目录

- [整体架构](#整体架构)
- [任务类型与调度表](#任务类型与调度表)
- [核心流程](#核心流程)
- [策略详解](#策略详解)
  - [抢单群（ORDER_GRAB）](#抢单群order_grab)
  - [兼职群（PART_TIME_JOB）](#兼职群part_time_job)
  - [店长群（STORE_MANAGER）](#店长群store_manager)
  - [工作小贴士（WORK_TIPS）](#工作小贴士work_tips)
- [场次去重机制](#场次去重机制)
- [群标签与分组规则](#群标签与分组规则)
- [配置管理](#配置管理)
- [运维操作](#运维操作)
- [数据流图](#数据流图)

---

## 整体架构

```
src/biz/group-task/
├── group-task.module.ts              # 模块注册
├── group-task.controller.ts          # 手动触发 API
├── group-task.types.ts               # 类型定义
├── services/
│   ├── group-task-scheduler.service.ts   # 调度编排（Cron + 流程控制）
│   ├── group-resolver.service.ts         # 群列表获取 & 标签解析
│   ├── notification-sender.service.ts    # 消息发送 & 飞书通知
│   └── brand-rotation.service.ts         # 品牌轮转（兼职群专用）
├── strategies/
│   ├── notification.strategy.ts          # 策略接口
│   ├── order-grab.strategy.ts            # 抢单群策略
│   ├── part-time-job.strategy.ts         # 兼职群策略
│   ├── store-manager.strategy.ts         # 店长群策略
│   └── work-tips.strategy.ts             # 工作小贴士策略
└── prompts/
    ├── order-grab.prompt.ts              # 抢单群模板
    ├── part-time-job.prompt.ts           # 兼职群 AI Prompt
    ├── store-manager.prompt.ts           # 店长群模板
    └── work-tips.prompt.ts              # 工作小贴士 AI Prompt
```

**设计模式**：策略模式（Strategy Pattern）— 四种通知类型各自实现 `NotificationStrategy` 接口，由 `GroupTaskSchedulerService` 统一编排。

---

## 任务类型与调度表

| 任务类型 | 标签前缀 | Cron 表达式 | 触发时间 | 触发周期 | 生成方式 |
|---------|---------|------------|---------|---------|---------|
| 抢单群 `ORDER_GRAB` | `抢单群` | `0 10 * * *` | 10:00（上午场） | 每天 | 纯模板 |
| 抢单群 `ORDER_GRAB` | `抢单群` | `0 13 * * *` | 13:00（下午场） | 每天 | 纯模板 |
| 抢单群 `ORDER_GRAB` | `抢单群` | `30 17 * * *` | 17:30（晚上场） | 每天 | 纯模板 |
| 兼职群 `PART_TIME_JOB` | `兼职群` | `0 13 * * 1-5` | 13:00 | 工作日 | 数据 + AI 润色 |
| 店长群 `STORE_MANAGER` | `店长群` | `30 10 * * 1-5` | 10:30 | 工作日 | 纯模板 |
| 工作小贴士 `WORK_TIPS` | `兼职群` | `0 15 * * 6` | 15:00 | 每周六 | 纯 AI 生成 |

> 所有 Cron 时区为 `Asia/Shanghai`。

---

## 核心流程

```
Cron 定时触发 / API 手动触发
        ↓
1. 检查 enabled 开关
        ↓
2. GroupResolverService 获取群列表
   ├── 调用小组级 API 拉取带标签的群
   ├── 按标签前缀过滤目标群
   └── 10 分钟内存缓存（避免频繁调用 API）
        ↓
3. 按 (城市 + 行业) 分组
   └── 同组群共享数据和文案，减少 API 和 AI 调用
        ↓
4. 逐组处理
   ├── Strategy.fetchData() — 从数据源拉取业务数据
   ├── 判断是否有数据（无数据 → 跳过）
   ├── 生成消息
   │   ├── 模板策略 → buildMessage()
   │   └── AI 策略 → buildPrompt() → CompletionService → appendFooter()
   └── 同组所有群发送相同消息（群间间隔 2s）
        ↓
5. 飞书通知执行结果
   ├── 🟢 全部成功
   ├── 🟡 部分失败
   └── 🔴 全部失败
```

---

## 策略详解

### 抢单群（ORDER_GRAB）

- **数据源**：观远BI（`SpongeService.fetchBIOrders`）
- **查询范围**：今天 → 本周日，按城市筛选
- **生成方式**：纯模板拼装，不需要 AI
- **去重规则**：按门店去重，每个门店保留收入最高的订单
- **展示数量**：每次最多展示 4 条订单

**消息格式示例**：
```
🍕【上海】早间好单推荐~

预计收入：¥380
📍 地点：塔可贝尔（人民广场店）
📝 内容：餐饮服务
📅 日期：2026-03-27
⏰ 时间：11:00-14:00
🔗 https://...

预计收入：¥320
📍 地点：...

🍕可直接通过上面的链接进入【独立客小程序】查看更多上海区域订单~
❗有任何问题可随时联系沟通哦~
```

### 兼职群（PART_TIME_JOB）

- **数据源**：海绵招聘数据库（`SpongeService.fetchJobs`）
- **生成方式**：真实数据 + AI 排版润色
- **品牌轮转**：同一群 7 天内不推相同品牌（Redis 记录推送历史）
- **行业过滤**：根据群标签区分餐饮/零售
- **附加内容**：消息末尾固定追加报名指引 + 小程序卡片

**AI 排版规则**：
- 根据门店数量自动选择展示模式（独立展示 / 统一薪资 / 区域分组）
- 严禁编造福利，保留真实门店名
- 总字数不超过 800 字

### 店长群（STORE_MANAGER）

- **数据源**：面试安排（`SpongeService.fetchInterviewSchedule`）
- **生成方式**：纯模板
- **查询范围**：当天面试列表，按城市筛选
- **特殊逻辑**：即使无面试也发送"今日无面试安排"

### 工作小贴士（WORK_TIPS）

- **数据源**：无（纯 AI 生成）
- **生成方式**：纯 AI
- **触发频率**：每周六 15:00，发送到所有兼职群
- **内容种子**：ISO 周数（确保同一周所有群收到相同内容）
- **内容方向**：安全提醒、职场礼仪、效率技巧等（7 个方向轮换）

---

## 场次去重机制

抢单群每天发送 3 次（上午/下午/晚上），通过 `TimeSlot` 机制保证每次内容不同：

| 场次 | 选单逻辑 | 标题风格 |
|------|---------|---------|
| 上午场 `MORNING` | 收入最高的前 4 条 | `🍕【城市】早间好单推荐~` |
| 下午场 `AFTERNOON` | 收入排名第 5~8 条 | `🍕【城市】午间新单上架~` |
| 晚上场 `EVENING` | 按日期最近排序前 4 条 | `🍕【城市】晚间急单速抢！` |

> 当订单总数不足时，下午场自动兜底取剩余订单；晚上场以「即将到来」为优先维度，展示时间最近的订单。

---

## 群标签与分组规则

企业微信群通过标签标识类型和区域，标签解析规则：

```
标签 1（类型）  标签 2（城市）  标签 3（行业，可选）
   抢单群         上海
   兼职群         北京          餐饮
   店长群         广州
```

**分组逻辑**：同城市 + 同行业的群视为一组，共享数据和文案。

示例：5 个 `兼职群_上海_餐饮` → 一组 → 拉 1 次数据 → 生成 1 次文案 → 发 5 个群。

---

## 配置管理

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_GROUP_TASK` | `false` | 总开关，开启后 Cron 任务才会执行 |
| `GROUP_TASK_DRY_RUN` | `true` | 试运行模式，消息只发飞书预览 |
| `GROUP_TASK_SEND_DELAY_MS` | `2000` | 群间发送间隔（毫秒） |

### 运行时配置（Supabase）

配置存储在 `system_config` 表，key 为 `group_task_config`：

```json
{
  "enabled": true,
  "dryRun": false
}
```

**优先级**：Supabase 存储值 > 环境变量默认值 > 代码默认值

### 前端管理面板

在配置页面的「群任务通知」标签页中可以：
- 切换定时任务开关（enabled）
- 切换试运行模式（dryRun）
- 手动触发任意任务类型

---

## 运维操作

### 手动触发

```bash
# 触发抢单群通知
curl -X POST http://localhost:8080/group-task/trigger/order_grab

# 触发兼职群通知
curl -X POST http://localhost:8080/group-task/trigger/part_time

# 触发店长群通知
curl -X POST http://localhost:8080/group-task/trigger/store_manager

# 触发工作小贴士
curl -X POST http://localhost:8080/group-task/trigger/work_tips
```

### 配置切换

```bash
# 通过前端面板
# 配置页面 → 群任务通知 → 切换开关

# 通过 API
curl -X POST http://localhost:8080/config/group-task-config \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "dryRun": false}'
```

### 试运行 → 生产切换

1. 先开启 `enabled = true`，保持 `dryRun = true`
2. 观察飞书预览消息，确认内容正确
3. 确认无误后，切换 `dryRun = false` 进入生产模式

---

## 数据流图

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Cron 调度   │────▶│  Scheduler 编排   │────▶│  GroupResolver   │
│  / API 触发  │     │                  │     │  获取目标群列表   │
└─────────────┘     └──────┬───────────┘     └──────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ 观远 BI  │  │  海绵 DB  │  │  AI 生成  │
      │ (抢单群)  │  │ (兼职群)  │  │(小贴士)   │
      └────┬─────┘  └────┬─────┘  └────┬─────┘
           │              │              │
           └──────────────┴──────────────┘
                          │
                          ▼
              ┌──────────────────────┐
              │  NotificationSender  │
              ├──────────┬───────────┤
              │          │           │
              ▼          ▼           ▼
         ┌────────┐ ┌────────┐ ┌────────┐
         │企微群   │ │飞书预览 │ │飞书报告 │
         │(生产)   │ │(试运行) │ │(结果)   │
         └────────┘ └────────┘ └────────┘
```

---

## 外部依赖

| 服务 | 用途 | 模块 |
|------|------|------|
| **SpongeService** | 拉取 BI 订单、兼职岗位、面试安排 | `@sponge` |
| **CompletionService** | AI 文案生成 | `@agent` |
| **MessageSenderService** | 企微群消息发送（小组级 API） | `@channels/wecom` |
| **FeishuWebhookService** | 飞书通知（预览 + 结果报告） | `@infra/feishu` |
| **RoomService** | 企微群列表获取 | `@channels/wecom/room` |
| **Redis** | 品牌轮转历史（7 天 TTL） | `@infra/redis` |
| **Supabase** | 运行时配置持久化 | `@infra/supabase` |
