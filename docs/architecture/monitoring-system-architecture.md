# 监控系统架构设计

> Cake Agent Runtime - 监控数据存储与展示架构

**最后更新**：2025-12-02

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

监控系统采用 **简化的两层存储架构**，平衡实时性和运维成本：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              数据产生层                                      │
│                         MessageService.handleMessage()                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      MonitoringService (内存层)                              │
│   ├── detailRecords[]     环形缓冲区, 最多 1000 条                          │
│   ├── hourlyStatsMap      小时聚合统计, 最多 72 小时                        │
│   ├── errorLogs[]         错误日志, 最多 100 条                             │
│   └── globalCounters      全局计数器                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                    │
                    │ 实时快照 (分离存储)
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  MonitoringSnapshotService (Redis 快照层)                                    │
│                                                                             │
│  分离存储策略 (便于单独清理):                                                 │
│  ├── monitoring:meta          元数据 (计数器、处理状态)                      │
│  ├── monitoring:hourly-stats  小时聚合统计                                   │
│  ├── monitoring:error-logs    错误日志                                       │
│  └── monitoring:records       详细消息记录 (数据量最大)                       │
│                                                                             │
│  TTL: 1 小时 | 允许丢失: 是 (服务重启后从零开始也可接受)                      │
└─────────────────────────────────────────────────────────────────────────────┘

注意: 不再将监控数据持久化到 Supabase，接受服务重启后数据丢失。
聊天消息仍存储在 Supabase，由 DataCleanupService 定期清理过期数据。
```

---

## 存储策略

### 两层存储对比

| 存储层 | 技术 | 数据内容 | 生命周期 | 主要用途 |
|-------|------|---------|---------|---------|
| **内存层** | Node.js 内存 | 完整详细记录 + 聚合统计 | 进程生命周期 | 实时查询、Dashboard API |
| **快照层** | Redis (Upstash) | 分离存储的快照数据 | TTL 1 小时 | 服务重启恢复（可选）、多实例共享 |

### 为什么简化为两层架构？

1. **内存层**：提供毫秒级响应，支持 Dashboard 实时刷新（5秒轮询）
2. **Redis 快照层**：支持服务短期重启恢复，但允许数据丢失
3. **移除 Supabase 持久层**：监控数据属于运维数据，丢失后可从零积累，无需长期保存

### Redis 分离存储策略

| Key | 数据内容 | 说明 |
|-----|---------|------|
| `monitoring:meta` | 计数器、活跃用户数、处理状态 | 轻量级元数据 |
| `monitoring:hourly-stats` | 小时聚合统计 | 中等数据量 |
| `monitoring:error-logs` | 错误日志列表 | 中等数据量 |
| `monitoring:records` | 详细消息记录 | 数据量最大，可单独清理 |

优点：
- 可以单独清理某类数据（如只清理 records）
- 减少单次写入数据量
- 便于调试和排查问题

---

## 数据流详解

### 1. 实时写入路径

```
用户发送消息
    │
    ▼
MessageService.handleMessage()
    │
    ├── monitoringService.recordMessageReceived()  ─┐
    ├── monitoringService.recordAiStart()          │
    ├── monitoringService.recordAiEnd()            ├─► 内存更新 ─► Redis 快照
    ├── monitoringService.recordSendStart()        │
    ├── monitoringService.recordSendEnd()          │
    └── monitoringService.recordSuccess/Failure() ─┘
```

**代码路径**：
```typescript
// MonitoringService
recordMessageReceived() {
  this.addRecord(record);           // 更新内存
  this.globalCounters.totalMessages++;
  this.persistSnapshot();           // 触发 Redis 写入
}

