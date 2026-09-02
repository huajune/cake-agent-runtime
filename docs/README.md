# 文档中心

> Cake Agent Runtime — 技术文档导航

**最后更新**：2026-09-02

---

## 🧭 我该读哪份？

| 角色 / 目标         | 建议入口                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快速了解系统全貌    | [系统宣讲说明书](cake-agent-runtime-overview.md) → [Agent 运行时架构](architecture/agent-runtime-architecture.md)                                          |
| 产品 / 运营         | [产品定义](product/product-definition.md)、[Agent 运营手册](product/agent-for-operations.md)                                                               |
| 新人研发入门        | [开发指南](guides/development-guide.md) → [Agent 运行时架构](architecture/agent-runtime-architecture.md) → [记忆系统](architecture/memory-architecture.md) |
| 做可靠性 / 守卫改进 | [安全护栏说明](architecture/security-guardrails.md) + [Guardrail 质量体系](architecture/guardrail-quality-system.md)                                       |
| 改候选人事实链路    | [候选人档案域架构](architecture/candidate-profile-domain.md)（域宪法）→ [记忆系统](architecture/memory-architecture.md)                                    |
| 质量评测 / 回归     | [Agent 质量评估体系](architecture/agent-quality-evaluation.md)（口径页）→ [质量指标台账](quality-metrics-ledger.md) → [测试套件架构](architecture/test-suite-architecture.md) + [质量评测指南](guides/test-suite-guide.md) |
| 发版 / 部署         | [版本发布指南](workflows/version-release-guide.md) → [构建与部署指南](workflows/deploy-guide.md)；按需维护[可选发版底账](releases/README.md)               |

---

## 🏗️ 架构设计 (architecture/)

> **本目录只放描述现状的架构文档。** 改造方案是中间产物：做完即转写为现状文档并删除，
> 未落地的方案放 `todo/`。新增文档请在本节补一行。

### 运行时核心

- **[Agent 运行时架构](architecture/agent-runtime-architecture.md)** ⭐ — 主干：分层所有权、Runner/Generator、Preparation 与 Prompt、工具、记忆、Provider、消息链路、四个防线作用位和运行时不变量
- **[Agent 运营手册](product/agent-for-operations.md)** 👉 — 上文的业务语言版（运营向，收录在 product/）
- **[企微消息服务架构](architecture/message-service-architecture.md)** — 消息管道：去重→过滤→存储→聚合→Agent→投递
- **[Gate 拒绝与人工介入流水线](architecture/handoff-gate-and-intervention-pipeline.md)** — Tool gate → LLM 短路 → Runner handoff → 底账判重 → 暂停托管与飞书告警
- **[二次主动回复流水线](architecture/reengagement-pipeline.md)** — 复聊：锚点触发、停止条件与水位、outbox 幂等、带外工单核验
- **[群任务通知流水线](architecture/group-task-pipeline.md)** — 群任务定时通知的运行时流水线

### 候选人事实链路

- **[候选人档案域架构](architecture/candidate-profile-domain.md)** ⭐ — **域宪法**：主权归 memory / 实现归 resolution、字段四阶段、治理四不变式、claim 通货、消费面纪律
- **[记忆与状态全局视图](architecture/memory-and-state.md)** 👉 — **排障入口**：一张图看清 Redis、Supabase、回合内状态与 tools 单据
- **[记忆系统架构与数据流](architecture/memory-architecture.md)** — 两层记忆终态、读写时序、Prompt / 工具消费矩阵、consolidation 与排障路径
- **[品牌解析域](architecture/brand-resolution.md)** — 目录匹配、意图极性、会话品牌状态、图片品牌、queryMeta 对账
- **[地理解析域](architecture/geo-resolution.md)** — 行政区解析、白名单三轮扫描、供应商适配、距离锚点
- **[图片信息链路](architecture/visual-fact-pipeline.md)** — VisualFactSheet 生产/存储/消费全链路（附录 A = 字段白名单唯一权威）

### 守卫与判定哲学

