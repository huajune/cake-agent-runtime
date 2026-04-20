# Redis Key 设计与使用说明

> Cake Agent Runtime - Redis (Upstash) 缓存层设计文档

**最后更新**：2026-04-20

**Redis 客户端**：`@upstash/redis`（REST）+ `ioredis`（Bull Queue TCP）

**连接环境变量**：`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`（REST） | `UPSTASH_REDIS_TCP_URL`（Bull TCP）

**环境隔离**：所有 Redis 调用都会被 `RedisService.withPrefix` 自动加上 `{RUNTIME_ENV|NODE_ENV}:` 前缀（Bull 队列同样会加 `bull:{env}` 前缀），多环境共享同一实例时物理隔离。

---

## 目录

- [总览](#总览)
- [命名规范](#命名规范)
- [消息管道（wecom:message:*）](#消息管道wecommessage)
- [短期记忆（memory:short_term:*）](#短期记忆memoryshort_term)
- [会话/程序性记忆（facts:* / stage:*）](#会话程序性记忆facts--stage)
- [托管配置共享缓存（hosting:*）](#托管配置共享缓存hosting)
- [监控与任务（monitoring / group-task / group-membership）](#监控与任务monitoring--group-task--group-membership)
- [其他业务缓存](#其他业务缓存)
- [Bull Queue](#bull-queue)
- [数据生命周期](#数据生命周期)
- [连接配置](#连接配置)
- [故障排查](#故障排查)

---

## 总览

| # | Key 模式 | 数据结构 | TTL | 所属模块 | 用途 |
|---|---------|---------|-----|---------|------|
| 1 | `wecom:message:dedup:{messageId}` | String | 5 min | wecom/message | 消息去重（SET NX EX） |
| 2 | `wecom:message:pending:{chatId}` | List | 5 min | wecom/message | 消息聚合队列 |
| 3 | `wecom:message:last-message-at:{chatId}` | String | 5 min | wecom/message | 最近消息到达时间（静默窗口） |
| 4 | `wecom:message:lock:{chatId}` | String | 5 min | wecom/message | 处理分布式锁（Lua 条件释放） |
| 5 | `wecom:message:trace:{messageId}` | String | 24 h | wecom/message | 消息 trace 上下文（调试） |
| 6 | `memory:short_term:chat:{chatId}` | List | 按 `MEMORY_SESSION_TTL_DAYS`（默认 1 天） | memory | 短期对话缓存 |
| 7 | `memory:short_term:message:{messageId}` | String | 同上 | memory | messageId → chatId 索引 |
| 8 | `facts:{corpId}:{userId}:{sessionId}` | String (JSON) | 同上 | memory | 会话事实（Session Facts） |
| 9 | `stage:{corpId}:{userId}:{sessionId}` | String (JSON) | 同上 | memory | 程序性记忆（当前阶段 FSM） |
| 10 | `hosting:blacklist:groups:v1` | String (JSON) | 无（观察者主动刷新） | hosting-config | 群黑名单共享缓存 |
| 11 | `hosting:paused-users:v1` | String (JSON) | 无 | user | 暂停用户共享缓存 |
| 12 | `hosting:config:ai-reply-enabled:v1` | String (JSON) | 无 | hosting-config | AI 回复开关 |
| 13 | `hosting:config:message-merge-enabled:v1` | String (JSON) | 无 | hosting-config | 聚合开关 |
| 14 | `hosting:config:agent-reply-config:v1` | String (JSON) | 无 | hosting-config | Agent 回复配置（模型/延迟/阈值） |
| 15 | `monitoring:active_requests` | String | 无 | monitoring | 实时活跃请求数（跨实例） |
| 16 | `monitoring:peak_active_requests` | String | 无 | monitoring | 峰值请求数 |
| 17 | `room:members:{imRoomId}` | Set | 10 min | group-task | 群成员缓存 |
| 18 | `group-task:lock:{type}` | String | 15 min | group-task | 群任务执行锁 |
| 19 | `group-task:brand-history:{groupId}` | String (JSON) | 7 天 | group-task | 品牌轮转历史 |
| 20 | `geocode:v2:{key}` | String (JSON) | 30 天 | infra/geocoding | 高德地理编码缓存 |
| 21 | `test-suite:progress:{batchId}` | String (JSON) | 1 h | test-suite | 测试批次进度缓存 |

---

## 命名规范

```
{namespace}:{module}:{type}[:{qualifier}]
```

所有 key 都会被自动追加 `{env}:` 前缀（例如生产环境：`production:wecom:message:dedup:msg_123`）。`RedisKeyBuilder` 统一构造 `wecom:message:*` 系列，其他模块各自在 Service 中定义常量。

---

## 消息管道（wecom:message:*）

**Key 构造器**：[src/channels/wecom/message/runtime/redis-key.util.ts](../../src/channels/wecom/message/runtime/redis-key.util.ts) — `RedisKeyBuilder`

### 1. `wecom:message:dedup:{messageId}` — 消息去重

**代码位置**：[src/channels/wecom/message/runtime/deduplication.service.ts](../../src/channels/wecom/message/runtime/deduplication.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String |
| 存储内容 | 接收时间戳（毫秒） |
| TTL | 300s（由 `MESSAGE_DEDUP_TTL_SECONDS` 控制，默认 300） |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 原子标记 | `SET key value NX EX ttl` | 消息开始处理（acquired=true 首次；false 重复丢弃） |
| 存在检查 | `EXISTS` | 幂等校验 |
| 批量清理 | `SCAN` + `DEL`（模式 `wecom:message:dedup:*`） | 手动维护 |

> 使用原子 `SET NX EX` 消除了 TOCTOU 竞态。

---

### 2. `wecom:message:pending:{chatId}` — 消息聚合队列

**代码位置**：[src/channels/wecom/message/runtime/simple-merge.service.ts](../../src/channels/wecom/message/runtime/simple-merge.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | List（RPUSH + LRANGE + LTRIM） |
| 存储内容 | JSON 序列化的 `EnterpriseMessageCallbackDto` |
| TTL | 300s 兜底（正常由 Worker 主动裁剪） |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 追加消息 | `RPUSH` | 消息到达 |
| 设置兜底 TTL | `EXPIRE` | 每次追加后 |
| 获取队列长度 | `LLEN` | 观测 |
| 读取全部 | `LRANGE 0 -1` | Worker 触发静默窗口检查时 |
| 保留新消息 | `LTRIM length -1` | 仅裁剪已读消息，保留处理中到达的新消息 |

---

### 3. `wecom:message:last-message-at:{chatId}` — 最近消息时间

| 属性 | 值 |
|------|----|
| 数据结构 | String（毫秒时间戳） |
| TTL | 300s |

**用途**：给 Worker 判断“距离最后一条消息已静默足够久”（静默窗口 debounce 聚合的核心信号）。

---

### 4. `wecom:message:lock:{chatId}` — 处理分布式锁

| 属性 | 值 |
|------|----|
| 数据结构 | String（owner token：`job:{jobId}:{ts}`） |
| TTL | 300s |

**操作**：

| 操作 | Redis 命令 |
|------|-----------|
| 获取锁 | `SET key owner NX EX 300` |
| 释放锁 | Lua 脚本（仅当 value === owner 才 DEL） |

**用途**：防止同一会话被多 Worker 并发处理造成交错回复。

---

### 5. `wecom:message:trace:{messageId}` — 消息 Trace 上下文

**代码位置**：[src/channels/wecom/message/telemetry/message-trace-store.service.ts](../../src/channels/wecom/message/telemetry/message-trace-store.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON） |
| TTL | 86400s（24 小时） |

**用途**：跨阶段携带可观测上下文（入队 / Agent / 发送），Dashboard 查询时重建链路。

---

## 短期记忆（memory:short_term:*）

**Key 工具**：[src/biz/message/utils/chat-history-cache.util.ts](../../src/biz/message/utils/chat-history-cache.util.ts)

**代码位置**：[src/memory/services/short-term.service.ts](../../src/memory/services/short-term.service.ts) / [src/biz/message/services/chat-session.service.ts](../../src/biz/message/services/chat-session.service.ts)

### 6. `memory:short_term:chat:{chatId}` — 会话短期缓存

| 属性 | 值 |
|------|----|
| 数据结构 | List |
| 存储内容 | JSON `{ chatId, messageId, role, content, timestamp }` |
| TTL | `MEMORY_SESSION_TTL_DAYS * 86400`（默认 1 天） |

**操作**：`RPUSH`（追加）/ `LRANGE 0 -1`（读取）/ `LTRIM`（控制窗口）/ `EXPIRE` / `DEL`

**加载流程**：命中缓存直接返回；miss 时回源 `chat_messages`，写回缓存（backfill）。

### 7. `memory:short_term:message:{messageId}` — 消息索引

| 属性 | 值 |
|------|----|
| 数据结构 | String |
| 存储内容 | JSON `{ chatId }` |
| TTL | 同上 |

**用途**：根据 messageId 反查 chatId（用于消息更新/删除时命中对应会话缓存）。

---

## 会话/程序性记忆（facts:* / stage:*）

**Store 抽象**：[src/memory/stores/redis.store.ts](../../src/memory/stores/redis.store.ts) — 所有 entry 统一为 `{ key, content, updatedAt }`，支持 deepMerge 增量更新。

### 8. `facts:{corpId}:{userId}:{sessionId}` — 会话事实

**代码位置**：[src/memory/services/session.service.ts](../../src/memory/services/session.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON，Zod 校验） |
| 存储内容 | `WeworkSessionState`（已展示岗位、当前焦点岗位、已入群记录、品牌别名命中、抽取出的结构化事实等） |
| TTL | `MEMORY_SESSION_TTL_DAYS` 天 |

**操作**：`GET` / `SET EX`（支持 deepMerge） / `DEL`

### 9. `stage:{corpId}:{userId}:{sessionId}` — 程序性记忆

**代码位置**：[src/memory/services/procedural.service.ts](../../src/memory/services/procedural.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON） |
| 存储内容 | `{ currentStage, fromStage, advancedAt, reason }` — 招聘流程 FSM 当前阶段 |
| TTL | 同上 |

---

## 托管配置共享缓存（hosting:*）

三层缓存模式：内存 (~600ms) → Redis (共享) → Supabase（权威）。Observer 变更后会主动刷 Redis；其他实例通过定期拉取保持最终一致。

### 10. `hosting:blacklist:groups:v1` — 群黑名单共享缓存

**代码位置**：[src/biz/hosting-config/services/group-blacklist.service.ts](../../src/biz/hosting-config/services/group-blacklist.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON `{ items: string[], updatedAt }`） |
| TTL | 无（持久） |

### 11. `hosting:paused-users:v1` — 暂停用户共享缓存

**代码位置**：[src/biz/user/services/user-hosting.service.ts](../../src/biz/user/services/user-hosting.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON `{ users: string[], updatedAt }`） |
| TTL | 无 |

### 12-14. 功能开关与 Agent 配置

**代码位置**：[src/biz/hosting-config/services/system-config.service.ts](../../src/biz/hosting-config/services/system-config.service.ts)

| Key | 内容 |
|-----|------|
| `hosting:config:ai-reply-enabled:v1` | `{ value: boolean, updatedAt }` — AI 回复全局开关 |
| `hosting:config:message-merge-enabled:v1` | `{ value: boolean, updatedAt }` — 消息聚合开关 |
| `hosting:config:agent-reply-config:v1` | `{ value: AgentReplyConfig, updatedAt }` — 模型/延迟/思考模式/告警阈值 |

所有 key 无 TTL，更新由配置变更 Observer 驱动。

---

## 监控与任务（monitoring / group-task / group-membership）

### 15-16. 监控实时指标

**代码位置**：[src/biz/monitoring/services/tracking/monitoring-cache.service.ts](../../src/biz/monitoring/services/tracking/monitoring-cache.service.ts)

| Key | 结构 | 说明 |
|-----|------|------|
| `monitoring:active_requests` | String (int) | 实时活跃请求数（跨实例共享） |
| `monitoring:peak_active_requests` | String (int) | 峰值活跃请求数 |

**操作**：`INCRBY` / `SET` / `GET`，无 TTL。

### 17. `room:members:{imRoomId}` — 群成员缓存

**代码位置**：[src/biz/group-task/services/group-membership.service.ts](../../src/biz/group-task/services/group-membership.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | Set（imContactId） |
| TTL | 600s（10 分钟） |

**操作**：`SADD` / `SMEMBERS` / `EXPIRE` / `EXISTS` / `DEL`。整体通过 hydration 批量刷新，避免单次查询 API。

### 18. `group-task:lock:{type}` — 群任务执行锁

**代码位置**：[src/biz/group-task/services/group-task-scheduler.service.ts](../../src/biz/group-task/services/group-task-scheduler.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（owner token） |
| TTL | 900s（15 分钟） |

**操作**：`SET NX EX` 获取；Lua 脚本条件释放。

### 19. `group-task:brand-history:{groupId}` — 品牌轮转历史

**代码位置**：[src/biz/group-task/services/brand-rotation.service.ts](../../src/biz/group-task/services/brand-rotation.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON 数组） |
| TTL | 7 天（`7 * 24 * 3600` 秒） |

**用途**：记录该群最近推过的品牌，防重复；所有品牌推完后主动清空重置轮转。

---

## 其他业务缓存

### 20. `geocode:v2:{city}:{address}`（或 `geocode:v2:{address}`）— 高德地理编码缓存

**代码位置**：[src/infra/geocoding/geocoding.service.ts](../../src/infra/geocoding/geocoding.service.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON `GeocodeResult`） |
| TTL | 30 天（`30 * 24 * 3600` 秒） |

**用途**：缓存高德 POI 搜索和结构化地址解析结果，减少外部 API 调用。

### 21. `test-suite:progress:{batchId}` — 测试批次进度缓存

**代码位置**：[src/biz/test-suite/test-suite.processor.ts](../../src/biz/test-suite/test-suite.processor.ts)

| 属性 | 值 |
|------|----|
| 数据结构 | String（JSON `{ completedCases, successCount, failureCount, durations[] }`） |
| TTL | 3600s（1 小时兜底） |

**用途**：多 Worker 并发执行时共享批次进度（进度仅用于展示，完成判定以数据库为准）。

---

## Bull Queue

Bull Queue 使用独立的 Redis TCP 连接（`UPSTASH_REDIS_TCP_URL`），所有队列 Key 由 Bull 自动管理，前缀固定为 `bull:{RUNTIME_ENV|NODE_ENV}`。

**全局配置**（[src/infra/queue/bull.module.ts](../../src/infra/queue/bull.module.ts)）：

| 项 | 值 |
|----|----|
| `defaultJobOptions.removeOnComplete` | 100（保留最近 100 条） |
| `defaultJobOptions.removeOnFail` | 1000 |
| `settings.stalledInterval` | 30000 ms |
| `settings.lockDuration` | 60000 ms |
| `settings.lockRenewTime` | 15000 ms |
| `settings.maxStalledCount` | 2 |
| `settings.guardInterval` | 1000 ms（delayed job 激活轮询，压低排队抖动） |

### 队列 1：`message-merge` — 消息聚合

**代码位置**：[src/channels/wecom/message/runtime/simple-merge.service.ts](../../src/channels/wecom/message/runtime/simple-merge.service.ts) + [src/channels/wecom/message/runtime/message.processor.ts](../../src/channels/wecom/message/runtime/message.processor.ts)

**Job 数据**：`{ chatId: string }`（jobId 格式：`{chatId}:{messageId}` 或 `{chatId}:followup:{ts}`）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `attempts` | 3 | 失败重试次数 |
| `backoff` | exponential / 2000ms | 指数退避 |
| `delay` | `mergeDelayMs` | 动态，取自 runtime 配置（默认 2000ms） |
| `removeOnComplete` | true | |
| `removeOnFail` | false | 保留用于调试 |
| 并发数 | 动态 | 由 `MessageWorkerManagerService` 管理 |

**聚合参数**（来自 Supabase `hosting_config` / `system_config.agent_reply_config`，Dashboard 动态调整）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `initialMergeWindowMs` | 3000ms | 距离最后一条用户消息静默多久后才触发 Agent（debounce 窗口） |

> 每条到达的消息都会注册一个 `delay=initialMergeWindowMs` 的 Bull job，Worker 执行时若"距最后一条消息已静默够久"才真正取出整个 Redis List 交给 Agent，否则跳过（由后续消息注册的 job 接力）。因此不再需要 `maxMergedMessages` 上限。

### 队列 2：`test-suite` — 测试套件

**代码位置**：[src/biz/test-suite/test-suite.processor.ts](../../src/biz/test-suite/test-suite.processor.ts)

**Job 数据**：

```ts
{
  batchId: string;
  caseId: string;
  caseName: string;
  category?: string;
  message: string;
  history?: Array<{ role: MessageRole; content: string }>;
  expectedOutput?: string;
  totalCases: number;
  caseIndex: number;
}
```

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `attempts` | 2 | 失败重试 1 次 |
| `backoff` | exponential / 5000ms | 指数退避 |
| `timeout` | 120000ms | 单任务超时（2 分钟） |
| `removeOnComplete` | true | |
| `removeOnFail` | false | |
| 并发数 | 3 | 硬编码 |

**Bull 内部 keys**（自动管理，不需要手动操作）：

```
bull:{env}:message-merge:{waiting|active|completed|failed|delayed|{jobId}}
bull:{env}:test-suite:{waiting|active|completed|failed|delayed|{jobId}}
```

---

## 数据生命周期

| 数据类型 | TTL | 清理方式 |
|---------|-----|---------|
| 消息去重 | 5 min | Redis 自动过期 |
| 消息聚合队列 / last-message-at / 处理锁 | 5 min（兜底） | Worker 主动裁剪 / Lua 释放 |
| 消息 trace | 24 h | 自动过期 |
| 短期记忆缓存 | `MEMORY_SESSION_TTL_DAYS`（默认 1 天） | 自动过期 |
| Session Facts / 程序性记忆 | 同上 | 自动过期 |
| 托管共享缓存 | 无 | 观察者 / 定期同步 |
| 监控实时计数 | 无 | 持续累计 |
| 群成员缓存 | 10 min | 自动过期 + 定期 hydrate |
| 群任务锁 | 15 min | Lua 条件释放 |
| 品牌轮转历史 | 7 天 | 自动过期或业务重置 |
| 地理编码缓存 | 30 天 | 自动过期 |
| 测试批次进度 | 1 h（兜底） | 批次完成后主动 DEL |

**消息处理 Redis 时序（简版）**：

```
消息到达
  ① SET wecom:message:dedup:{msgId} NX EX 300
     → OK：首次处理 / null：重复丢弃
  ② RPUSH wecom:message:pending:{chatId}
     SETEX wecom:message:last-message-at:{chatId} 300 {now}
     EXPIRE wecom:message:pending:{chatId} 300
  ③ Bull add('process', { chatId }, { jobId: `${chatId}:${msgId}`, delay: mergeDelayMs })

[静默窗口后 Worker 触发]
  ④ 读 last-message-at 判断是否已静默；未满足则追加一个 followup job 后退出
  ⑤ SET wecom:message:lock:{chatId} NX EX 300（抢锁）
  ⑥ LRANGE pending 0 -1 → LTRIM length -1（只裁剪已读部分）
  ⑦ 调用 Agent → 发送回复
  ⑧ Lua 释放 lock
```

---

## 连接配置

| 用途 | 连接方式 | 环境变量 |
|------|---------|---------|
| 所有 Service 缓存操作 | REST（`@upstash/redis`） | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |
| Bull Queue 任务队列 | TCP（`ioredis`） | `UPSTASH_REDIS_TCP_URL` |
| 备选：通用 Redis | TCP | `REDIS_URL`（或 `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`） |

```bash
# 禁用 Bull Queue（本地开发无 Redis）
ENABLE_BULL_QUEUE=false
```

---

## 故障排查

```bash
# 检查消息去重 key
curl -X GET "$UPSTASH_REDIS_REST_URL/exists/production:wecom:message:dedup:{msgId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查聚合队列长度
curl -X GET "$UPSTASH_REDIS_REST_URL/llen/production:wecom:message:pending:{chatId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查会话 facts
curl -X GET "$UPSTASH_REDIS_REST_URL/get/production:facts:{corpId}:{userId}:{sessionId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查短期记忆缓存长度
curl -X GET "$UPSTASH_REDIS_REST_URL/llen/production:memory:short_term:chat:{chatId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查测试批次进度
curl -X GET "$UPSTASH_REDIS_REST_URL/get/production:test-suite:progress:{batchId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

> 所有 Key 实际存储时都带有 `{env}:` 前缀（例如 `production:`、`staging:`、`development:`），`RedisService.withPrefix` 自动处理，故障排查时不要遗漏前缀。

---

**参考**：

- [database-schema.md](./database-schema.md) — Supabase 数据库表设计
- [CLAUDE.md](../../CLAUDE.md) — 项目配置与环境变量
- [src/memory/README.md](../../src/memory/README.md) — 四层记忆系统详解