private persistSnapshot(): void {
  this.snapshotService.saveSnapshot(this.buildSnapshotPayload());
}
```

### 2. 数据清理路径

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 每天凌晨 3 点 (0 3 * * *)                                                    │
│                                                                             │
│   DataCleanupService.cleanupExpiredData()                                   │
│       │                                                                     │
│       ├── cleanupChatMessages()                                             │
│       │   └── 清理 60 天前的聊天消息 (Supabase)                              │
│       │                                                                     │
│       └── cleanupMonitoringHistory()                                        │
│           └── 清理 30 天前的历史监控数据 (兼容旧数据)                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3. 服务恢复路径

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 服务启动时                                                                   │
│                                                                             │
│   MonitoringService.onModuleInit()                                          │
│       │                                                                     │
│       └── restoreFromSnapshot()                                             │
│           │                                                                 │
│           ├── snapshotService.readSnapshot()                                │
│           │   ├── Redis.get('monitoring:meta')                              │
│           │   ├── Redis.get('monitoring:hourly-stats')                      │
│           │   ├── Redis.get('monitoring:error-logs')                        │
│           │   └── Redis.get('monitoring:records')                           │
│           │                                                                 │
│           └── applySnapshot(snapshot)                                       │
│               └── 恢复: detailRecords, hourlyStatsMap, errorLogs,           │
│                        globalCounters (activeUsers/activeChats 从 records 重建)│
│                                                                             │
│   注意: 如果 Redis 数据过期或不存在，服务将从空状态启动（可接受）               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 服务组件

### MonitoringService

**职责**：核心监控数据收集与统计

**文件位置**：`src/infra/monitoring/monitoring.service.ts`

**内存数据结构**：

```typescript
// 详细记录（环形缓冲区）
private detailRecords: MessageProcessingRecord[] = [];  // 最多 1000 条

// 小时聚合统计
private hourlyStatsMap = new Map<string, HourlyStats>();  // 最多 72 小时

// 全局计数器
private globalCounters: MonitoringGlobalCounters = {
  totalMessages: 0,
  totalSuccess: 0,
  totalFailure: 0,
  totalAiDuration: 0,
  totalSendDuration: 0,
  totalFallback: 0,
  totalFallbackSuccess: 0,
};

// 错误日志
private errorLogs: MonitoringErrorLog[] = [];  // 最多 100 条

// 活跃度统计
private activeUsersSet = new Set<string>();
private activeChatsSet = new Set<string>();
private currentProcessing = 0;
private peakProcessing = 0;
```

**主要方法**：

| 方法 | 用途 |
|-----|------|
| `recordMessageReceived()` | 记录消息接收 |
| `recordAiStart/End()` | 记录 AI 处理时间 |
| `recordSendStart/End()` | 记录消息发送时间 |
| `recordSuccess/Failure()` | 记录处理结果 |
| `getDashboardData(range)` | 获取仪表盘数据 |
| `getMetricsData()` | 获取详细指标 |
| `clearAllData()` | 清空所有数据 |

### MonitoringSnapshotService

**职责**：实时快照分离存储到 Redis

**文件位置**：`src/infra/monitoring/monitoring-snapshot.service.ts`

**配置**：

| 配置项 | 值 | 说明 |
|-------|---|------|
| Redis Keys | `monitoring:meta`, `monitoring:hourly-stats`, `monitoring:error-logs`, `monitoring:records` | 分离存储键 |
| TTL | 3600 秒 (1小时) | 自动过期时间 |
| 环境变量 | `MONITORING_SNAPSHOT_ENABLED` | 启用开关 |

**分离存储结构**：

```typescript
// 元数据（轻量级）
interface MonitoringMeta {
  version: number;
  savedAt: number;
  globalCounters: MonitoringGlobalCounters;
  activeUsersCount: number;  // 只存数量，列表从 records 重建
  activeChatsCount: number;
  currentProcessing: number;
  peakProcessing: number;
}
```

**关键实现**：

```typescript
// 串行写入队列，避免并发竞争
saveSnapshot(snapshot: MonitoringSnapshot): void {
  this.writeQueue = this.writeQueue
    .catch(() => { /* 忽略上一次错误 */ })
    .then(() => this.writeToRedis(snapshot));
}

