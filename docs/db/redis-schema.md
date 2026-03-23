# Redis Key 设计与使用说明

> Cake Agent Runtime - Redis (Upstash) 缓存层设计文档

**最后更新**：2026-03-12

**Redis 客户端**：`@upstash/redis`（REST API 模式）| **连接方式**：`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

**Key 常量定义**：`src/channels/wecom/message/utils/redis-key.util.ts`

---

## 目录

- [总览](#总览)
- [命名规范](#命名规范)
- [消息模块（wecom:message:*）](#消息模块wecommessage)
  - [wecom:message:dedup](#1-wecommessagededup---消息去重)
  - [wecom:message:pending](#2-wecommessagepending---消息聚合队列)
- [测试套件模块（test-suite:*）](#测试套件模块test-suite)
  - [test-suite:progress](#3-test-suiteprogress---测试批次进度缓存)
- [Bull Queue](#bull-queue)
- [数据生命周期](#数据生命周期)
- [连接配置](#连接配置)
- [故障排查](#故障排查)

---

## 总览

| # | Key 模式 | 数据结构 | TTL | 所属模块 | 用途 |
|---|---------|---------|-----|---------|------|
| 1 | `wecom:message:dedup:{id}` | String | 5min | wecom/message | 消息去重标记（原子 SET NX EX） |
| 2 | `wecom:message:pending:{chatId}` | List | 5min | wecom/message | 消息聚合队列 |
| 3 | `test-suite:progress:{batchId}` | String（JSON） | 1h | biz/test-suite | 测试批次执行进度缓存 |

---

## 命名规范

```
{namespace}:{domain}:{type}[:{qualifier}]
```

| 命名空间 | 含义 | 示例 |
|---------|------|------|
| `wecom` | 企业微信消息处理 | `wecom:message:dedup:msg_123` |
| `test-suite` | 测试套件执行进度 | `test-suite:progress:batch_abc` |

---

## 消息模块（wecom:message:*）

**Key 常量**：`src/channels/wecom/message/utils/redis-key.util.ts` — `RedisKeyBuilder`

### 1. wecom:message:dedup - 消息去重

**用途**：防止同一条消息被重复处理（幂等保障）

**代码位置**：`src/channels/wecom/message/services/message-deduplication.service.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `wecom:message:dedup:{messageId}` |
| 数据结构 | String |
| 存储内容 | 接收时间戳（毫秒字符串） |
| TTL | 300s，由 `MESSAGE_DEDUP_TTL_SECONDS` 环境变量控制 |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 原子标记 | `SET key value NX EX ttl` | 消息开始处理时（OK=首次，null=重复） |
| 批量清理 | `SCAN` + `DEL` | 手动维护 |

> 使用原子 `SET NX EX` 消除了分布式竞态条件（TOCTOU）。

**示例**：

```
Key:   wecom:message:dedup:7881298543@chatroom_1748123456789
Value: "1773250000000"
TTL:   298s
```

---

### 2. wecom:message:pending - 消息聚合队列

**用途**：暂存同一会话在聚合窗口内到达的多条消息，等待批量发送给 AI

