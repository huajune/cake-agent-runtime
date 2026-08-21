# 文档中心

> Cake Agent Runtime — 技术文档导航

**最后更新**：2026-08-12

---

## 🧭 我该读哪份？

| 角色 / 目标         | 建议入口                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快速了解系统全貌    | [系统宣讲说明书](cake-agent-runtime-overview.md) → [Agent 运行时架构](architecture/agent-runtime-architecture.md)                                                 |
| 产品 / 运营         | [产品定义](product/product-definition.md)、[Agent 运营手册](product/agent-for-operations.md)                               |
| 新人研发入门        | [开发指南](guides/development-guide.md) → [Agent 运行时架构](architecture/agent-runtime-architecture.md) → [记忆系统](architecture/memory-architecture.md) |
| 做可靠性 / 守卫改进 | [安全护栏说明](architecture/security-guardrails.md) + [Guardrail 质量体系](architecture/guardrail-quality-system.md)                        |
| 改候选人事实链路    | [候选人档案域架构](architecture/candidate-profile-domain.md)（域宪法）→ [记忆系统](architecture/memory-architecture.md)                                    |
| 质量评测 / 回归     | [测试套件架构](architecture/test-suite-architecture.md) + [质量评测指南](guides/test-suite-guide.md)                                                              |
| 发版 / 部署         | [发版底账](releases/README.md) → [版本发布指南](workflows/version-release-guide.md) → [构建与部署指南](workflows/deploy-guide.md)                                 |

---

## 🏗️ 架构设计 (architecture/)

> **本目录只放描述现状的架构文档。** 改造方案是中间产物：做完即转写为现状文档并删除，
> 未落地的方案放 `todo/`。新增文档请在本节补一行。

### 运行时核心

- **[Agent 运行时架构](architecture/agent-runtime-architecture.md)** ⭐ — 主干：分层架构、编排（Generator/Runner）、**运行时硬约束 HC-1~HC-5**、Context 组装、Provider 三层、工具、消息管线、模块依赖图
- **[Agent 运营手册](product/agent-for-operations.md)** 👉 — 上文的业务语言版（运营向，收录在 product/）
- **[企微消息服务架构](architecture/message-service-architecture.md)** — 消息管道：去重→过滤→存储→聚合→Agent→投递
- **[Gate 拒绝与人工介入流水线](architecture/handoff-gate-and-intervention-pipeline.md)** — Tool gate → LLM 短路 → Runner handoff → 底账判重 → 暂停托管与飞书告警
- **[二次主动回复流水线](architecture/reengagement-pipeline.md)** — 复聊：锚点触发、停止条件与水位、outbox 幂等、带外工单核验
- **[群任务通知流水线](architecture/group-task-pipeline.md)** — 群任务定时通知的运行时流水线
- **[岗位召回链路现状](architecture/job-recall-chain.md)** — 实时调海绵、召回智能在查询参数构造层；含 G1-G4 已知缺口 backlog

### 候选人事实链路

- **[候选人档案域架构](architecture/candidate-profile-domain.md)** ⭐ — **域宪法**：主权归 memory / 实现归 resolution、字段四阶段、治理四不变式、claim 通货、消费面纪律
- **[记忆与状态全局视图](architecture/memory-and-state.md)** 👉 — **排障入口**：一张图看清全部状态存储及其关系（三角色心智模型，110 行）
- **[记忆系统架构与数据流](architecture/memory-architecture.md)** — 四层记忆（CoALA）、**字段归属唯一权威表**、读写时序、prompt/工具消费、沉淀与排障顺序
- **[品牌解析域](architecture/brand-resolution.md)** — 目录匹配、意图极性、会话品牌状态、图片品牌、queryMeta 对账
- **[地理解析域](architecture/geo-resolution.md)** — 行政区解析、白名单三轮扫描、供应商适配、距离锚点
- **[图片信息链路](architecture/visual-fact-pipeline.md)** — VisualFactSheet 生产/存储/消费全链路（附录 A = 字段白名单唯一权威）

### 守卫与判定哲学

- **[安全护栏说明](architecture/security-guardrails.md)** ⭐ — 护栏现状总览：基础设施层 + Agent 三层守卫（input/tool/output）
- **[语义判定三分法](architecture/semantic-decision-taxonomy.md)** — 正则、LLM 标签位与向量判定的准入边界
- **[Guardrail 质量体系](architecture/guardrail-quality-system.md)** 🚧 — 双环质量体系；**离线环仅落成 skills，src 内未实现**

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

- **[发版底账](releases/README.md)** ⭐ — 每个正式版本的范围、风险、回归证据、回滚与上线结果归档
- **[版本与发布指南](workflows/version-release-guide.md)** — 发布操作流程 + 版本自动化机制（原 auto-version-changelog 已并入）
- **[构建与部署指南](workflows/deploy-guide.md)** — tag 触发构建部署、健康检查、回滚
- **[分支保护规则配置](workflows/branch-protection-guide.md)** — 分支保护、环境隔离、CI 必需检查
- **[AI Code Review 配置指南](workflows/ai-code-review-guide.md)** — 基于 Claude Code CLI 的 PR 自动审查

---

## 📌 待办与规划 (todo/)

> 这些是工程 backlog / 规划稿，不代表已实现的设计。落地后应更新对应架构文档或归档。

- **[LLM 判官标定](todo/judge-calibration.md)** — 自迭代循环的唯一欠账：周频抽检给判官算精确率（发牌制用在 LLM-as-a-judge 上）
- **[收资表单域](architecture/collection-form-machine.md)** — 标签制×收资表单状态机终态架构；设计史见 git 历史 docs/todo/ 原文
- **[Prompt 守卫层与命名对齐](todo/prompt-guardrail-and-naming-alignment.md)** — 全部落地（余 C3 待观测会话）；发版验收（D4 回归案+A5 采用率观察）后删除
- **[BadCase 架构覆盖分诊](todo/badcase-arch-coverage-triage.md)** — α/β/γ 三工程已执行；本文即发版验收清单（A 类回归验证+回归案回放+block 底账重扫），验收完成后删除
- **[PR #1000 评审修复底账](todo/pr1000-review-fixes.md)** / **[二轮修复底账](todo/pr1000-review-round2-fixes.md)** — 两轮全部落地；合并评审的直接证据，PR 合入即删


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