private async writeToRedis(snapshot: MonitoringSnapshot): Promise<void> {
  // 并行写入所有分离的数据
  await Promise.all([
    this.redisService.setex(this.KEY_META, this.SNAPSHOT_TTL_SECONDS, meta),
    this.redisService.setex(this.KEY_HOURLY_STATS, this.SNAPSHOT_TTL_SECONDS, snapshot.hourlyStats),
    this.redisService.setex(this.KEY_ERROR_LOGS, this.SNAPSHOT_TTL_SECONDS, snapshot.errorLogs),
    this.redisService.setex(this.KEY_RECORDS, this.SNAPSHOT_TTL_SECONDS, snapshot.detailRecords),
  ]);
}
```

### DataCleanupService

**职责**：定期清理过期数据

**文件位置**：`src/infra/monitoring/data-cleanup.service.ts`

**定时任务**：

| Cron 表达式 | 执行时间 | 任务 |
|------------|---------|------|
| `0 3 * * *` | 每天凌晨3点 | 清理过期聊天消息（60天）和监控历史数据（30天） |

**主要方法**：

| 方法 | 用途 |
|-----|------|
| `cleanupExpiredData()` | 定时清理任务入口 |
| `cleanupChatMessages()` | 清理过期聊天消息 |
| `cleanupMonitoringHistory()` | 清理过期监控历史（兼容旧数据） |
| `triggerCleanup()` | 手动触发清理 |

---

## 前端调用链路

### React Dashboard 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Dashboard.tsx                                                              │
│  ├── useDashboard(timeRange)    ─► GET /monitoring/dashboard?range=today   │
│  ├── useHealthStatus()          ─► GET /agent/health                       │
│  ├── useAiReplyStatus()         ─► GET /monitoring/ai-reply-status         │
│  └── useToggleAiReply()         ─► POST /monitoring/toggle-ai-reply        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  hooks/useMonitoring.ts (React Query)                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ useDashboard()       refetchInterval: 5000ms                          │ │
│  │ useMetrics()         refetchInterval: 5000ms                          │ │
│  │ useHealthStatus()    refetchInterval: 10000ms                         │ │
│  │ useUsers()           refetchInterval: 10000ms                         │ │
│  │ useRecentMessages()  refetchInterval: 5000ms                          │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  MonitoringController                                                       │
│  ├── GET  /dashboard        → monitoringService.getDashboardData(range)    │
│  ├── GET  /metrics          → monitoringService.getMetricsData()           │
│  ├── GET  /ai-reply-status  → messageService.getAiReplyStatus()            │
│  ├── POST /toggle-ai-reply  → messageService.toggleAiReply(enabled)        │
│  └── POST /clear            → monitoringService.clearAllData()             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### API 端点列表

| 方法 | 路径 | 用途 | 刷新频率 |
|-----|------|------|---------|
| GET | `/monitoring/dashboard?range=today\|week\|month` | 仪表盘数据 | 5s |
| GET | `/monitoring/metrics` | 详细指标 | 5s |
| GET | `/monitoring/ai-reply-status` | AI 回复状态 | - |
| POST | `/monitoring/toggle-ai-reply` | 切换 AI 回复 | - |
| GET | `/monitoring/users` | 用户列表 | 10s |
| GET | `/monitoring/recent-messages` | 最近消息 | 5s |
| POST | `/monitoring/clear` | 清空数据 | - |
| POST | `/monitoring/cache/refresh` | 刷新缓存 | - |
| GET | `/agent/health` | 健康状态 | 10s |

---

## 数据结构定义

### MonitoringSnapshot（Redis 快照）

```typescript
interface MonitoringSnapshot {
  version: number;                           // 快照版本号
  savedAt: number;                           // 保存时间戳
  detailRecords: MessageProcessingRecord[];  // 详细记录
  hourlyStats: HourlyStats[];                // 小时统计
  errorLogs: MonitoringErrorLog[];           // 错误日志
  globalCounters: MonitoringGlobalCounters;  // 全局计数器
  activeUsers: string[];                     // 活跃用户 ID
  activeChats: string[];                     // 活跃会话 ID
  currentProcessing: number;                 // 当前处理中数量
  peakProcessing: number;                    // 峰值处理数量
}
```

### MessageProcessingRecord（消息处理记录）

```typescript
interface MessageProcessingRecord {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  receivedAt: number;
  status: 'processing' | 'success' | 'failure';

  // 时间节点
  aiStartAt?: number;
  aiEndAt?: number;
  sendStartAt?: number;
  sendEndAt?: number;

  // 耗时统计
  queueDuration?: number;
  aiDuration?: number;
  sendDuration?: number;
  totalDuration?: number;