**代码位置**：`src/channels/wecom/message/services/simple-merge.service.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `wecom:message:pending:{chatId}` |
| 数据结构 | List（右进左出） |
| 存储内容 | JSON 序列化的消息对象 |
| TTL | 300s 兜底（正常由 Worker 主动清除） |

**操作**：

| 操作 | Redis 命令 | 触发时机 |
|------|-----------|---------|
| 追加消息 | `RPUSH` | 消息到达 |
| 设置兜底 TTL | `EXPIRE` | 每次追加后 |
| 获取队列长度 | `LLEN` | 检查是否超过最大聚合数 |
| 取出所有消息 | `LRANGE 0 -1` | 聚合 Worker 触发时 |
| 清空队列 | `DEL` | 消息取出后立即删除 |

---

## 测试套件模块（test-suite:*）

### 3. test-suite:progress - 测试批次进度缓存

**用途**：多 Worker 并发执行时共享批次进度，供前端轮询（进度仅用于展示，完成判断以数据库为准）

**代码位置**：`src/biz/test-suite/test-suite.processor.ts`

| 属性 | 值 |
|------|----|
| Key 格式 | `test-suite:progress:{batchId}` |
| 数据结构 | String（JSON） |
| TTL | 3600s（1小时兜底） |

**JSON 结构**：

```typescript
{
  completedCases: number;  // 已完成用例数
  successCount:   number;  // 成功数
  failureCount:   number;  // 失败数
  durations:      number[]; // 各用例耗时（ms）
}
```

**操作**：

| 操作 | Redis 命令 | 触发时机 |
| --- | --- | --- |
| 写入/更新进度 | `SET key value EX 3600` | 每个测试用例完成后 |
| 读取进度 | `GET key` | 前端轮询 |
| 删除进度 | `DEL key` | 批次全部完成后 |

---

## Bull Queue

Bull Queue 使用独立的 Redis TCP 连接，当前共有 **2 个队列**：`message-merge`（消息聚合）和 `test-suite`（测试套件）。

### 队列 1：message-merge（消息聚合）

**代码位置**：`src/channels/wecom/message/services/simple-merge.service.ts` + `src/channels/wecom/message/message.processor.ts`

**Job 数据结构**：

```typescript
{ chatId: string }  // 同时作为 jobId，保证同一会话只有一个等待任务
```

**队列配置**：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `attempts` | 3 | 失败重试次数 |
| `backoff` | exponential / 2000ms | 指数退避 |
| `removeOnComplete` | true | 完成后自动删除 |
| `removeOnFail` | false | 失败任务保留 |
| `stalledInterval` | 30000ms | 卡住检测间隔 |
| `lockDuration` | 60000ms | 任务锁定时长 |
| 并发数 | 4 | 来自 Supabase `system_config` |

**聚合参数**（来自 Supabase `system_config`）：

| 参数 | 默认值 | 环境变量覆盖 |
| --- | --- | --- |
| `initialMergeWindowMs` | 2000ms | `INITIAL_MERGE_WINDOW_MS` |
| `maxMergedMessages` | 5 | `MAX_MERGED_MESSAGES` |

---

### 队列 2：test-suite（测试套件）

**代码位置**：`src/biz/test-suite/test-suite.processor.ts`

**Job 数据结构**：

```typescript
{
  batchId: string;
  caseId: string;
  caseName: string;
  message: string;
  history?: Array<{ role: MessageRole; content: string }>;
  expectedOutput?: string;
  totalCases: number;
  caseIndex: number;
}
```

**队列配置**：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `attempts` | 2 | 失败重试 1 次 |
| `backoff` | exponential / 5000ms | 指数退避 |
| `timeout` | 120000ms | 单任务超时（2 分钟） |
| `removeOnComplete` | true | 完成后自动删除 |
| `removeOnFail` | false | 失败任务保留 |
| 并发数 | 3 | 硬编码 |

---

**Bull Queue 的 Redis 内部 Keys**（由框架自动管理）：

```
bull:message-merge:waiting / active / completed / failed / delayed / {jobId}
bull:test-suite:waiting   / active / completed / failed / delayed / {jobId}
```

---

## 数据生命周期

| 数据类型 | TTL | 清理方式 |
|---------|-----|---------|
| 消息去重标记 | 5 min | Redis 自动过期 |
| 消息聚合队列 | 5 min（兜底） | Worker 处理后主动 DEL |
| 测试批次进度 | 1h（兜底） | 批次完成后主动 DEL |

**消息处理 Redis 时序**：

```
消息到达
  ① SET wecom:message:dedup:{msgId} NX EX 300
     → OK：首次处理 / null：重复丢弃
  ② RPUSH wecom:message:pending:{chatId}
     EXPIRE wecom:message:pending:{chatId} 300
  ③ Bull 创建延迟 Job（jobId=chatId，delay=2s，重复则跳过）

[2s 后 Worker 触发]
  ④ LRANGE 0 -1 → DEL wecom:message:pending:{chatId}
  ⑤ 调用 Agent API
```

---

## 连接配置

| 用途 | 连接方式 | 环境变量 |
|------|---------|---------|
| 所有 Service 缓存操作 | REST（`@upstash/redis`） | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |
| Bull Queue 任务队列 | TCP（`ioredis`） | `UPSTASH_REDIS_TCP_URL` |

```bash
# 禁用 Bull Queue（本地开发）
ENABLE_BULL_QUEUE=false
```

---

## 故障排查

```bash
# 消息去重 key 是否存在
curl -X GET "$UPSTASH_REDIS_REST_URL/exists/wecom:message:dedup:{msgId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 消息聚合队列长度
curl -X GET "$UPSTASH_REDIS_REST_URL/llen/wecom:message:pending:{chatId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 测试批次进度
curl -X GET "$UPSTASH_REDIS_REST_URL/get/test-suite:progress:{batchId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

---

**参考**：
- [database-schema.md](./database-schema.md) — Supabase 数据库表设计
- [CLAUDE.md](../../CLAUDE.md) — 项目配置与环境变量