- **[安全护栏说明](architecture/security-guardrails.md)** ⭐ — 防线现状总览：基础设施 + Input / Prompt / Tool / Output 四个作用位
- **[语义判定三分法](architecture/semantic-decision-taxonomy.md)** — 正则、LLM 标签位与向量判定的准入边界
- **[Agent 质量评估体系](architecture/agent-quality-evaluation.md)** — 口径页：阶段任务目标指标、三层评估（确定性断言 / 校准判官 / 生产抽样）、轻闸门、已退役项
- **[质量指标台账](quality-metrics-ledger.md)** — 定时观测任务量化结论的唯一落点；阶段/指标名白名单来自口径页 §1，`quality-ledger:validate` 挂在 ci:check
- **[Guardrail 质量体系](architecture/guardrail-quality-system.md)** — Output 实时裁决、一次有界修复与快/慢质量闭环；慢环为仓外流程，`src/**` 无自动执行器

### 平台系统与规范

- **[测试套件架构](architecture/test-suite-architecture.md)** — LLM 评分对话质量评估框架（单轮 + 多轮 + 批量 + 飞书同步）
- **[监控系统架构](architecture/monitoring-system-architecture.md)** — 消息追踪、小时级聚合、Dashboard
- **[Biz 分层边界规范](architecture/biz-layer-boundaries.md)** — `src/biz/**` 的 Controller / Service / Repository 分层约束

---

## 🧪 生产实践原则 (principles/)

> 从生产事故与观测数据中蒸馏、跨功能域、对未来设计有约束力的经验总结。见 [principles/README.md](principles/README.md)。

- **[确定性规则与语义理解的分工哲学](principles/rules-vs-semantics-design-philosophy.md)** ⭐ — 设计原则基线（P1~P11），多份文档引它作依据；P11=裁决权宪法（模型作证/代码公证/本人终审）
- **[示例示教与幻觉：示教纪律](principles/prompt-example-hygiene.md)** ⭐ — 教学示例引发幻觉的三机制、全库示例面普查（130 处）、业界解法对照与示教四原则
- **[术语宪章](principles/glossary.md)** — 行业名做主名、自造词打旗：A/B/C 三层词表，学习地图 + 命名权威源

---

## 🗄️ 数据库 (db/)

- **[数据库表设计与使用说明](db/database-schema.md)** — 表结构、索引、RPC 函数、数据生命周期
- **[Redis Key 设计与使用说明](db/redis-schema.md)** — Redis key 命名、TTL、Bull 队列前缀

---

## 🔧 基础设施 (infrastructure/)

- **[飞书通知系统](infrastructure/feishu-alert-system.md)** — 飞书 Webhook 机器人集成
- **[人工告警触发场景清单](infrastructure/human-alert-triggers.md)** — 需要人工介入的告警触发场景
- **[Bull Queue 使用指南](infrastructure/bull-queue-guide.md)** — 消息聚合队列的使用与排障

---

## 📋 产品 (product/)

- **[产品定义](product/product-definition.md)** — 定位、用户角色、核心功能
- **[复聊功能产品说明](product/reengagement.md)** — 主动跟进的场景、触发/停止规则、内容规范、灰度、指标与验收口径
- **[Agent 运营手册（理解系统+日常操作）](product/agent-for-operations.md)** ⭐ — 运营向：消息旅程、记忆、工具清单、剧本、可调项、排查（原 product-view + agent-workflow 合并）
- **[敏感信息与安全护栏全景（运营版）](product/sensitive-info-guardrails-for-operations.md)** — 公平性/诚信/隐私保护与运营处置指引（技术侧见 [security-guardrails.md](architecture/security-guardrails.md)）
- **[拉人进群产品设计](product/invite-to-group.md)** — invite_to_group 产品设计
- **[群任务定时通知系统](product/group-task.md)** — 群任务产品设计（运行时见 [group-task-pipeline.md](architecture/group-task-pipeline.md)）
- **[运营数据体系 + 海绵集成 产品设计](product/ops-data-and-sponge-integration.md)** — ops_events 数据模型设计（研发向；顶部含实现校准记录）
- **[运营数据体系 · 产品说明](product/ops-data-spec-for-operations.md)** — 上文的运营使用说明（日报/Web/埋点三出口）