  // 业务数据
  scenario?: ScenarioType;
  tools?: string[];
  tokenUsage?: number;
  messagePreview?: string;
  replyPreview?: string;
  replySegments?: number;

  // 降级信息
  isFallback?: boolean;
  fallbackSuccess?: boolean;

  // 错误信息
  error?: string;
  alertType?: AlertErrorType;
}
```

### HourlyStats（小时统计）

```typescript
interface HourlyStats {
  hour: string;          // ISO 格式 (YYYY-MM-DDTHH:00:00.000Z)
  messageCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;   // 百分比
  avgDuration: number;   // 平均耗时 (ms)
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  avgAiDuration: number;
  avgSendDuration: number;
  activeUsers: number;
  activeChats: number;
}
```

### Supabase 表结构

```sql
CREATE TABLE monitoring_hourly (
  hour         TIMESTAMPTZ PRIMARY KEY,  -- 小时整点时间
  message_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_duration  NUMERIC(10, 2) DEFAULT 0,
  p95_duration  NUMERIC(10, 2) DEFAULT 0,
  active_users  INTEGER DEFAULT 0,
  active_chats  INTEGER DEFAULT 0,
  total_tokens  INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化查询
CREATE INDEX idx_monitoring_hourly_hour ON monitoring_hourly(hour DESC);
```

---

## 定时任务

### 任务列表

| 服务 | Cron 表达式 | 执行频率 | 任务描述 |
|-----|------------|---------|---------|
| DataCleanupService | `0 3 * * *` | 每天 3:00 | 清理过期聊天消息和监控历史数据 |
| MonitoringService | `setInterval` | 每小时 | 清理过期内存数据 |

### 内存数据清理

```typescript
// MonitoringService 构造函数中
setInterval(() => {
  this.cleanupExpiredData();
}, 60 * 60 * 1000);  // 每小时执行

private cleanupExpiredData(): void {
  const cutoffTime = Date.now() - this.MAX_HOURLY_STATS * 60 * 60 * 1000;  // 72小时

  // 清理过期的小时统计
  for (const [key, stats] of this.hourlyStatsMap.entries()) {
    if (new Date(stats.hour).getTime() < cutoffTime) {
      this.hourlyStatsMap.delete(key);
    }
  }
}
```

---

## 故障恢复

### 场景 1：服务重启

```
服务启动
    │
    ▼
MonitoringService.onModuleInit()
    │
    ▼
restoreFromSnapshot()
    │
    ├── 尝试从 Redis 读取快照
    │   │
    │   ├── 成功 → applySnapshot() → 恢复内存数据
    │   │
    │   └── 失败 → 使用空数据启动 (快照可能已过期)
    │
    └── 日志记录恢复状态
```

### 场景 2：Redis 不可用

- **写入失败**：记录错误日志，不影响内存数据
- **读取失败**：服务从空状态启动，历史数据可从 Supabase 获取

### 场景 3：Supabase 不可用

- **同步失败**：记录错误日志，下次整点重试
- **实时数据不受影响**：内存和 Redis 正常工作

---

## 性能与成本

### 资源使用估算

| 资源 | 使用量 | 免费额度 | 使用率 |
|-----|-------|---------|-------|
| Redis 命令/天 | ~1500 | 10,000 | ~15% |
| Supabase 存储 | < 1 MB | 500 MB | < 0.2% |
| Supabase API/天 | ~25 | 无限制* | - |

### Redis 命令估算

```
每条消息: 5 次 record* 调用 × 1 次 Redis setex = 5 次
假设每天 300 条消息: 300 × 5 = 1500 次/天
```

### Supabase 存储估算

```
每小时 1 条记录，每条约 200 字节
30 天: 24 × 30 × 200 = 144 KB
```

### 优化建议

1. **批量写入**：考虑将 Redis 快照写入改为定时批量（如每 10 秒）
2. **压缩存储**：对大型快照启用 JSON 压缩
3. **分层查询**：热数据走内存，冷数据查 Supabase

---

## 相关文档

- [Redis 与 Supabase 资源使用指南](../infrastructure/redis-supabase-usage.md)
- [告警系统架构](./ALERT_SYSTEM.md)
- [消息服务架构](./message-service-architecture.md)

---

**维护者**：DuLiDay Team
