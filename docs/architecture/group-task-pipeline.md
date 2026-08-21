# 群任务通知流水线

**最后更新**：2026-08-21（对代码核实：调度时刻 / Bull 队列链路 / Redis key / 常量）

群任务定时通知系统，自动向企微群推送业务消息（抢单、兼职岗位、店长通知、工作小贴士）。执行链路是 **Bull 四段队列**（Plan → Prepare → Send → Summarize），调度层只负责触发与入队。

## 流水线概览

```
┌─────────────────────────────────────────────────────┐
│                    Cron 触发（Asia/Shanghai）        │
│  抢单群: 10:00 / 13:00 / 17:30 (每天)               │
│  兼职群: 13:30 (工作日)                              │
│  店长群: 10:30 (工作日)                              │
│  工作小贴士: 15:00 (周六)                            │
└──────────────────────┬──────────────────────────────┘
                       ▼
      GroupTaskSchedulerService.executeTask()  ← API 手动触发同入口
        ├─ enabled 开关（system_config；手动 forceEnabled 可绕过）
        ├─ 非生产环境跳过 Cron（仅手动触发）
        ├─ dryRun / sendDelayMs 冻结进 plan job data（中途改配置不影响本次 exec）
        └─ 入队 PLAN，确定性 jobId 去重：
             cron   → plan:cron:{type}:{分钟级UTC}:{timeSlot}
             manual → plan:manual:{type}:{execId}
                       ▼
┌───────────────── Bull 队列 group-task（GroupTaskProcessor）─────────────────┐
│                                                                            │
│ PLAN（并发 1）                                                              │
│   ├─ GroupResolverService.resolveGroups(tagPrefix)                         │
│   │    遍历小组 token → /stream-api/room/simpleList → labels 解析           │
│   │    10 分钟内存缓存 + stampede 防护；0 群 → 硬告警 + 空汇总               │
│   ├─ strategy.prepareTask()（抢单群：刷新 BI 数据源并等待）                  │
│   ├─ 按 (城市+行业) 分组（抢单群按多地区 scope）                             │
│   ├─ 写 exec 元信息快照（Redis，48h TTL）                                   │
│   ├─ 每分组入队 PREPARE（jobId {execId}:prepare:{groupKey}）                │
│   └─ 按最坏串行发送时长估算 delay，入队 SUMMARIZE                            │
│                                                                            │
│ PREPARE（并发 3，每分组一个）                                                │
│   ├─ strategy.fetchData(代表群)；无数据 → 全组写 skipped 结果               │
│   ├─ 生成消息：buildMessage()（模板）/ buildPrompt() →                      │
│   │    LlmExecutorService.generateSimple() → appendFooter()（兼职群薪资行） │
│   ├─ 消息缓存写 Redis（group-task:msg:{execId}:{groupKey}，48h TTL）        │
│   └─ 每群入队 SEND（jobId {execId}:send:{imRoomId}，                        │
│        delay = globalIndex × sendDelayMs 先做 Bull 层错峰）                 │
│                                                                            │
│ SEND（每群一个，幂等发送）                                                   │
│   ├─ 日内幂等键 group-task:sent:{type}:{YYYYMMDD}[-场次]:{groupId}          │
│   │    （48h TTL；仅成功后写入，失败可重试；跨 exec 生效 → 补发不重发成功群）│
│   ├─ bot 级串行锁 group-task:bot-dispatch-lock:{imBotId}                    │
│   │    （TTL 20 分钟，owner token + Lua 原子释放；Bull named processor 的   │
│   │      concurrency 非 job 名级隔离，同 bot 串行只靠这把锁）+ 锁内复查幂等  │
│   ├─ 跨群间隔：距同 bot 上次发送尝试 ≥ sendDelayMs × 随机 1~2               │
│   │    （基准 120s → 2~4 分钟；跨 exec、跨任务类型统一遵守）                 │
│   ├─ NotificationSenderService：主消息 → 跟随消息（店长群）→                │
│   │    兼职群小程序卡片（40~120s 随机延迟）；dryRun 只发飞书预览             │
│   └─ 成功后：写幂等键 → 品牌轮转（兼职群）→ 写单群结果快照                   │
│                                                                            │
│ SUMMARIZE（延迟触发，并发 1）                                                │
│   ├─ 按 groupIds 回收结果快照，聚合成功/失败/跳过                            │
│   ├─ 飞书卡片汇报；无快照的群标 failed 防静默遗漏                            │
│   └─ 整次零成功 → 硬告警（all_skipped / total_failure）；                   │
│        任一 job 重试耗尽 → {job}_exhausted 告警                             │
└────────────────────────────────────────────────────────────────────────────┘
```

**故障恢复**：所有阶段 job 持久化在 Redis，部署重启/进程崩溃后由 Bull stalled recovery 迁回 waiting 续跑，整次推送不会被部署窗口"腰斩"。旧版"进程内一把 Redis 分布式锁（TTL 5 分钟）+ 同步循环发送"的模型已被本队列链路取代。

## 四种策略

