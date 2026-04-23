# 监控系统架构设计

> Cake Agent Runtime - 监控数据采集、投影与查询架构

**最后更新**：2026-04-23

---

## 目录

1. [架构概览](#架构概览)
2. [存储策略](#存储策略)
3. [数据流详解](#数据流详解)
4. [服务组件](#服务组件)
5. [前端调用链路](#前端调用链路)
6. [数据结构定义](#数据结构定义)
7. [定时任务](#定时任务)
8. [故障恢复](#故障恢复)
9. [性能与成本](#性能与成本)

---

## 架构概览

监控模块已上移至业务层 [src/biz/monitoring/](../../src/biz/monitoring/)，采用
**「Supabase 为真 + 预聚合投影 + Redis 实时计数」** 的三段式结构。不再依赖进程内内存缓存作为主数据源，
服务重启不会丢失可观测数据。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              数据产生层                                      │
│         WeComMessagePipeline / MessageProcessor.runtime 触发                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   采集写入层 (services/tracking)                             │
│                                                                             │
│   ├── MessageTrackingService                                                │
│   │     recordMessageReceived → upsert message_processing_records (processing)
│   │     recordSuccess / recordFailure → 还原终态记录并 upsert                │
│   │                                                                         │
│   └── MonitoringCacheService                                                │
│         Redis: monitoring:active_requests / :peak_active_requests            │
│         进程内 MonitoringGlobalCounters（只在本实例累计，非权威）             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Supabase 事实表 (SoT)                                 │
│                                                                             │
│   ├── message_processing_records  每条请求生命周期 + agent_invocation        │
│   ├── monitoring_error_logs       失败快照                                   │
│   └── user_activity               用户活跃 / Token 消耗                       │
│                                                                             │
│   → 已加入 supabase_realtime publication，Dashboard 通过 postgres_changes    │
│     订阅增量变更                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ 聚合投影 (cron)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 投影/维护层 (services/maintenance + projections)             │
│                                                                             │
│   每小时 5 分: aggregate_hourly_stats RPC → monitoring_hourly_stats         │
│   每天 0:10:  aggregate_daily_stats  RPC → monitoring_daily_stats           │
│                                                                             │
│   启动时自动回填缺失窗口（startup: 3h / 7d；cron: 14d / 30d 上限）            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    查询与展示层 (services/dashboard)                         │
│                                                                             │
│   AnalyticsDashboardService   Dashboard 概览 / 业务指标聚合                   │
│   AnalyticsQueryService       System / Trends / 最近消息 / 活跃用户            │
│   AnalyticsAlertService       每 5 min 评估业务指标 → AlertNotifierService    │
│                                                                             │
│   热路径 (今天) 走 message_processing_records 直查                            │
│   历史 (昨天/本周/本月) 走 monitoring_hourly_stats / monitoring_daily_stats   │
└─────────────────────────────────────────────────────────────────────────────┘
```

`AnalyticsController` 暴露 `/analytics/**` API；旧的 `/monitoring/**` 路由和 Redis 快照
(`MonitoringSnapshotService`) 已下线。

---

## 存储策略

### 三层数据分工

| 层级 | 技术 | 生命周期 | 主要用途 |
|------|------|----------|----------|
| **事实层** | Supabase `message_processing_records` / `monitoring_error_logs` | 14 / 30 天 (可配置) | 真正的数据源；Dashboard 热路径 + 小时聚合输入 |
| **投影层** | Supabase `monitoring_hourly_stats` / `monitoring_daily_stats` | 永久保留 | 历史 Dashboard 查询；节省原始表扫描 |
| **实时层** | Redis `monitoring:active_requests` / `:peak_active_requests` | 持久 (INCRBY) | 多实例共享在途请求计数、峰值 |

### 为什么抛弃内存+Redis快照方案

1. **可靠性**：监控数据不能因为进程重启归零，运维看板需要长期趋势。
2. **多实例一致性**：Supabase 作为 SoT + Redis 计数器天然支持水平扩展。
3. **查询能力**：SQL/RPC 直接支持分位数、窗口切片、JSONB 聚合，比自己维护 Map 更灵活。
4. **TOAST 成本**：`agent_invocation` JSONB 体积大，通过 **置 NULL 释放 TOAST + 行级保留** 的分层清理策略把读放大控制住。

### Redis Key 清单

| Key | 类型 | 作用 |
|-----|------|------|
| `monitoring:active_requests` | INTEGER | 当前在途请求数（接收 +1 / 终态 -1） |
| `monitoring:peak_active_requests` | INTEGER | 运行期峰值（只增不减，重置需手动） |

`MonitoringGlobalCounters`（totalMessages/totalSuccess/...）仍保留，但仅作为**本实例**的心跳计数，
Dashboard 不再依赖它给出真实值。

---

## 数据流详解

### 1. 实时写入路径

```
WeCom 消息入站
    │
    ▼
MessageTrackingService.recordMessageReceived()
    ├── upsert message_processing_records (status=processing)
    ├── incrementActiveRequests(+1)  → Redis
    ├── incrementCounter('totalMessages', 1)
    └── user_activity 先占位 (messageCount=1, tokenUsage=0)

    … Agent 调用链路执行（由 wecom-observability 收集时间线） …

MessageTrackingService.recordSuccess / recordFailure()
    ├── 从 metadata.agentInvocation 还原终态记录（timings / toolCalls / memorySnapshot / anomalyFlags …）
    ├── applyTerminalCounters（success/failure/fallback 计数器）
    ├── upsert message_processing_records (status=success|failure)
    ├── user_activity 补写 tokenUsage（如果 > 0）
    └── incrementActiveRequests(-1)
```

聚合路径下，入站消息都会各自写一条 `processing` 记录；trace 创建后通过
`dropMergedSourceRecords(sourceMessageIds, batchId)` 一次性删除源行并回收 activeRequests 计数，
只在 batchId 那一行回写终态，避免"源行永远停留在 processing"。

### 2. 数据投影路径

```
每小时 5 分 (Asia/Shanghai)
    │
    ▼
AnalyticsMaintenanceService.aggregateHourlyStats()
    └── catchUpHourlyStats('cron')
           │
           ├── 读取 monitoring_hourly_stats 最新一行 → 计算回填窗口 (最多 14 天)
           │   启动时走 'startup' 分支，上限 3 小时
           │
           └── 逐小时调用 RPC aggregate_hourly_stats(p_hour_start, p_hour_end)
                  └── monitoring_hourly_stats.saveHourlyStats(...) (UPSERT)

每天 00:10 (Asia/Shanghai)
    │
    ▼
AnalyticsMaintenanceService.aggregateDailyStats()
    └── catchUpDailyStats('cron')
           └── RPC aggregate_daily_stats → monitoring_daily_stats (UPSERT)
```

### 3. 数据清理路径

```
每天凌晨 3 点
    │
    ▼
DataCleanupService.cleanupExpiredData()
    ├── timeoutStuckProcessingRecords(30 min)   — 兜底把卡住的 processing 标记为 timeout
    ├── nullAgentInvocations(7 d)                — 释放 TOAST 空间，保留行
    ├── cleanupChatMessages(60 d)                — DELETE
    ├── cleanupMessageProcessingRecords(14 d)    — DELETE（已聚合到 monitoring_hourly_stats）
    ├── cleanupErrorLogs(30 d)                   — DELETE
    └── cleanupUserActivity(35 d)                — DELETE

monitoring_hourly_stats / monitoring_daily_stats → 永久保留
```

### 4. 读取路径

```
GET /analytics/dashboard/overview?range=today|week|month
    │
    ▼
AnalyticsDashboardService
    │
    ├── today     → 走 message_processing_records 直查 + Redis activeRequests
    └── week/month→ 走 HourlyStatsAggregatorService（从 monitoring_hourly_stats 汇总）
                    + DailyStatsAggregatorService（从 monitoring_daily_stats 汇总）
                    + 当前小时 fallback 到原始表（避免空窗）
```

---

## 服务组件

### services/tracking — 采集写入

| 服务 | 职责 |
|------|------|
| [MessageTrackingService](../../src/biz/monitoring/services/tracking/message-tracking.service.ts) | 消息生命周期埋点；从 `agentInvocation` 快照还原终态并持久化；异常信号 `anomalyFlags` 计算（tool_loop / tool_empty_result / tool_narrow_result / tool_chain_overlong） |
| [MonitoringCacheService](../../src/biz/monitoring/services/tracking/monitoring-cache.service.ts) | Redis 共享计数（activeRequests / peakActiveRequests）+ 本实例全局计数器 |

> `recordAiStart/End`、`recordSendStart/End` 等生命周期方法仅作为兼容入口保留，权威时间线由
> Redis trace（wecom-observability 维护）记录，终态时从 `response.timings` 还原。

### services/dashboard — 查询

| 服务 | 职责 |
|------|------|
| [AnalyticsDashboardService](../../src/biz/monitoring/services/dashboard/analytics-dashboard.service.ts) | `/dashboard/overview`：概览 + 业务指标（咨询/预约/转化）+ 降级统计 + 队列状态 |
| [AnalyticsQueryService](../../src/biz/monitoring/services/dashboard/analytics-query.service.ts) | `/dashboard/system`、`/stats/trends`、`/metrics`、`/users`、`/recent-messages`、`/system` |

### services/projections — 投影

| 服务 | 职责 |
|------|------|
| [HourlyStatsAggregatorService](../../src/biz/monitoring/services/projections/hourly-stats-aggregator.service.ts) | 从 `monitoring_hourly_stats` 预聚合数据重建 Dashboard 所需统计（overview / fallback / scenario / tool / 小时趋势） |
| [DailyStatsAggregatorService](../../src/biz/monitoring/services/projections/daily-stats-aggregator.service.ts) | 从 `monitoring_daily_stats` 重建日级趋势 |

### services/maintenance — 聚合 + 清空/缓存清除

| 服务 | 职责 |
|------|------|
| [AnalyticsMaintenanceService](../../src/biz/monitoring/services/maintenance/analytics-maintenance.service.ts) | 小时/日聚合 cron（含启动回填）+ `POST /analytics/clear` + `POST /analytics/cache/clear` |

### services/alerts — 告警

| 服务 | 职责 |
|------|------|
| [AnalyticsAlertService](../../src/biz/monitoring/services/alerts/analytics-alert.service.ts) | 每 5 分钟评估 `BusinessMetricRuleEngine`（成功率 / 平均耗时 / 队列深度 / 错误率），通过 `AlertNotifierService` 发飞书告警；阈值通过 `AgentReplyConfig` 动态下发 |

### services/cleanup — 数据清理

| 服务 | 职责 |
|------|------|
| [DataCleanupService](../../src/biz/monitoring/services/cleanup/data-cleanup.service.ts) | 每天 03:00 分层清理；失败通过 `IncidentReporterService` 上报 |

### Repositories

| Repository | 表 / RPC |
|------------|---------|
| [MonitoringRecordRepository](../../src/biz/monitoring/repositories/record.repository.ts) | `message_processing_records` + `get_dashboard_*` / `aggregate_hourly_stats` / `aggregate_daily_stats` RPC |
| [MonitoringHourlyStatsRepository](../../src/biz/monitoring/repositories/hourly-stats.repository.ts) | `monitoring_hourly_stats` |
| [MonitoringDailyStatsRepository](../../src/biz/monitoring/repositories/daily-stats.repository.ts) | `monitoring_daily_stats` |
| [MonitoringErrorLogRepository](../../src/biz/monitoring/repositories/error-log.repository.ts) | `monitoring_error_logs` |

---

## 前端调用链路

### React Dashboard 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  web/src/view/dashboard/* + hooks/analytics/*                               │
│  ├── useDashboardOverview(range)  ─► GET /analytics/dashboard/overview      │
│  ├── useSystemMonitoring()        ─► GET /analytics/dashboard/system        │
│  ├── useTrendsData(range)         ─► GET /analytics/stats/trends            │
│  ├── useMetrics()                 ─► GET /analytics/metrics                 │
│  ├── useClearData()               ─► POST /analytics/clear                  │
│  └── useClearCache()              ─► POST /analytics/cache/clear            │
│                                                                             │
│  Supabase Realtime: postgres_changes 订阅 message_processing_records        │
│  (migration 20260420130000_realtime_message_processing_records.sql)         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  AnalyticsController (src/biz/monitoring/monitoring.controller.ts)          │
│  ├── GET  /analytics/dashboard/overview  → AnalyticsDashboardService        │
│  ├── GET  /analytics/dashboard/system    → AnalyticsQueryService            │
│  ├── GET  /analytics/stats/trends        → AnalyticsQueryService            │
│  ├── GET  /analytics/metrics             → AnalyticsQueryService            │
│  ├── GET  /analytics/users               → AnalyticsQueryService            │
│  ├── GET  /analytics/user-trend          → AnalyticsQueryService            │
│  ├── GET  /analytics/recent-messages     → AnalyticsQueryService            │
│  ├── GET  /analytics/system              → AnalyticsQueryService            │
│  ├── POST /analytics/clear               → AnalyticsMaintenanceService      │
│  └── POST /analytics/cache/clear         → AnalyticsMaintenanceService      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### API 端点列表

| 方法 | 路径 | 用途 | 建议刷新 |
|-----|------|------|---------|
| GET | `/analytics/dashboard/overview?range=today\|week\|month` | Dashboard 概览 | 5s |
| GET | `/analytics/dashboard/system` | 系统监控（队列 / 运行时） | 5s |
| GET | `/analytics/stats/trends?range=...` | 趋势数据（小时/日/分钟） | 10s |
| GET | `/analytics/metrics` | 详细指标（慢记录 / 分位数） | 10s |
| GET | `/analytics/users?date=YYYY-MM-DD` | 活跃用户 | 10s |
| GET | `/analytics/user-trend` | 咨询用户趋势 | 30s |
| GET | `/analytics/recent-messages?limit=50` | 最近消息 | 5s（或 Realtime） |
| GET | `/analytics/system` | 运行时版本 / 启动时间 | - |
| POST | `/analytics/clear` | 清空所有监控数据 | - |
| POST | `/analytics/cache/clear?type=all\|metrics\|history\|agent` | 清除缓存 | - |

> API 默认启用 `ApiTokenGuard`，需要 Bearer `API_GUARD_TOKEN`；Dashboard 前端注入鉴权头后调用。

---

## 数据结构定义

### MessageProcessingRecord（主事实表）

迁移 [20260417130223_enrich_message_processing_observability.sql](../../supabase/migrations/20260417130223_enrich_message_processing_observability.sql)
之后新增 `agent_invocation` / `agent_steps` / `memory_snapshot` / `tool_calls` / `anomaly_flags` / `post_processing_status` 等字段。

```typescript
interface MessageProcessingRecordInput {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  receivedAt: number;
  status: 'processing' | 'success' | 'failure' | 'timeout';

  // 时序
  aiStartAt?: number;
  aiEndAt?: number;
  queueDuration?: number;   // accepted → workerStart
  prepDuration?: number;    // workerStart → aiStart
  aiDuration?: number;
  sendDuration?: number;
  totalDuration?: number;

  // 业务
  scenario?: ScenarioType;
  tokenUsage?: number;
  messagePreview?: string;
  replyPreview?: string;
  replySegments?: number;
  batchId?: string;                     // 聚合 trace

  // Agent 可观测性
  toolCalls?: AgentToolCall[];
  agentSteps?: AgentStepDetail[];
  memorySnapshot?: AgentMemorySnapshot;
  agentInvocation?: AgentInvocationSnapshot; // JSONB，清理时会被置 NULL 释放 TOAST
  anomalyFlags?: AnomalyFlag[];
  postProcessingStatus?: string;

  // 降级
  isFallback?: boolean;
  fallbackSuccess?: boolean;

  // 错误
  error?: string;
  alertType?: AlertErrorType;
}
```

### HourlyStats（小时投影）

```typescript
interface HourlyStats {
  hour: string;                      // ISO 整点
  messageCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;              // 2026-04-16 新增
  successRate: number;

  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;

  avgQueueDuration: number;          // 2026-04-16 新增
  avgPrepDuration: number;           // 2026-04-16 新增
  avgAiDuration: number;
  avgSendDuration: number;

  activeUsers: number;
  activeChats: number;
  totalTokenUsage: number;

  fallbackCount: number;
  fallbackSuccessCount: number;

  errorTypeStats: Record<string, number>;  // JSONB
  scenarioStats: Record<string, { count: number; successCount: number; avgDuration: number }>;
  toolStats: Record<string, number>;
}
```

### DailyProjectionStats（日投影）

```typescript
interface DailyProjectionStats {
  date: string;                      // YYYY-MM-DD (local)
  messageCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  successRate: number;
  avgDuration: number;
  tokenUsage: number;
  uniqueUsers: number;
  uniqueChats: number;
  fallbackCount: number;
  fallbackSuccessCount: number;
  fallbackAffectedUsers: number;
  avgQueueDuration: number;
  avgPrepDuration: number;
  errorTypeStats: Record<string, number>;
}
```

### Supabase 表结构

```sql
-- 小时聚合（baseline + 20260416173000_add_monitoring_daily_stats.sql）
CREATE TABLE monitoring_hourly_stats (
  hour                  TIMESTAMPTZ PRIMARY KEY,
  message_count         INTEGER NOT NULL DEFAULT 0,
  success_count         INTEGER NOT NULL DEFAULT 0,
  failure_count         INTEGER NOT NULL DEFAULT 0,
  timeout_count         INTEGER NOT NULL DEFAULT 0,
  success_rate          NUMERIC DEFAULT 0,
  avg_duration          INTEGER DEFAULT 0,
  min_duration          INTEGER DEFAULT 0,
  max_duration          INTEGER DEFAULT 0,
  p50_duration          INTEGER DEFAULT 0,
  p95_duration          INTEGER DEFAULT 0,
  p99_duration          INTEGER DEFAULT 0,
  avg_queue_duration    INTEGER NOT NULL DEFAULT 0,
  avg_prep_duration     INTEGER NOT NULL DEFAULT 0,
  avg_ai_duration       INTEGER DEFAULT 0,
  avg_send_duration     INTEGER DEFAULT 0,
  active_users          INTEGER DEFAULT 0,
  active_chats          INTEGER DEFAULT 0,
  total_token_usage     BIGINT  DEFAULT 0,
  fallback_count        INTEGER NOT NULL DEFAULT 0,
  fallback_success_count INTEGER NOT NULL DEFAULT 0,
  error_type_stats      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  scenario_stats        JSONB   DEFAULT '{}'::jsonb,
  tool_stats            JSONB   DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 日聚合（20260416173000_add_monitoring_daily_stats.sql）
CREATE TABLE monitoring_daily_stats (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_date               DATE UNIQUE NOT NULL,
  message_count           INTEGER NOT NULL DEFAULT 0,
  success_count           INTEGER NOT NULL DEFAULT 0,
  failure_count           INTEGER NOT NULL DEFAULT 0,
  timeout_count           INTEGER NOT NULL DEFAULT 0,
  success_rate            NUMERIC DEFAULT 0,
  avg_duration            INTEGER DEFAULT 0,
  total_token_usage       BIGINT  NOT NULL DEFAULT 0,
  unique_users            INTEGER NOT NULL DEFAULT 0,
  unique_chats            INTEGER NOT NULL DEFAULT 0,
  fallback_count          INTEGER NOT NULL DEFAULT 0,
  fallback_success_count  INTEGER NOT NULL DEFAULT 0,
  fallback_affected_users INTEGER NOT NULL DEFAULT 0,
  avg_queue_duration      INTEGER NOT NULL DEFAULT 0,
  avg_prep_duration       INTEGER NOT NULL DEFAULT 0,
  error_type_stats        JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_monitoring_daily_stats_stat_date ON monitoring_daily_stats(stat_date DESC);
```

核心 RPC：
- `aggregate_hourly_stats(p_hour_start, p_hour_end)` — 扫描 `message_processing_records` 返回一行聚合结果
- `aggregate_daily_stats(p_day_start, p_day_end)` — 同上，按天
- `get_dashboard_overview_stats` / `get_dashboard_fallback_stats` / `get_dashboard_daily_trend` /
  `get_dashboard_hourly_trend` / `get_dashboard_minute_trend` / `get_dashboard_scenario_stats` /
  `get_dashboard_tool_stats`

---

## 定时任务

| 服务 | Cron | 时区 | 任务 |
|------|------|------|------|
| AnalyticsMaintenanceService | `5 * * * *` | Asia/Shanghai | 小时统计聚合（startup 回填 3h / cron 回填 14d） |
| AnalyticsMaintenanceService | `10 0 * * *` | Asia/Shanghai | 日统计聚合（startup 回填 7d / cron 回填 30d） |
| AnalyticsAlertService | `*/5 * * * *` | 默认 | 业务指标告警评估（成功率 / 平均耗时 / 队列 / 错误率） |
| DataCleanupService | `0 3 * * *` | 默认 | 分层清理 + stuck processing → timeout（>30min） |

环境变量（保留天数）：

| 变量 | 默认值 | 动作 |
|------|--------|------|
| `DATA_CLEANUP_AGENT_INVOCATION_DAYS` | 7 | NULL `agent_invocation` |
| `DATA_CLEANUP_PROCESSING_DAYS` | 14 | DELETE `message_processing_records` |
| `DATA_CLEANUP_CHAT_DAYS` | 60 | DELETE `chat_messages` |
| `DATA_CLEANUP_USER_ACTIVITY_DAYS` | 35 | DELETE `user_activity` |
| `DATA_CLEANUP_ERROR_LOGS_DAYS` | 30 | DELETE `monitoring_error_logs` |

---

## 故障恢复

### 场景 1：应用实例重启

- `MessageTrackingService.onModuleInit` 仅打印日志，不再加载内存快照。
- `AnalyticsMaintenanceService.onModuleInit` 触发 `catchUpHourlyStats('startup')` 与
  `catchUpDailyStats('startup')`，补齐最近 3 小时 / 7 天缺失窗口。
- `DataCleanupService.onModuleInit` 立即执行一次 `timeoutStuckProcessingRecords`，
  把上次运行遗留的 `processing` 记录（>30 min）置为 `timeout`，避免 activeRequests 被永久占用。

### 场景 2：Redis 不可用

- `incrementActiveRequests` 抛错被捕获，仅记录 warn，不阻塞主流程。
- Dashboard 队列面板会显示 0；主数据仍由 Supabase 提供。
- peak 值不会在本轮更新，Redis 恢复后从新峰值继续累积。

### 场景 3：Supabase 写入失败

- `saveRecordToDatabase` 使用指数退避重试（最多 3 次，500ms → 2000ms）。
- 重试仍失败只记录 `logger.error`，不会抛到上游——消息回包优先级高于可观测数据。
- 下一次小时/日聚合触发时会从事实表自动补回最新状态。

### 场景 4：聚合 RPC 失败

- `aggregateSingleHour` 抛错 → `AnalyticsMaintenanceService` 通过
  `IncidentReporterService.notifyAsync`（code=`cron.job_failed`）上报飞书告警。
- 下次 cron 或应用重启会重新补齐缺失窗口（回填窗口会自动延伸至最早允许小时）。

---

## 性能与成本

### Supabase 资源估算（约 300 条消息/天）

| 对象 | 行数 | 平均大小 | 30 天占用 |
|------|------|----------|-----------|
| `message_processing_records` | ~300/天 × 14 天 = 4,200 | 2–8 KB (含 `agent_invocation`) | ~25 MB |
| `monitoring_error_logs` | 波动 | 1 KB | <1 MB |
| `monitoring_hourly_stats` | 8,760/年 | ~500 B | ~4.3 MB/年（永久） |
| `monitoring_daily_stats` | 365/年 | ~500 B | ~180 KB/年（永久） |
| `user_activity` | 波动 | <1 KB | <5 MB |

TOAST 压力主要来源是 `agent_invocation` JSONB，因此每天凌晨把 >7 天的行置为 NULL。

### Redis 命令估算

| 操作 | 次数/消息 |
|------|-----------|
| `INCRBY monitoring:active_requests` | 2 (接收 +1 / 终态 -1) |
| `GET monitoring:active_requests` | Dashboard 每次刷新 1 |
| `GET/SET monitoring:peak_active_requests` | 接收时 1（若突破峰值） |

按 300 消息/天 × 3 次 ≈ 900 命令/天，远低于 Upstash 免费额度（10,000/天）。

### 优化建议

1. **热路径预聚合**：`today` 仍对 `message_processing_records` 直查，若 TPS 升高可启用分钟聚合（`get_dashboard_minute_trend` 已准备好）。
2. **TOAST 治理**：缩短 `DATA_CLEANUP_AGENT_INVOCATION_DAYS` 可更快释放存储；也可评估把 `agent_invocation` 拆到独立表做冷热分离。
3. **投影窗口**：启动回填上限可配置（目前硬编码），生产环境如果长时间离线建议上调 cron 上限（14d/30d）再人工触发。

---

## 相关文档

- [Agent Runtime 架构](./agent-runtime-architecture.md)
- [消息服务架构](./message-service-architecture.md)
- [Redis 与 Supabase 资源使用指南](../infrastructure/redis-supabase-usage.md)
- [告警系统架构](./ALERT_SYSTEM.md)

---

**维护者**：DuLiDay Team