---

## 📝 指南 (guides/) 与工作流 (workflows/)

### 开发 / 测试

- **[开发指南](guides/development-guide.md)** — 环境配置、Git hooks、Prettier/ESLint、环境变量
- **[Claude Code 安全使用指南](guides/claude-code-safety-guide.md)** — 危险命令黑名单、文件保护
- **[质量评测系统设计与使用指南](guides/test-suite-guide.md)** — 测试套件的场景解释与最佳实践
- **[用例测试工作流](workflows/scenario-test-workflow.md)** — 用例测试数据流（导入→执行→评审→回写）
- **[回归验证工作流](workflows/conversation-test-workflow.md)** — 回归验证数据流（导入→执行→评估→回写）
- **[反馈修复测试验证链路 V2](workflows/feedback-repair-test-validation-v2.md)** — 反馈→样本池→策展→正式资产端到端流程
- **[BadCase Trace 与记忆评测改造](workflows/badcase-trace-memory-evaluation.md)** — 排障字段/记忆评测字段契约

### 运行链路

- **[Agent 调用链路对比](workflows/agent-call-chain-comparison.md)** — 不同入口的 Agent 调用链对比
- **[WeCom 消息处理数据流](workflows/wecom-message-dataflow.md)** — 企微消息端到端处理数据流

### 版本 / 部署 / CI

- **[发版底账](releases/README.md)** — 可选的版本范围、风险、回归证据、回滚与上线结果归档
- **[版本与发布指南](workflows/version-release-guide.md)** — 发布操作流程 + 版本自动化机制（原 auto-version-changelog 已并入）
- **[构建与部署指南](workflows/deploy-guide.md)** — tag 触发构建部署、健康检查、回滚
- **[分支保护规则配置](workflows/branch-protection-guide.md)** — 分支保护、环境隔离、CI 必需检查
- **[AI Code Review 配置指南](workflows/ai-code-review-guide.md)** — 基于 Claude Code CLI 的 PR 自动审查

---

## 📌 待办与规划 (todo/)

> 入口见 **[Todo 索引](todo/README.md)**。这里只保留有所有者、状态和完成条件的未完成事项；
> 已落地方案删除并留在 Git 历史，不在 todo 中长期保存执行记录。

---

## 🗂️ 文档规范

- **命名**：kebab-case，全小写，连字符分隔，描述性强，避免缩写（api/http 等公认缩写除外）
- **新增文档**：放到对应分类目录，并在本 README 补一行链接
- **更新文档**：同步文档内"最后更新"日期；重大改动同步本 README 描述
- **代码引用**：优先用 `文件路径 + 方法名`，避免硬编码行号（重构后易漂移）
- **方案是中间产物**：改造方案 / 实施指南 / 一次性证据报告**落地后即转写为现状文档并删除**，
  原文留在 git 历史——**不设归档目录**，「舍不得删」不是保留理由。
  `architecture/` 只放描述现状的文档；未落地的方案放 `todo/`。
- **只写现状，不写沿革**：文档描述系统「现在是什么样」，不叙述「原来是什么、后来改成什么」。
  迁移记录、PR 注记、施工阶段编号、已删除之物的说明一律不进文档——那些在 git 历史里。
- **一份事实一处写**：规则条数、字段归属表、证据分级表这类会漂移的事实只在一份文档里写，
  其余文档引用它——同一事实抄在多份文档里，必然演化成互相矛盾的多个版本。

## 🔗 相关资源

- 协作规范：[../CLAUDE.md](../CLAUDE.md) ｜ Agent 配置：[../.claude/agents/](../.claude/agents/)
- 架构原则：[../.claude/agents/architecture-principles.md](../.claude/agents/architecture-principles.md) ｜ 代码标准：[../.claude/agents/code-standards.md](../.claude/agents/code-standards.md)

---

**维护者**：DuLiDay Team ｜ **项目**：Cake Agent Runtime