| 类型 | tagPrefix | 策略类 | 数据源 | 生成方式 |
|------|-----------|--------|--------|----------|
| 抢单群 | `抢单群` | `OrderGrabStrategy` | 观远 BI 订单（按场次定日期范围） | 模板 |
| 兼职群 | `兼职群` | `PartTimeJobStrategy` | 海绵岗位列表（品牌轮转） | AI 润色 + 薪资行兜底 + 小程序卡片 |
| 店长群 | `店长群` | `StoreManagerStrategy` | 海绵面试名单（固定品牌） | 模板（含跟随消息） |
| 工作小贴士 | `兼职群` | `WorkTipsStrategy` | 无（ISO 周数作提示词种子） | AI 生成 |

抢单群场次日期范围：上午场=当天（且只发最早开工 ≥10:30 的单）/ 下午场=次日（无单逐天顺延到本周日）/ 晚上场=本周六~周日。

## 关键机制

### 确定性 jobId 去重

plan 层 cron 触发按"类型+分钟级 UTC+场次"生成 jobId，同分钟重复触发返回已存在 job；prepare/send 按 `{execId}:prepare:{groupKey}` / `{execId}:send:{imRoomId}`，重试与重复入队天然幂等。

### 日内发送幂等（48h）

send 成功后写 `group-task:sent:{type}:{date}[-场次]:{groupId}`（TTL 48h）：同群当日同场次不重发，跨 exec 生效——手动补发（retry）只会触达失败群。

### bot 级串行 + 人类化间隔

同一企微 bot 的群发由 Redis 锁串行；跨群间隔以 `GROUP_TASK_SEND_DELAY_MS`（120s）为基准随机 1~2 倍（2~4 分钟），间隔基点是"上次发送尝试结束时间"，失败重试不与下一群叠加。

### 分组共享

同城市同行业的群只拉一次数据、生成一次文案，N 群复用（消息缓存在 Redis 由各 send job 读取）。例如 5 个"兼职群_上海_餐饮"只生成一次消息文本，发 5 个群。

### dryRun 模式

DB 开关控制（`system_config` 表），入队时冻结进 job data；试运行只发飞书预览不发企微。手动触发时可通过 `forceSend` 绕过。

### 环境隔离

非生产环境自动禁用 Cron，仅支持手动触发。

### 品牌轮转（兼职群）

`BrandRotationService` 记录每个群已推送品牌（Redis `group-task:brand-history:{groupId}`，TTL 7 天），下次推送轮转到新品牌。

## 管理端点

```bash
POST /group-task/trigger/:type   # 入 plan 队列，立即返回 execId
POST /group-task/retry/:type     # 失败 send job 整体重试（幂等键防重发成功群）
GET  /group-task/status/:type    # 队列计数 + 失败 send 明细（排障）
POST /group-task/test-send       # 单群同步测试（不走 Bull；默认 dryRun，forceSend 真发）
# type: order_grab | part_time | store_manager | work_tips
```

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/biz/group-task/services/group-task-scheduler.service.ts` | Cron 调度 + 配置闸门 + plan 入队 |
| `src/biz/group-task/queue/group-task.processor.ts` | 四段队列 worker（Plan/Prepare/Send/Summarize） |
| `src/biz/group-task/queue/group-task-queue.constants.ts` | 队列名 / Job payload / Redis key / TTL 常量 |
| `src/biz/group-task/services/group-task-admin.service.ts` | trigger/retry/status/test-send 实现 |
| `src/biz/group-task/services/group-resolver.service.ts` | 群列表获取 + 标签解析 + 缓存 |
| `src/biz/group-task/services/notification-sender.service.ts` | 企业级发送 + 小程序卡片 + 飞书汇报 |
| `src/biz/group-task/services/brand-rotation.service.ts` | 品牌轮转记录 |
| `src/biz/group-task/providers/group-channel.provider.ts` | 企微能力域内抽象（依赖倒置注入令牌） |
| `src/biz/group-task/utils/humanized-delay.util.ts` | 人类化随机延时 |
| `src/biz/group-task/strategies/*.strategy.ts` | 四种策略实现 |
| `src/biz/group-task/group-task.controller.ts` | 管理端点 |
| `src/biz/group-task/group-task.types.ts` | 类型定义 |

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GROUP_TASK_TOKENS` | - | 小组 token 映射（格式: `名称:token,名称:token`） |
| `GROUP_TASK_SEND_DELAY_MS` | `120000` | 不同群间最小间隔（实际随机 1~2x，即 2~4 分钟）；兼职群小程序卡片在文案后随机等待 40~120 秒 |
| `GROUP_MEMBER_LIMIT` | `200` | 群成员上限（invite_to_group 容量判断） |
| `STRIDE_ENTERPRISE_TOKEN` | - | 企业级 API token（拉人进群用） |
| `MINIPROGRAM_APPID` | - | 小程序 appid（兼职群卡片） |
| `MINIPROGRAM_USERNAME` | - | 小程序 username |
| `MINIPROGRAM_THUMB_URL` | - | 小程序封面图 URL |
