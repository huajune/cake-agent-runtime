---
tags: [并发, redis, 数据一致性, 学习]
source: src/memory/short-term/facts.service.ts, src/memory/short-term/session-state.service.ts
---

# Facts 并发安全与 Redis hash 字段级写入

**最后更新**：2026-09-11

## 并发问题的形状

Agent 会话有多类写入方：主回合收尾、候选人活动记录、复聊终态、品牌 reducer 和工具回写。若它们共享一个整实体“读 → 内存修改 → 整体覆盖”出口，两个写入方即使修改不同成员，后写者也可能把先写者的结果静默覆盖。

当前实现通过降低冲突粒度解决这类 lost update。它没有把所有状态塞进全局事务，也不把 Redis hash 误解成任意嵌套字段都天然并发安全。

## 当前物理契约

唯一 key 为 `factsv2:{corpId}:{userId}:{sessionId}`，由 `buildSessionFactsHashKey()` 统一构造。Redis value 是 hash；每个 `WeworkSessionState` 顶层成员，例如 `facts`、`presentedJobs`、`invitedGroups` 和终态成员，各占一个 hash field。

`SessionFactsService.patchSessionState()` 先按持久化 schema 序列化 patch，再由 `RedisStore.patchHash()` 只 `HSET` patch 中出现的成员，并刷新会话事实 TTL。默认 TTL 是 7 天加 12 小时沉淀读取余量。`clearSessionState()` 只删除这个规范 key。

运行时不读取 `facts:*` 单 blob，不与旧 key 合并，不使用 `HSETNX` 搬迁，也没有读时在线迁移。任何跨存储形态的数据处理都属于发布和迁移流程，不能依赖消息自然触发。

## 并发保证的精确边界

| 写入关系                       | 当前保证                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| 两个写入修改不同 hash field    | 两次 `HSET` 互不覆盖                                                      |
| 两个写入修改同一个 hash field  | last-writer-wins；必须依赖字段所有权或上游串行化                          |
| `facts` 内两个语义字段并发修改 | `facts` 仍是一个 hash field；合并由会话处理锁、共享合并原语与置信守卫约束 |
| activity / terminal 等独占成员 | 无锁写入方只写自己的顶层成员                                              |
| `facts.brand`                  | 由 `BrandStateService` reducer 独占写入                                   |

同一 chat 的回合收尾在 90 秒心跳租约释放前等待状态落盘，因此 `facts`、`presentedJobs`、`invitedGroups` 等需要读合并写的成员有单写者边界。不持有该租约的 activity、terminal 路径只能写各自独占成员。新增写入口时必须先确定它写哪个 hash field，以及是否与现有 owner 共享同一把锁。

## 事实合并与置信守卫

同一轮的规则结果、模型结果和工具确权最终使用共享字段合并原语。跨轮的新值经过 `mergeFactsWithConfidenceGuard`：低置信新值不能覆盖高置信旧值；数组类偏好按字段规则去重合并；显式 `value:null` 信封表示清空偏好。

事实信封统一为 `{ value, confidence, source, evidence, extractedAt? }`。`source` 只接受 `candidate_quote / rule / model / system / manual / archive`；裸标量直接视为非法。姓名、手机号、城市、品牌和报名字段仍由各领域的裁决与所有权规则负责，Redis 写入层不替它们重新判断语义。

## 逐字段读降级

`getSessionState()` 读取完整 hash 后，按注册的 hash field schema 逐项校验：

- 合法字段进入返回状态；
- 未注册字段按 schema strip 语义忽略；
- 已注册但形状非法的字段单独丢弃，其余字段继续返回；
- 丢弃事件同时写日志、`agent_execution_events` 和节流告警，且不携带字段原值。

降级粒度必须与物理存储粒度一致。一个偏好或终态字段损坏，不应把整个会话清空；但被丢弃的事实也不能静默，否则复聊可能继续触达已经预约或已转人工的候选人。

## 学习要点

- Redis hash 通过缩小覆盖范围消除跨成员 lost update；同一 hash field 内的竞态仍需 owner、租约或专用原子原语。
- “字段级”指 `WeworkSessionState` 的顶层物理字段，不能据此推导任意深层 JSON 都有并发隔离。
- 读边界的局部降级和告警同样是数据一致性设计的一部分：既要保住未损坏状态，也要让事实丢失可观测。
- 当前运行时只接受规范 key 和 schema；兼容转换不应常驻在线请求路径。

关联：[[03-两层记忆系统]] · 锁与租约见 [[02-消息debounce聚合与租约锁]] · 收资单据的单写者边界见 [[19-收资与预约事务状态机]]
