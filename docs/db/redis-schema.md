# Redis Key 设计与使用说明

> Cake Agent Runtime - Redis (Upstash) 缓存层设计文档

**最后更新**　2026-11-24

**Redis 客户端**：`@upstash/redis`（REST）+ `ioredis`（Bull Queue TCP）

**连接环境变量**：`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`（REST） | `UPSTASH_REDIS_TCP_URL`（Bull TCP）

**环境隔离**：所有 Redis 调用都会被 `RedisService.withPrefix` 自动加上 `{RUNTIME_ENV|NODE_ENV}:` 前缀（Bull 队列同样会加 `bull:{env}` 前缀），多环境共享同一实例时物理隔离。

---

## 目录

- [租户业务键](#租户业务键)
- [总览](#总览)
- [命名规范](#命名规范)
- [消息管道（wecom:message:\*）](#消息管道wecommessage)
- [短期记忆（memory:short_term:\*）](#短期记忆memoryshort_term)
- [会话状态、长期缓存与工具单据](#会话状态长期缓存与工具单据)
- [托管配置共享缓存（hosting:\*）](#托管配置共享缓存hosting)
- [监控与任务（monitoring / group-task / group-membership）](#监控与任务monitoring--group-task--group-membership)
- [其他业务缓存](#其他业务缓存)
- [Bull Queue](#bull-queue)
- [数据生命周期](#数据生命周期)
- [连接配置](#连接配置)
- [故障排查](#故障排查)

---

## 租户业务键

下表的每个后缀都接在 `{env}:tenant:{encodedTenantId}:` 后。环境取 `RUNTIME_ENV`、`NODE_ENV`、`development` 中首个有效值。租户取原始业务的组织，对组织 ID 调用 `encodeURIComponent`。例如，测试环境河南会话的预约指针可以是 `test:tenant:henan:active-booking:corp-demo:user-demo`。同一企业和候选人在另一个租户会得到不同的键。

| 用途 | 前缀后的完整键 | 默认 TTL | 数据来源 |
| --- | --- | --- | --- |
| 收资表实体 | `collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}` | 7 天 | 表单的完整状态 |
| 当前办理人 | `collection-form-current:{corpId}:{userId}:{botUserId}:{jobId}` | 7 天 | 当前办理表单的人键，可以是代报名人 |
| 主候选人 | `collection-form-primary:{corpId}:{userId}:{botUserId}:{jobId}` | 7 天 | 主联系人的表单指针 |
| 预约指针 | `active-booking:{corpId}:{userId}` | 2 小时 | 回源本租户 `agent_long_term_memories` 中 `bot_user_id IS NULL` 的行，预约动作后失效 |
| 预约快照 | `booking:snapshot:{botImId}:{phone}` | 5 分钟 | 用该 Bot 配置的凭据查询海绵工单 |
| 候选人快照镜像 | `booking:snapshot:candidate:{corpId}:{userId}` | 最多 5 分钟 | 出站守卫按候选人读取。命中原快照时沿用剩余有效期 |
| 会话最近消息 | `memory:short_term:chat:{chatId}` | 7 天 | 消息热缓存 |
| 会话事实与工作台 | `factsv2:{corpId}:{userId}:{sessionId}` | 7 天加 12 小时 | 会话事实与工作台共用一个 Redis Hash |
| 阶段指针 | `stage:{corpId}:{userId}:{sessionId}` | 7 天加 12 小时 | 随会话写入续期 |
| 长期关系档缓存 | `long-term:{corpId}:{userId}:{botUserId}` | 2 小时 | 本租户、候选人与 Bot 的关系档 |

服务在原消息或任务的租户上下文中构造这些键。业务归属显式待核实时会报错。无业务上下文的平台调用使用仅带环境前缀的旧格式。租户作用域的收资表和预约缓存读取不会尝试旧键。[前缀](../../src/infra/supabase/business-tenant.ts) · [收资表和两个指针](../../src/tools/collection/collection-form.store.ts) · [预约指针](../../src/memory/stores/supabase.store.ts) · [预约快照和镜像](../../src/tools/booking/booking-snapshot.service.ts)

跨租户共用的运行时键仅加环境前缀。下列几组与预约、托管或排查常有关联：

| 用途 | 键或键族 |
| --- | --- |
| 海绵单笔工单，5 分钟 | `sponge:workorder:{workOrderId}`，按海绵工单号缓存单笔详情，键未包含租户和 Bot。 |
| 带外工单反查索引，30 天 | `oob:phone:{encodedBotImId}:{phone}`、`oob:phone:{phone}`（旧记录或缺 Bot）、`oob:chat:{chatId}`。扫描按 Bot 核实命中结果后处理。 |
| 带外工单扫描与去重 | `oob:reconcile-scan:lock:v1`、`oob:reconcile-scan:progress:v1`、`oob:anchor:{chatId}:{anchorKey}`、`oob:booked:{chatId}` |
| 主动复聊频控与投递 | `reengagement:touch:{touchKey}`、`reengagement:sent:{sessionId}`、`reengagement:lastTouch:{sessionId}`、`reengagement:once:{key}` |
| 托管与调度 | 候选人黑名单 `hosting:blacklist:candidates:v2`、暂停过期锁 `hosting:paused-users:expire-lock:v1`，以及下表中的小组黑名单、暂停用户缓存和全局开关 |
| 群任务 | `group-task:msg:{execId}:{groupKey}`、`group-task:result:{execId}:{groupId}`、`group-task:meta:{execId}`、`group-task:bot-dispatch-lock:{imBotId}`、`group-task:bot-last-dispatch:{imBotId}`、`group-task:sent:{type}:{date[-timeSlot]}:{groupId}` |
| 平台定时任务、评测 | `cron:lock:{id}`、`cron:last-observed:{id}`、`cron:lifecycle:{id}`、`cron:sponge-status-poll:cursor:v2`、`ops:job-data-audit:lock`、`test-suite:feedback:dedup:{digest}` |

消息去重、合并队列、会话处理锁、监控计数和 Bull 队列也各有共享键。租户在后台能查到哪些消息、能暂停哪个会话，由服务端按数据库中的归属核对。下面各节均以业务后缀描述键的结构。

## 总览

| #   | Key 模式                                                               | 数据结构      | TTL                        | 所属模块        | 用途                                |
| --- | ---------------------------------------------------------------------- | ------------- | -------------------------- | --------------- | ----------------------------------- |
| 1   | `wecom:message:dedup:{messageId}`                                      | String        | 5 min                      | wecom/message   | 消息去重（SET NX EX）               |
| 2   | `wecom:message:pending:{chatId}`                                       | List          | 5 min                      | wecom/message   | 消息聚合队列                        |
| 3   | `wecom:message:last-message-at:{chatId}`                               | String        | 5 min                      | wecom/message   | 最近消息到达时间（静默窗口）        |
| 4   | `wecom:message:lock:{chatId}`                                          | String        | 90 s 租约（30 s 心跳续期） | wecom/message   | 处理分布式锁（Lua 条件续期/释放）   |
| 5   | `wecom:message:trace:{messageId}:v2`                                   | Hash          | 24 h                       | wecom/message   | 消息 trace 上下文（字段级增量更新） |
| 6   | `memory:short_term:chat:{chatId}`                                      | List          | 7 天                       | memory          | 消息热缓存；滚动 7 天窗口在内存套用 |
| 7   | `factsv2:{corpId}:{userId}:{sessionId}`                                | Hash          | 7 天 + 12 小时             | memory          | 会话 facts + 工作台                 |
| 8   | `stage:{corpId}:{userId}:{sessionId}`                                  | String (JSON) | 7 天 + 12 小时                       | memory          | short-term 阶段指针                 |
| 9   | `long-term:{corpId}:{userId}:{botUserId}`                              | String (JSON) | 2 小时                     | memory          | 长期关系档缓存                      |
| 10  | `collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}` | String (JSON) | 7 天                       | tools           | 收资表单完整实体                    |
| 11  | `collection-form-current:{corpId}:{userId}:{botUserId}:{jobId}`        | String (JSON) | 7 天                       | tools           | 当前办理人定位指针                  |
| 12  | `hosting:blacklist:groups:v1`                                          | String (JSON) | 无（观察者主动刷新）       | hosting-config  | 群黑名单共享缓存                    |
| 13  | `hosting:paused-users:v2`                                              | String (JSON) | 无                         | user            | 暂停用户共享缓存                    |
| 14  | `hosting:config:ai-reply-enabled:v1`                                   | String (JSON) | 无                         | hosting-config  | AI 回复开关                         |
| 15  | `hosting:config:message-merge-enabled:v1`                              | String (JSON) | 无                         | hosting-config  | 聚合开关                            |
| 16  | `hosting:config:agent-reply-config:v1`                                 | String (JSON) | 无                         | hosting-config  | Agent 回复配置（模型/延迟/阈值）    |
| 17  | `monitoring:active_requests`                                           | String        | 无                         | monitoring      | 实时活跃请求数（跨实例）            |
| 18  | `monitoring:peak_active_requests`                                      | String        | 无                         | monitoring      | 峰值请求数                          |
| 19  | `room:members:{imRoomId}`                                              | Set           | 10 min                     | group-task      | 群成员缓存                          |
| 20  | `group-task:lock:{type}`                                               | String        | 15 min                     | group-task      | 群任务执行锁                        |
| 21  | `group-task:brand-history:{groupId}`                                   | String (JSON) | 7 天                       | group-task      | 品牌轮转历史                        |
| 22  | `geocode:v2:{key}`                                                     | String (JSON) | 30 天                      | infra/geocoding | 高德地理编码缓存                    |
| 23  | `test-suite:progress:{batchId}`                                        | String (JSON) | 1 h                        | test-suite      | 测试批次进度缓存                    |

---

## 命名规范

```
{namespace}:{module}:{type}[:{qualifier}]
```

所有 key 都会被自动追加 `{env}:` 前缀（例如生产环境：`production:wecom:message:dedup:msg_123`）。`RedisKeyBuilder` 统一构造 `wecom:message:*` 系列，其他模块各自在 Service 中定义常量。

---

## 消息管道（wecom:message:\*）

**Key 构造器**：[src/channels/wecom/message/runtime/redis-key.util.ts](../../src/channels/wecom/message/runtime/redis-key.util.ts) — `RedisKeyBuilder`

### 1. `wecom:message:dedup:{messageId}` — 消息去重

**代码位置**：[src/channels/wecom/message/runtime/deduplication.service.ts](../../src/channels/wecom/message/runtime/deduplication.service.ts)

| 属性     | 值                                                    |
| -------- | ----------------------------------------------------- |
| 数据结构 | String                                                |
| 存储内容 | 接收时间戳（毫秒）                                    |
| TTL      | 300s（由 `MESSAGE_DEDUP_TTL_SECONDS` 控制，默认 300） |

**操作**：

| 操作     | Redis 命令                                     | 触发时机                                           |
| -------- | ---------------------------------------------- | -------------------------------------------------- |
| 原子标记 | `SET key value NX EX ttl`                      | 消息开始处理（acquired=true 首次；false 重复丢弃） |
| 存在检查 | `EXISTS`                                       | 幂等校验                                           |
| 批量清理 | `SCAN` + `DEL`（模式 `wecom:message:dedup:*`） | 手动维护                                           |

> 使用原子 `SET NX EX` 消除了 TOCTOU 竞态。

---

### 2. `wecom:message:pending:{chatId}` — 消息聚合队列

**代码位置**：[src/channels/wecom/message/runtime/simple-merge.service.ts](../../src/channels/wecom/message/runtime/simple-merge.service.ts)

| 属性     | 值                                           |
| -------- | -------------------------------------------- |
| 数据结构 | List（RPUSH + LRANGE + LTRIM）               |
| 存储内容 | JSON 序列化的 `EnterpriseMessageCallbackDto` |
| TTL      | 300s 兜底（正常由 Worker 主动裁剪）          |

**操作**：

| 操作         | Redis 命令        | 触发时机                               |
| ------------ | ----------------- | -------------------------------------- |
| 追加消息     | `RPUSH`           | 消息到达                               |
| 设置兜底 TTL | `EXPIRE`          | 每次追加后                             |
| 获取队列长度 | `LLEN`            | 观测                                   |
| 读取全部     | `LRANGE 0 -1`     | Worker 触发静默窗口检查时              |
| 保留新消息   | `LTRIM length -1` | 仅裁剪已读消息，保留处理中到达的新消息 |

---

### 3. `wecom:message:last-message-at:{chatId}` — 最近消息时间

| 属性     | 值                                    |
| -------- | ------------------------------------- |
| 数据结构 | String（毫秒时间戳）                  |
| TTL      | 90s 单次租约；持锁期间每 30s 条件续期 |

**用途**：给 Worker 判断“距离最后一条消息已静默足够久”（静默窗口 debounce 聚合的核心信号）。

---

### 4. `wecom:message:lock:{chatId}` — 处理分布式锁

| 属性     | 值                                        |
| -------- | ----------------------------------------- |
| 数据结构 | String（owner token：`job:{jobId}:{ts}`） |
| TTL      | 300s                                      |

**操作**：

| 操作   | Redis 命令                                    |
| ------ | --------------------------------------------- |
| 获取锁 | `SET key owner NX EX 90`                      |
| 续期   | Lua 脚本（仅当 value === owner 才 EXPIRE 90） |
| 释放锁 | Lua 脚本（仅当 value === owner 才 DEL）       |

**用途**：防止同一会话被多 Worker 并发处理造成交错回复。

---

### 5. `wecom:message:trace:{messageId}:v2` — 消息 Trace 上下文

**代码位置**：[src/channels/wecom/message/telemetry/message-trace-store.service.ts](../../src/channels/wecom/message/telemetry/message-trace-store.service.ts)

| 属性     | 值                                                |
| -------- | ------------------------------------------------- |
| 数据结构 | Hash（大对象按顶层字段拆分，timing 按时间点拆分） |
| TTL      | 86400s（24 小时）                                 |

**字段布局**：

| Field                                 | 内容                                      |
| ------------------------------------- | ----------------------------------------- |
| `request`                             | 入站请求摘要                              |
| `agentRequest` / `agentResult`        | Agent 请求与结果，各只写入一次            |
| `deliveryResult` / `fallbackDelivery` | 投递结果                                  |
| `timing:{name}`                       | 单个阶段时间戳，通过 HSET/HSETNX 原子更新 |
| `_traceSchema`                        | Schema 版本，当前为 `2`                   |

**用途**：跨阶段携带可观测上下文（入队 / Agent / 发送），结束时完整读取一次并重建 Dashboard 链路。V2 避免每个阶段都 GET/SET 整份 Agent Trace；旧的 `wecom:message:trace:{messageId}` String Key 仅用于滚动发布兼容读取，并在链路结束时一并删除。

---

## 短期记忆（memory:short_term:\*）

**Key 工具**：[src/memory/short-term/chat-history-cache.util.ts](../../src/memory/short-term/chat-history-cache.util.ts)

**代码位置**：[src/memory/short-term/message-window.service.ts](../../src/memory/short-term/message-window.service.ts) / [src/biz/message/services/chat-session.service.ts](../../src/biz/message/services/chat-session.service.ts)

### 6. `memory:short_term:chat:{chatId}` — 会话短期缓存

| 属性     | 值                                                     |
| -------- | ------------------------------------------------------ |
| 数据结构 | List                                                   |
| 存储内容 | JSON `{ chatId, messageId, role, content, timestamp }` |
| TTL      | `MEMORY_SESSION_TTL_DAYS * 86400`（当前默认 7 天）     |

**操作**：`RPUSHX`（写路径追加，只在 key 已存在时生效）/ `LRANGE 0 -1`（读取）/ `LTRIM`（控制窗口）/ `EXPIRE` / `DEL`（`updateMessageContent` 作废）

**加载流程**：命中缓存直接返回（同样套滚动 7 天窗口，锚点 = 本批之前候选人最后一次开口）；miss 时回源 `chat_messages`，用一个 Lua 脚本原子重建
（`DEL + RPUSH 全量 + LTRIM + EXPIRE`）。

**创建约束**：key 只由回填创建。写路径用 `RPUSHX + LTRIM + EXPIRE` 单脚本追加，key 不存在即跳过；
否则作废后到达的第一条消息会建出「只含自己」的 list，被读路径当成完整历史。

注意：这个 TTL 只控制 Redis 短期缓存的存活时间；DB 回源只按 `MAX_HISTORY_PER_CHAT` 条数封顶，`MEMORY_HISTORY_WINDOW_DAYS` 的滚动窗口在内存里对命中与回源统一套用。

## 会话状态、长期缓存与工具单据

### 7. `factsv2:{corpId}:{userId}:{sessionId}` — 会话 facts + 工作台

**代码位置**：
[src/memory/short-term/facts.service.ts](../../src/memory/short-term/facts.service.ts) /
[src/memory/short-term/workbench.service.ts](../../src/memory/short-term/workbench.service.ts)

| 属性     | 值                                                           |
| -------- | ------------------------------------------------------------ |
| 数据结构 | Redis Hash；字段级原子写                                     |
| 存储内容 | `facts` + 岗位池、已展示岗位、焦点岗位、查询签名等 workbench |
| TTL      | 7 天 + 12 小时安全余量                                       |

Redis Hash 不支持 field TTL，因此 facts 与 workbench 共享同一个 key 生命周期。额外 12 小时只用于
确保 delayed consolidation 先读取再过期，不构成新的业务窗口。

### 8. `stage:{corpId}:{userId}:{sessionId}` — 阶段指针

**代码位置**：
[src/memory/short-term/workbench.service.ts](../../src/memory/short-term/workbench.service.ts)

| 属性     | 值                        |
| -------- | ------------------------- |
| 数据结构 | String（统一 entry JSON） |
| 存储内容 | `{ currentStage }`        |
| TTL      | 7 天 + 12 小时                      |

阶段属于 short-term working state；“procedural”是 Prompt 手册/规则的内容类型，不是本 key 的存储层。

### 9. `long-term:{corpId}:{userId}:{botUserId}` — 长期关系档缓存

**代码位置**：
[src/memory/stores/supabase.store.ts](../../src/memory/stores/supabase.store.ts)

| 属性     | 值                                        |
| -------- | ----------------------------------------- |
| 数据结构 | String（统一 entry JSON）                 |
| 存储内容 | 当前候选人 × bot 的 `LongTermMemory` 投影 |
| TTL      | 2 小时                                    |

Supabase `agent_long_term_memories` 是权威源。无 bot 的旧缓存 key 不再读取，等待自然过期。

### 收资表单实体与定位指针

**代码位置**：
[src/tools/collection/collection-form.store.ts](../../src/tools/collection/collection-form.store.ts)

| Key                                                                    | 内容                              | TTL  |
| ---------------------------------------------------------------------- | --------------------------------- | ---- |
| `collection-form:{corpId}:{userId}:{botUserId}:{candidateRef}:{jobId}` | 完整 `BookingCollectionForm` 快照 | 7 天 |
| `collection-form-current:{corpId}:{userId}:{botUserId}:{jobId}`        | 当前办理人的 `candidateRef`       | 7 天 |
| `collection-form-primary:{corpId}:{userId}:{botUserId}:{jobId}` | 主候选人的 `candidateRef` | 7 天 |

collection form 是 tools 自持的业务单据，不属于 memory；它采用整实体覆盖写，不使用 deep merge。
租户前缀见上表。手机号到达前 `candidateRef=session`，到达后
由 `CollectionFormService` rebind 到 11 位手机号；稳定 `botUserId` 继续作为隔离维度。

`BookingCollectionForm`、`FormSlot`、recap、errorList 和提交终态只存在于上述 key，绝不写入
`factsv2:*`。表单逐格落定或 booking 成功时，应用桥接层只把对应候选人字段值信封回写
session / long-term memory，不搬运表单实体或槽位状态。

---

## 托管配置共享缓存（hosting:\*）

三层缓存模式：内存 (~600ms) → Redis (共享) → Supabase（权威）。Observer 变更后会主动刷 Redis；其他实例通过定期拉取保持最终一致。

### 12. `hosting:blacklist:groups:v1` — 群黑名单共享缓存

**代码位置**：[src/biz/hosting-config/services/group-blacklist.service.ts](../../src/biz/hosting-config/services/group-blacklist.service.ts)

| 属性     | 值                                              |
| -------- | ----------------------------------------------- |
| 数据结构 | String（JSON `{ items: string[], updatedAt }`） |
| TTL      | 无（持久）                                      |

### 13. `hosting:paused-users:v2` — 暂停用户共享缓存

> v2 起面试后转人工改为临时暂停，旧 v1 快照不再兼容。快照无 TTL，只在键缺失或到期解除时从数据库重建；回滚到仍读 v1 的版本前，须先删除带环境前缀的 v1 键，否则旧版本会沿用冻结的快照。

**代码位置**：[src/biz/user/services/user-hosting.service.ts](../../src/biz/user/services/user-hosting.service.ts)

| 属性     | 值                                              |
| -------- | ----------------------------------------------- |
| 数据结构 | String（JSON `{ users: string[], updatedAt }`） |
| TTL      | 无                                              |

### 14-16. 功能开关与 Agent 配置

**代码位置**：[src/biz/hosting-config/services/system-config.service.ts](../../src/biz/hosting-config/services/system-config.service.ts)

| Key                                       | 内容                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `hosting:config:ai-reply-enabled:v1`      | `{ value: boolean, updatedAt }` — AI 回复全局开关                      |
| `hosting:config:message-merge-enabled:v1` | `{ value: boolean, updatedAt }` — 消息聚合开关                         |
| `hosting:config:agent-reply-config:v1`    | `{ value: AgentReplyConfig, updatedAt }` — 模型/延迟/思考模式/告警阈值 |

所有 key 无 TTL，更新由配置变更 Observer 驱动。

---

## 监控与任务（monitoring / group-task / group-membership）

### 17-18. 监控实时指标

**代码位置**：[src/biz/monitoring/services/tracking/monitoring-cache.service.ts](../../src/biz/monitoring/services/tracking/monitoring-cache.service.ts)

| Key                               | 结构         | 说明                         |
| --------------------------------- | ------------ | ---------------------------- |
| `monitoring:active_requests`      | String (int) | 实时活跃请求数（跨实例共享） |
| `monitoring:peak_active_requests` | String (int) | 峰值活跃请求数               |

**操作**：`INCRBY` / `SET` / `GET`，无 TTL。

### 19. `room:members:{imRoomId}` — 群成员缓存

**代码位置**：[src/biz/group-task/services/group-membership.service.ts](../../src/biz/group-task/services/group-membership.service.ts)

| 属性     | 值                 |
| -------- | ------------------ |
| 数据结构 | Set（imContactId） |
| TTL      | 600s（10 分钟）    |

**操作**：`SADD` / `SMEMBERS` / `EXPIRE` / `EXISTS` / `DEL`。整体通过 hydration 批量刷新，避免单次查询 API。

### 20. `group-task:lock:{type}` — 群任务执行锁

**代码位置**：[src/biz/group-task/services/group-task-scheduler.service.ts](../../src/biz/group-task/services/group-task-scheduler.service.ts)

| 属性     | 值                    |
| -------- | --------------------- |
| 数据结构 | String（owner token） |
| TTL      | 900s（15 分钟）       |

**操作**：`SET NX EX` 获取；Lua 脚本条件释放。

### 21. `group-task:brand-history:{groupId}` — 品牌轮转历史

**代码位置**：[src/biz/group-task/services/brand-rotation.service.ts](../../src/biz/group-task/services/brand-rotation.service.ts)

| 属性     | 值                         |
| -------- | -------------------------- |
| 数据结构 | String（JSON 数组）        |
| TTL      | 7 天（`7 * 24 * 3600` 秒） |

**用途**：记录该群最近推过的品牌，防重复；所有品牌推完后主动清空重置轮转。

---

## 其他业务缓存

### 22. `geocode:v2:{city}:{address}`（或 `geocode:v2:{address}`）— 高德地理编码缓存

**代码位置**：[src/infra/geocoding/geocoding.service.ts](../../src/infra/geocoding/geocoding.service.ts)

| 属性     | 值                             |
| -------- | ------------------------------ |
| 数据结构 | String（JSON `GeocodeResult`） |
| TTL      | 30 天（`30 * 24 * 3600` 秒）   |

**用途**：缓存高德 POI 搜索和结构化地址解析结果，减少外部 API 调用。

### 23. `test-suite:progress:{batchId}` — 测试批次进度缓存

**代码位置**：[src/biz/test-suite/test-suite.processor.ts](../../src/biz/test-suite/test-suite.processor.ts)

| 属性     | 值                                                                           |
| -------- | ---------------------------------------------------------------------------- |
| 数据结构 | String（JSON `{ completedCases, successCount, failureCount, durations[] }`） |
| TTL      | 3600s（1 小时兜底）                                                          |

**用途**：多 Worker 并发执行时共享批次进度（进度仅用于展示，完成判定以数据库为准）。

---

## Bull Queue

Bull Queue 使用独立的 Redis TCP 连接（`UPSTASH_REDIS_TCP_URL`），所有队列 Key 由 Bull 自动管理，前缀固定为 `bull:{RUNTIME_ENV|NODE_ENV}`。

已注册的队列还包括 `group-task`、`memory-consolidation`、`reengagement`、`reengagement-commands`、`action-local-repair`、`intervention-tasks` 和 `critical-ops-events`。记忆沉淀队列的基础 job ID 为 `tenant:{encodedTenantId}:memory-consolidation:{sessionId}`，Bull 自行管理队列键。

**全局配置**（[src/infra/queue/bull.module.ts](../../src/infra/queue/bull.module.ts)）：

| 项                                   | 值                                            |
| ------------------------------------ | --------------------------------------------- |
| `defaultJobOptions.removeOnComplete` | 100（保留最近 100 条）                        |
| `defaultJobOptions.removeOnFail`     | 1000                                          |
| `settings.stalledInterval`           | 30000 ms                                      |
| `settings.lockDuration`              | 60000 ms                                      |
| `settings.lockRenewTime`             | 15000 ms                                      |
| `settings.maxStalledCount`           | 2                                             |
| `settings.guardInterval`             | 1000 ms（delayed job 激活轮询，压低排队抖动） |

### 队列 1：`message-merge` — 消息聚合

**代码位置**：[src/channels/wecom/message/runtime/simple-merge.service.ts](../../src/channels/wecom/message/runtime/simple-merge.service.ts) + [src/channels/wecom/message/runtime/message.processor.ts](../../src/channels/wecom/message/runtime/message.processor.ts)

**Job 数据**：`{ chatId: string }`（jobId 格式：`{chatId}:{messageId}` 或 `{chatId}:followup:{ts}`）

| 配置项             | 值                   | 说明                                   |
| ------------------ | -------------------- | -------------------------------------- |
| `attempts`         | 3                    | 失败重试次数                           |
| `backoff`          | exponential / 2000ms | 指数退避                               |
| `delay`            | `mergeDelayMs`       | 动态，取自 runtime 配置（默认 2000ms） |
| `removeOnComplete` | true                 |                                        |
| `removeOnFail`     | false                | 保留用于调试                           |
| 单实例并发 | 默认 4，可设 1–100 | Bull 按保存值注册，运行中修改时排空本机在途任务后切换。[消息队列并发](../architecture/message-service-architecture.md#42-worker-并发) |

**聚合参数**（来自 Supabase `hosting_config` / `system_config.agent_reply_config`，Dashboard 动态调整）：

| 参数                   | 默认值 | 说明                                                        |
| ---------------------- | ------ | ----------------------------------------------------------- |
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

| 配置项             | 值                   | 说明                 |
| ------------------ | -------------------- | -------------------- |
| `attempts`         | 2                    | 失败重试 1 次        |
| `backoff`          | exponential / 5000ms | 指数退避             |
| `timeout`          | 120000ms             | 单任务超时（2 分钟） |
| `removeOnComplete` | true                 |                      |
| `removeOnFail`     | false                |                      |
| 并发数             | 3                    | 硬编码               |

**Bull 内部 keys**（自动管理，不需要手动操作）：

```
bull:{env}:message-merge:{waiting|active|completed|failed|delayed|{jobId}}
bull:{env}:test-suite:{waiting|active|completed|failed|delayed|{jobId}}
```

---

## 数据生命周期

| 数据类型                       | TTL                                        | 清理方式                          |
| ------------------------------ | ------------------------------------------ | --------------------------------- |
| 消息去重                       | 5 min                                      | Redis 自动过期                    |
| 消息聚合队列 / last-message-at | 5 min（兜底）                              | Worker 主动裁剪 / 自动过期        |
| 处理锁                         | 90 s 单次租约，30 s 心跳续期               | Lua 条件续期 / 释放               |
| 消息 trace                     | 24 h                                       | 自动过期                          |
| 消息热缓存                     | `MEMORY_SESSION_TTL_DAYS`（当前默认 7 天） | 自动过期；滚动 7 天窗口独立于 TTL |
| Session facts + workbench      | 7 天 + 12 小时安全余量                     | 自动过期                          |
| 阶段指针                       | 7 天 + 12 小时                                       | 自动过期                          |
| 长期关系档缓存                 | 2 小时                                     | 自动过期；Supabase 为权威源       |
| 收资表单与定位指针             | 7 天                                       | tools 域自动过期或办结后主动删除  |
| 预约指针 | 2 小时 | 预约投影写入后失效 |
| 预约快照和候选人镜像 | 最多 5 分钟 | 预约状态变更后失效 |
| 托管共享缓存                   | 无                                         | 观察者 / 定期同步                 |
| 监控实时计数                   | 无                                         | 持续累计                          |
| 群成员缓存                     | 10 min                                     | 自动过期 + 定期 hydrate           |
| 群任务锁                       | 15 min                                     | Lua 条件释放                      |
| 品牌轮转历史                   | 7 天                                       | 自动过期或业务重置                |
| 地理编码缓存                   | 30 天                                      | 自动过期                          |
| 测试批次进度                   | 1 h（兜底）                                | 批次完成后主动 DEL                |

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
  ④ SET wecom:message:lock:{chatId} NX EX 90（抢租约锁，持有期间每 30s 续期）
  ⑤ 读 last-message-at 判断是否已静默；未满足则等待后续 job 接力
  ⑥ LRANGE pending 0 -1 → LTRIM length -1（只裁剪已读部分）
  ⑦ 调用 Agent → 有界 replay → 发送回复 → 等待 turn-end
  ⑧ Lua 条件释放 lock
```

---

## 连接配置

| 用途                  | 连接方式                 | 环境变量                                                     |
| --------------------- | ------------------------ | ------------------------------------------------------------ |
| 所有 Service 缓存操作 | REST（`@upstash/redis`） | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`        |
| Bull Queue 任务队列   | TCP（`ioredis`）         | `UPSTASH_REDIS_TCP_URL`                                      |
| 备选：通用 Redis      | TCP                      | `REDIS_URL`（或 `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`） |

本地运行同样必须提供可用 Redis：Service 缓存使用 REST 连接，Bull Queue 使用 TCP 连接（或表中的
通用 Redis TCP 兜底）。当前没有禁用 Bull Queue 的环境变量；无 Redis 时应用无法启动。

---

## 故障排查

```bash
# 检查消息去重 key
curl -X GET "$UPSTASH_REDIS_REST_URL/exists/production:wecom:message:dedup:{msgId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查聚合队列长度
curl -X GET "$UPSTASH_REDIS_REST_URL/llen/production:wecom:message:pending:{chatId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查会话 facts hash
curl -X GET "$UPSTASH_REDIS_REST_URL/hgetall/production:tenant:{encodedTenantId}:factsv2:{corpId}:{userId}:{sessionId}" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"

# 检查短期记忆缓存长度
curl -X GET "$UPSTASH_REDIS_REST_URL/llen/production:tenant:{encodedTenantId}:memory:short_term:chat:{chatId}" \
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
- [src/memory/README.md](../../src/memory/README.md) — 两层记忆当前实现
