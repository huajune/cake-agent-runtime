# Redis Key 设计与使用说明

> DuLiDay 企业微信服务 - Redis (Upstash) 缓存层设计文档

**最后更新**：2026-03-12

**Redis 客户端**：`@upstash/redis`（REST API 模式）| **连接方式**：`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

**Key 常量定义**：各模块 `utils/*-redis-keys.ts` 文件

---

## 目录

- [总览](#总览)
- [命名规范](#命名规范)
- [消息模块（wecom:message:*）](#消息模块wecommessage)
  - [wecom:message:dedup](#1-wecommessagededup---消息去重)
  - [wecom:message:pending](#2-wecommessagepending---消息聚合队列)
  - [wecom:message:history（预留）](#3-wecommessagehistory-预留)
  - [wecom:message:lock（预留）](#4-wecommessagelock-预留)
- [监控模块（monitoring:*）](#监控模块monitoring)
  - [monitoring:counters](#5-monitoringcounters---全局计数器)
  - [monitoring:current_processing](#6-monitoringcurrent_processing---当前并发数)
  - [monitoring:peak_processing](#7-monitoringpeak_processing---峰值并发数)
  - [monitoring:today_users](#8-monitoringtoday_users---今日用户缓存)
  - [monitoring:active_users:{date}](#9-monitoringactive_usersdate---活跃用户集合)
  - [monitoring:active_chats:{date}](#10-monitoringactive_chatsdate---活跃会话集合)
- [配置模块（config:*）](#配置模块config)
  - [config:ai_reply_enabled](#11-configai_reply_enabled---ai回复开关)
  - [config:message_merge_enabled](#12-configmessage_merge_enabled---消息聚合开关)
  - [config:agent_reply_config](#13-configagent_reply_config---agent回复策略配置)
  - [config:system_config](#14-configsystem_config---系统配置)
  - [config:group_blacklist](#15-configgroup_blacklist---小组黑名单)
  - [config:strategy_config:active](#16-configstrategy_configactive---策略配置)
- [Bull Queue](#bull-queue)
- [数据生命周期](#数据生命周期)
- [连接配置](#连接配置)

---

## 总览

| # | Key 模式 | 数据结构 | TTL | 所属模块 | 用途 |
|---|---------|---------|-----|---------|------|
| 1 | `wecom:message:dedup:{id}` | String | 5min | wecom/message | 消息去重标记 |
| 2 | `wecom:message:pending:{chatId}` | List | 5min | wecom/message | 消息聚合队列 |
| 3 | `wecom:message:history:{chatId}` | String | — | wecom/message | 消息历史缓存（预留） |
| 4 | `wecom:message:lock:{chatId}` | String | — | wecom/message | 分布式处理锁（预留） |
| 5 | `monitoring:counters` | Hash | 永久 | biz/monitoring | 全局累计计数器 |
| 6 | `monitoring:current_processing` | String | 永久 | biz/monitoring | 实时并发处理数 |
| 7 | `monitoring:peak_processing` | String | 永久 | biz/monitoring | 历史峰值并发数 |
| 8 | `monitoring:today_users` | String | 30s | biz/monitoring | 今日用户列表缓存 |
| 9 | `monitoring:active_users:{date}` | Sorted Set | 24h | biz/monitoring | 日活跃用户集合 |
| 10 | `monitoring:active_chats:{date}` | Sorted Set | 24h | biz/monitoring | 日活跃会话集合 |
| 11 | `config:ai_reply_enabled` | String | 5min | biz/hosting-config | AI 回复开关缓存 |
| 12 | `config:message_merge_enabled` | String | 5min | biz/hosting-config | 消息聚合开关缓存 |
| 13 | `config:agent_reply_config` | String | 1min | biz/hosting-config | Agent 回复策略缓存 |
| 14 | `config:system_config` | String | 5min | biz/hosting-config | 系统配置缓存 |
| 15 | `config:group_blacklist` | String | 5min | biz/hosting-config | 小组黑名单缓存 |
| 16 | `config:strategy_config:active` | String | 5min | biz/strategy | 策略配置缓存 |

---

## 命名规范

```
{namespace}:{domain}:{type}[:{qualifier}]
```

| 命名空间 | 含义 | 示例 |
|---------|------|------|
| `wecom` | 企业微信消息处理 | `wecom:message:dedup:msg_123` |
| `monitoring` | 运行时监控指标 | `monitoring:counters` |
| `config` | 配置缓存（三级缓存 L2 层） | `config:ai_reply_enabled` |

**Key 常量定义位置**：

```
src/
├── wecom/message/utils/redis-key.util.ts          → RedisKeyBuilder（静态方法）
├── biz/monitoring/utils/monitoring-redis-keys.ts   → MONITORING_REDIS_KEYS
├── biz/hosting-config/utils/hosting-config-redis-keys.ts → HOSTING_CONFIG_REDIS_KEYS
└── biz/strategy/utils/strategy-redis-keys.ts       → STRATEGY_REDIS_KEYS
```

---

## 消息模块（wecom:message:*）

**Key 常量**：`src/wecom/message/utils/redis-key.util.ts` — `RedisKeyBuilder`

### 1. wecom:message:dedup - 消息去重

**用途**：防止同一条消息被重复处理（幂等保障）

**代码位置**：`src/wecom/message/services/message-deduplication.service.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `wecom:message:dedup:{messageId}` |
| 数据结构 | String |
| 存储内容 | 接收时间戳（毫秒字符串） |
| TTL | 300s（5分钟），由 `MESSAGE_DEDUP_TTL_SECONDS` 环境变量控制 |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 检查是否重复 | `EXISTS` | 每条消息到达时 |
| 标记为已处理 | `SETEX` | 消息开始处理时 |
| 批量清理 | `SCAN` + `DEL` | 手动维护 |

**示例**：

```
Key:   wecom:message:dedup:7881298543@chatroom_1748123456789
Value: "1773250000000"
TTL:   298s
```

---

### 2. wecom:message:pending - 消息聚合队列

**用途**：暂存同一会话在聚合窗口内到达的多条消息，等待批量发送给 AI

**代码位置**：`src/wecom/message/services/simple-merge.service.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `wecom:message:pending:{chatId}` |
| 数据结构 | List（右进左出） |
| 存储内容 | JSON 序列化的消息对象 |
| TTL | 300s（5分钟兜底，防内存泄漏） |
| 实际生命周期 | 聚合窗口（默认 2s）到期后被清空，远短于 TTL |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 追加消息 | `RPUSH` | 消息到达 |
| 设置兜底 TTL | `EXPIRE` | 每次追加后 |
| 获取队列长度 | `LLEN` | 检查是否超过最大聚合数 |
| 取出所有消息 | `LRANGE 0 -1` | 聚合 Worker 触发时 |
| 清空队列 | `DEL` | 消息取出后立即删除 |

**配合 Bull Queue 工作**：

```
消息到达
  → RPUSH 到 pending 队列
  → 创建/更新 Bull 延迟任务（jobId = chatId，延迟 2s）
  → 2s 后 Worker 读取队列 → DEL → 批量发送 AI
```

**示例**：

```
Key:   wecom:message:pending:wxid_abc123
Value: ["{"content":"你好"}","{"content":"请问有空吗"}"]
TTL:   298s
```

---

### 3. wecom:message:history（预留）

**用途**：消息历史缓存（当前历史记录已迁移至 Supabase `chat_messages` 表永久存储，此 key 暂未使用）

| 属性 | 值 |
|------|----|
| Key 格式 | `wecom:message:history:{chatId}` |
| 数据结构 | String（JSON） |
| 当前状态 | **未使用** — 消息历史由 `MessageHistoryService` 直接读写 Supabase |

---

### 4. wecom:message:lock（预留）

**用途**：分布式处理锁，防止同一会话并发处理（多实例部署时使用）

| 属性 | 值 |
|------|----|
| Key 格式 | `wecom:message:lock:{chatId}` |
| 数据结构 | String |
| 当前状态 | **未使用** — 当前由 Bull Queue `jobId=chatId` 去重机制替代 |

---

## 监控模块（monitoring:*）

**Key 常量**：`src/biz/monitoring/utils/monitoring-redis-keys.ts` — `MONITORING_REDIS_KEYS`

### 5. monitoring:counters - 全局计数器

**用途**：高频累计写入的全局监控指标，使用 Hash 支持原子增量更新

**代码位置**：`src/biz/monitoring/services/tracking/monitoring-cache.service.ts`

| 属性 | 值 |
|------|----|
| Key | `monitoring:counters` |
| 数据结构 | Hash |
| TTL | **永久**（无过期，随服务启动持续累计） |

**Hash 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalMessages` | integer | 累计收到消息数 |
| `totalSuccess` | integer | 累计处理成功数 |
| `totalFailure` | integer | 累计处理失败数 |
| `totalAiDuration` | integer | 累计 AI 处理耗时（ms） |
| `totalSendDuration` | integer | 累计消息发送耗时（ms） |
| `totalFallback` | integer | 累计降级次数 |
| `totalFallbackSuccess` | integer | 累计降级成功次数 |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 单字段增量 | `HINCRBY` | 每条消息处理完成 |
| 批量增量 | `PIPELINE` + `HINCRBY` × N | 批量更新时 |
| 读取全部 | `HGETALL` | Dashboard 查询 |
| 重置 | `DEL` | 手动维护 |
| 迁移/初始化 | `HMSET` | 数据迁移场景 |

---

### 6. monitoring:current_processing - 当前并发数

**用途**：实时追踪当前正在处理的消息数量

**代码位置**：`src/biz/monitoring/services/tracking/monitoring-cache.service.ts`

| 属性 | 值 |
|------|----|
| Key | `monitoring:current_processing` |
| 数据结构 | String（数字） |
| TTL | **永久** |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 原子增量 | `INCRBY +1` | 消息处理开始 |
| 原子减量 | `INCRBY -1` | 消息处理结束 |
| 直接设值 | `SET` | 重置或迁移 |
| 读取 | `GET` | Dashboard 查询 |

---

### 7. monitoring:peak_processing - 峰值并发数

**用途**：记录历史最高并发数，用于容量规划参考

**代码位置**：`src/biz/monitoring/services/tracking/monitoring-cache.service.ts`

| 属性 | 值 |
|------|----|
| Key | `monitoring:peak_processing` |
| 数据结构 | String（数字） |
| TTL | **永久** |
| 更新策略 | 仅当新值 > 当前值时才更新（Compare-and-Set 语义） |

---

### 8. monitoring:today_users - 今日用户缓存

**用途**：缓存今日用户列表数据库查询结果，减少 Supabase 查询压力

**代码位置**：`src/biz/monitoring/services/analytics/analytics-query.service.ts`

| 属性 | 值 |
|------|----|
| Key | `monitoring:today_users` |
| 数据结构 | String（JSON 数组） |
| TTL | 30s（短 TTL，数据接近实时） |
| 存储内容 | `TodayUser[]` JSON 序列化 |

---

### 9. monitoring:active_users:{date} - 活跃用户集合

**用途**：记录每日有消息交互的用户（去重），支持日活统计

**代码位置**：`src/biz/monitoring/services/tracking/monitoring-cache.service.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `monitoring:active_users:{YYYY-MM-DD}` |
| 数据结构 | Sorted Set |
| Score | 用户最后活跃时间戳（毫秒） |
| Member | userId（字符串） |
| TTL | 86400s（24小时） |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 记录活跃 | `ZADD` | 每次收到用户消息 |
| 刷新 TTL | `EXPIRE` | 每次 ZADD 后 |
| 获取列表 | `ZRANGE 0 -1` | 统计查询 |
| 获取数量 | `ZCARD` | DAU 统计 |

**示例**：

```
Key:    monitoring:active_users:2026-03-12
Score:  1773250000000
Member: wxid_abc123
TTL:    82400s
```

---

### 10. monitoring:active_chats:{date} - 活跃会话集合

**用途**：记录每日有消息往来的会话（去重），支持活跃会话数统计

**代码位置**：`src/biz/monitoring/services/tracking/monitoring-cache.service.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `monitoring:active_chats:{YYYY-MM-DD}` |
| 数据结构 | Sorted Set |
| Score | 会话最后活跃时间戳（毫秒） |
| Member | chatId（字符串） |
| TTL | 86400s（24小时） |

（操作与 `monitoring:active_users:{date}` 相同）

---

## 配置模块（config:*）

**Key 常量**：

- `src/biz/hosting-config/utils/hosting-config-redis-keys.ts` — `HOSTING_CONFIG_REDIS_KEYS`
- `src/biz/strategy/utils/strategy-redis-keys.ts` — `STRATEGY_REDIS_KEYS`

**三级缓存架构**：

```
读取请求
  → L1: 内存缓存（服务实例内）
  → L2: Redis 缓存（config:* keys，5min TTL）
  → L3: Supabase system_config / strategy_config 表
```

### 11. config:ai_reply_enabled - AI回复开关

**代码位置**：`src/biz/hosting-config/services/system-config.service.ts`

| 属性 | 值 |
|------|----|
| Key | `config:ai_reply_enabled` |
| 数据结构 | String（JSON boolean） |
| TTL | 300s（5分钟） |
| L1 内存缓存 | 实例变量 `aiReplyEnabled`（重启失效） |
| Supabase 持久化 | `system_config` 表，key = `ai_reply_enabled` |

---

### 12. config:message_merge_enabled - 消息聚合开关

**代码位置**：`src/biz/hosting-config/services/system-config.service.ts`

| 属性 | 值 |
|------|----|
| Key | `config:message_merge_enabled` |
| 数据结构 | String（JSON boolean） |
| TTL | 300s（5分钟） |
| Supabase 持久化 | `system_config` 表，key = `message_merge_enabled` |

---

### 13. config:agent_reply_config - Agent回复策略配置

**代码位置**：`src/biz/hosting-config/services/system-config.service.ts`

| 属性 | 值 |
|------|----|
| Key | `config:agent_reply_config` |
| 数据结构 | String（JSON 对象） |
| TTL | **60s（1分钟，比其他配置更短，配置变更实时生效）** |
| Supabase 持久化 | `system_config` 表，key = `agent_reply_config` |

**存储内容（`AgentReplyConfig`）**：

```typescript
{
  initialMergeWindowMs: number;   // 消息聚合等待窗口（ms）
  maxMergedMessages: number;       // 最大聚合消息条数
  typingDelayPerCharMs: number;    // 打字延迟（ms/字符）
  paragraphGapMs: number;          // 段落间隔（ms）
}
```

---

### 14. config:system_config - 系统配置

**代码位置**：`src/biz/hosting-config/services/system-config.service.ts`

| 属性 | 值 |
|------|----|
| Key | `config:system_config` |
| 数据结构 | String（JSON 对象） |
| TTL | 300s（5分钟） |
| Supabase 持久化 | `system_config` 表，key = `system_config` |

**存储内容（`SystemConfig`）**：

```typescript
{
  workerConcurrency?: number;    // Worker 并发数
}
```

---

### 15. config:group_blacklist - 小组黑名单

**代码位置**：`src/biz/hosting-config/services/group-blacklist.service.ts`

| 属性 | 值 |
|------|----|
| Key | `config:group_blacklist` |
| 数据结构 | String（JSON 数组） |
| TTL | 300s（5分钟） |
| L1 内存缓存 | `Map<groupId, GroupBlacklistItem>`（重启失效） |
| Supabase 持久化 | `system_config` 表，key = `group_blacklist` |

**存储内容（`GroupBlacklistItem[]`）**：

```typescript
[
  {
    group_id: string;    // 小组 ID
    reason?: string;     // 加入黑名单原因
    added_at: number;    // 加入时间戳（ms）
  }
]
```

---

### 16. config:strategy_config:active - 策略配置

**代码位置**：`src/biz/strategy/services/strategy-config.service.ts`

| 属性 | 值 |
|------|----|
| Key | `config:strategy_config:active` |
| 数据结构 | String（JSON 对象） |
| TTL | 300s（5分钟） |
| L1 内存缓存 | 实例变量 `cachedConfig`，独立 60s TTL |
| Supabase 持久化 | `strategy_config` 表 |

**存储内容（`StrategyConfigRecord`）**：

```typescript
{
  id: string;
  persona: StrategyPersona;         // AI 人格配置
  stage_goals: StrategyStageGoals;  // 阶段目标
  red_lines: StrategyRedLines;      // 红线规则
  created_at: string;
  updated_at: string;
}
```

---

## Bull Queue

Bull Queue 使用独立的 Redis TCP 连接（与应用层 REST API 分开），专门处理消息聚合任务。

**连接配置**（优先级从高到低）：

```bash
UPSTASH_REDIS_TCP_URL=rediss://default:xxx@xxx.upstash.io:6379  # 首选
REDIS_URL=redis://localhost:6379                                  # 备选
# 兜底：localhost:6379
```

**队列名**：`message-merge`

**Job 数据结构**：

```typescript
{
  chatId: string;       // 会话 ID（同时作为 jobId，保证同一会话只有一个等待任务）
  messageData?: {...};  // 可选消息数据
}
```

**队列配置**：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `attempts` | 3 | 失败重试次数 |
| `backoff.type` | exponential | 指数退避 |
| `backoff.delay` | 2000ms | 初始退避时间 |
| `removeOnComplete` | 100 | 保留最近 100 个完成任务 |
| `removeOnFail` | 1000 | 保留最近 1000 个失败任务 |
| `stalledInterval` | 30000ms | 卡住检测间隔 |
| `lockDuration` | 60000ms | 任务锁定时长 |

**Bull Queue 的 Redis 内部 Keys**（由框架自动管理，无需手动干预）：

```
bull:message-merge:wait     — 等待队列
bull:message-merge:active   — 处理中
bull:message-merge:completed — 已完成
bull:message-merge:failed   — 失败
bull:message-merge:delayed  — 延迟中（消息聚合等待窗口）
bull:message-merge:{jobId}  — 任务数据
```

---

## 数据生命周期

### TTL 汇总

| 数据类型 | TTL | 清理方式 |
|---------|-----|---------|
| 消息去重标记 | 5 min | Redis 自动过期 |
| 消息聚合队列 | 5 min（兜底） | 正常由 Worker 主动 DEL |
| 全局计数器 | **永久** | 手动重置 / `resetCounters()` |
| 当前/峰值并发 | **永久** | 手动重置 |
| 今日用户缓存 | 30s | Redis 自动过期 |
| 活跃用户/会话 | 24h | Redis 自动过期 |
| 配置缓存（通用）| 5 min | Redis 自动过期 |
| Agent 回复配置 | 1 min | Redis 自动过期 |

### 消息处理中的 Redis 时序

```
消息到达
  ① EXISTS wecom:message:dedup:{msgId}
     → 命中：丢弃（重复消息）
     → 未命中：继续
  ② RPUSH wecom:message:pending:{chatId}
     EXPIRE wecom:message:pending:{chatId} 300
  ③ Bull 创建延迟 Job（delay = initialMergeWindowMs，默认 2s）
     — 若 chatId Job 已存在，跳过（聚合去重）

[2s 后 Worker 触发]
  ④ LRANGE wecom:message:pending:{chatId} 0 -1  → 取出所有消息
     DEL wecom:message:pending:{chatId}           → 清空队列
  ⑤ 调用 Agent API
  ⑥ SETEX wecom:message:dedup:{msgId} 300 {timestamp}  → 标记已处理
  ⑦ HINCRBY monitoring:counters totalMessages 1
     HINCRBY monitoring:counters totalSuccess/totalFailure 1
  ⑧ ZADD monitoring:active_users:{today} {timestamp} {userId}
     ZADD monitoring:active_chats:{today} {timestamp} {chatId}
```

---

## 连接配置

### 应用层（REST API）

```bash
# 用于所有 Service 的 set/get/del/hset 等操作
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...
```

### Bull Queue（TCP，可选）

```bash
# 用于 Bull Queue 消息队列（需要 TCP 连接，REST 不支持 blocking 操作）
UPSTASH_REDIS_TCP_URL=rediss://default:xxx@xxx.upstash.io:6379

# 禁用 Bull Queue（本地开发或无 TCP Redis 时）
ENABLE_BULL_QUEUE=false
```

### 连接来源对照

| 功能 | 连接方式 | 环境变量 |
|------|---------|---------|
| 所有 Service 的缓存操作 | REST（`@upstash/redis`） | `UPSTASH_REDIS_REST_*` |
| Bull Queue 任务队列 | TCP（`ioredis`） | `UPSTASH_REDIS_TCP_URL` |

---

## 故障排查

### 消息去重失效

```bash
# 检查 key 是否存在
curl -X GET "$UPSTASH_REDIS_REST_URL/exists/wecom:message:dedup:{msgId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

### 消息聚合队列积压

```bash
# 查看队列长度
curl -X GET "$UPSTASH_REDIS_REST_URL/llen/wecom:message:pending:{chatId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

### 配置缓存未更新

```bash
# 手动删除配置缓存，触发重新从 DB 加载
curl -X GET "$UPSTASH_REDIS_REST_URL/del/config:ai_reply_enabled" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

### 查看全局计数器

```bash
curl -X GET "$UPSTASH_REDIS_REST_URL/hgetall/monitoring:counters" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

---

**参考**：
- [database-schema.md](./database-schema.md) — Supabase 数据库表设计
- [bull-queue-guide.md](../technical/bull-queue-guide.md) — Bull Queue 详细说明
- [CLAUDE.md](../../CLAUDE.md) — 项目配置与环境变量
