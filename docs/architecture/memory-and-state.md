# 记忆与状态架构（全局视图）

**最后更新**：2026-08-12

> 目的：一张图看清 Agent 的全部状态存储及其关系。写作原则是**减少概念**——正文只讲
> 三个角色的心智模型，实现颗粒度的七行清单放附录（排障时用）。
>
> **本文是记忆链路的入口**：读完这三个角色再往下走。
> 四层结构、**字段归属权威表**、读写时序、prompt/工具消费的完整叙述见
> [memory-architecture.md](./memory-architecture.md)；字段的证据裁决见
> [candidate-profile-domain.md](./candidate-profile-domain.md)。
> 姊妹文档：[visual-fact-pipeline.md](./visual-fact-pipeline.md)（图片信息链路，本文"原文附件"与"结算判据"的细化）。

---

## 一、心智模型：只有三个角色

```
┌─ 1. 原文 ─────────────────────────────────────────────┐
│ "候选人和我们各说了什么"                                 │
│ = 消息窗口（chat_messages；Redis 缓存只是它的加速层）      │
│   visual_facts 是钉在某条图片消息上的结构化证据附件，       │
│   不是独立存储                                          │
└──────────────────────────────────────────────────────┘
                │
                │  每回合结束「结算」一次：原文 → 档案
                ▼
┌─ 2. 档案 ─────────────────────────────────────────────┐
│ "我们从原文里确认了什么"                                 │
│ = sessionFacts 是主体（每个值带 source + confidence）     │
│   brand_state / currentStage 是档案里的两个「特区」        │
│   （历史事故给了它们独立门牌，角色上仍是档案字段，见附录 B）  │
│   long-term profile = 档案的跨会话沉淀版                  │
└──────────────────────────────────────────────────────┘

┌─ 3. 草稿纸 ───────────────────────────────────────────┐
│ "本轮干活的临时变量"，回合结束即弃                         │
│ = turnState（工具写给同轮工具与收尾的便签）                │
│   + 本轮高置信线索（开工前对本轮消息的速读笔记）            │
│   同一张草稿纸的两个区域：一个开工时写好，一个干活时随手记   │
└──────────────────────────────────────────────────────┘
```

**总纲一句话：草稿纸辅助本轮干活，回合结束把值得留的结算进档案，档案和原文一起喂给下一轮。**

## 二、一回合的接力

```
回合开始（preparation）
  读：原文窗口 → 模型消息（图片轮附原图）
      档案 → 提示词 [已确认事实]（全量+置信标注）
      档案(只留 high) → 工具上下文        ← 出档闸门：工具只见 high
      profile(只留 high) / brand_state / stage → 提示词 + 工具上下文
  写草稿纸：规则轨速读本轮消息 ⇒ 本轮高置信线索
           （→ 提示词 hints 区；与档案 medium 视图对照出 [待确认线索]）
           turnState 置空待写

回合执行
  工具边干活边写 turnState（候选池/确权城市/visualFactSheets/品牌解析…）
  同轮工具可互读 turnState（如 invite 城市门读 map 截图 sheet）

回合收尾（turn-finalizer / onTurnEnd）——草稿纸在这里结算入档
  extractFacts（规则轨全窗口 + LLM 轨 + 各道门 + visual_facts 授权域）⇒ sessionFacts
  turnState.imageBrandResolutions + 文本品牌意图 ⇒ reducer ⇒ brand_state
  turnState.cityAttestation ⇒ pref.city(source=tool)
  turnState.候选池/查询签名/失效岗位 ⇒ 会话记忆
  草稿纸销毁

空闲期（settlement）
  sessionFacts ⇒ 沉淀 ⇒ long-term profile（confidence 一律压 medium，
  防止上个会话的沉淀值绕过出档闸门直接预填本会话的报名）
```

## 三、置信度：档案的守门体系

置信度（high/medium/low）是**档案里每个值的等级标签**，闸门只开在两个口子：

| 口子 | 规则 |
|---|---|
| **入档时**（赋值） | 规则轨=high、LLM 轨=medium、工具确权=tool/high、确认问答=high；证件/简历图上的 phone 锁 medium（裁决 B3）；沉淀入 profile 一律压 medium |
| **入档时**（防降级） | rank 比较：新值置信低于旧值 → 拒绝覆盖 |
| **出档时** | 工具上下文只装 high（booking/precheck 预填天然只可能拿到 high）；invite 门 sessionCity 只认 high；硬约束区只渲染 high |
| **升级通道**（medium→high） | ①explicit-provenance（quote 逐字验证；phone 的 quote 只认手打文本）②确认问答裁决 ③规则轨结构化姓名识别（name 唯一通道） |

low 档实际几乎无生产者，仅 labor_form 清除逻辑消费——三档实际运行成两档。

## 四、「高置信」的两次人生（最易混淆点）

同一个规则轨函数 `extractHighConfidenceFacts` 每回合跑两次，产物去向不同：

| | 第一次（回合开始） | 第二次（回合收尾） |
|---|---|---|
| 扫什么 | 只扫本轮消息 | 整个会话段窗口（+ visual_facts 授权域） |
| 产物落点 | 草稿纸（本轮高置信线索） | 档案（sessionFacts） |
| 用途 | 模型理解提示 + 工具即时可用 | 下一轮的 [已确认事实] |
| 寿命 | 回合结束即弃 | 跨轮存活 |

---

## 附录 A · 存储实现清单（排障用）

| 寿命 | 存储 | 介质 | 写入方 | 读取方 | 失效语义 |
|---|---|---|---|---|---|
| 一回合 | turnState | 进程内存 | 各工具（经回调） | 同轮工具、finalizer | 回合结束即弃 |
| 一回合 | 本轮高置信线索 | 进程内存 | preparation（规则轨） | 提示词 hints、工具上下文 | 同上 |
| 一条消息 | chat_messages 行（content + visual_facts） | DB | 入站存历史；描述/sheet 由 updateMessageContent 双写 | 窗口加载、收尾抽取（内容等值 join） | 90 天清理 |
| 会话级 | 短期记忆窗口缓存 | Redis list | 存历史镜像；updateMessageContent 时 del | ShortTermService（miss 回填自 DB） | 缓存可弃可重建 |
| 会话级 | sessionFacts | Redis hash（factsv2） | 收尾 extractFacts（唯一写入方） | 下一轮提示词/工具/各门 | **事故级 key**（无 DB 备份） |
| 会话级 | brand_state | Redis | reducer 独占写（turn-finalizer） | 提示词、job_list 兜底 | **事故级 key** |
| 会话级 | procedural currentStage | Redis | advance_stage → 收尾 | 提示词、工具上下文 | **事故级 key** |
| 跨会话 | long-term profile | DB | settlement（空闲期） | 提示词 [用户档案]、工具（high 视图） | 持久 |

## 附录 B · 「特区」的由来与合并候选

- **brand_state 独立**：品牌污染事故（§9 品牌收口）后裁定品牌真相唯一存储、reducer 独占写、替换式状态机——把它并回 sessionFacts 会失去写入纪律的隔离。**保留。**
- **currentStage 独立**：程序性记忆按阶段机制独立演化。理想态是 sessionFacts 的一个字段；合并属纯存储重构，零用户价值且动事故级 Redis key 清单。**不动，心智上当档案字段。**
- **本轮高置信线索与 turnState 分立**：一个是 prep 期的派生只读数据，一个是执行期的累积总线。合并无收益。**不动。**
