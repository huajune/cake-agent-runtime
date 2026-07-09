---
tags: [并发, redis, 数据一致性, 学习]
source: src/memory/services/session.service.ts, src/memory/facts/fact-merge.util.ts
---

# Facts 并发安全：从整 blob 读改写到 Redis hash 字段级写

## 问题：经典的 lost update

会话事实最初存成**一个 Redis JSON blob**（`facts:*`），更新流程是"读整包 → 内存合并 → 写整包"。同一用户的两个并发回合（比如主回合 + 复聊沉淀、或 debounce 边界上的两轮）同时读改写时，**后写的把先写的字段覆盖掉**——P0 级并发丢更新，且丢得无声无息，表现为"Agent 忘了刚说过的城市"。

## 修复：hash 字段级写入（factsv2）

`session.service.ts`：

- 存储形态改为 **Redis hash（`factsv2:*`），每个 top-level 字段一个 hash field**
- 写入只 HSET 自己变更的字段——并发回合各改各的字段互不覆盖
- 同一字段仍是 last-writer-wins（可接受：单字段冲突的窗口和影响远小于整包覆盖）
- **在线迁移**：读时旧 blob（`facts:*`）与新 hash 叠加（hash 字段优先），并用 `HSETNX` 把旧数据搬进 hash——HSETNX 保证迁移写不会覆盖已有的新写入。不停机、无需刷数脚本。

## 合并原语与置信度守卫（`facts/fact-merge.util.ts`）

同一轮内规则提取与 LLM 提取的结果要合并；跨轮的新值要过**置信度守卫**（`mergeFactsWithConfidenceGuard`）：低置信新值不能覆盖高置信旧值。两条路径共用同一套字段合并原语（数组去重合并、可空字符串合并等），避免两处遍历各写一套合并逻辑导致行为漂移。

辅助防御（`facts/` 目录）：
- `name-guard.ts`：报名姓名清洗——微信昵称/"我是XX"不算真实姓名，防止把昵称当法定姓名填进报名表
- `geo-mappings.ts`：从地理信号解析城市
- `high-confidence-facts.ts`：规则可确定的高置信事实（如手机号正则）标注来源，LLM 不得降级覆盖

## 学习要点

- 这是**教科书级 read-modify-write 竞态**在 LLM 应用里的具体化：Agent 系统天然多写入方（主回合、事实提取、沉淀、复聊），共享状态必须一开始就设计并发语义。
- 修复方案的取舍：没有上 Lua 脚本/WATCH 事务做全字段 CAS，而是**降低冲突粒度**（字段级）让绝大多数冲突自然消失——工程上"让冲突不发生"优于"让冲突可检测"。
- HSETNX 在线迁移是零停机数据迁移的小范式：新写走新结构、读时新旧叠加、搬迁写用 set-if-absent 保证不回退。

关联：[[03-四层记忆系统]] · 锁与租约的另一处应用 [[02-消息debounce聚合与租约锁]]
