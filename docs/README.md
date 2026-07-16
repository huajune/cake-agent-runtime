# 文档中心

> Cake Agent Runtime — 技术文档导航

**最后更新**：2026-07-16

---

## 🧭 我该读哪份？

| 角色 / 目标 | 建议入口 |
|---|---|
| 快速了解系统全貌 | [系统宣讲说明书](cake-agent-runtime-overview.md) → [Agent 运行时架构](architecture/agent-runtime-architecture.md) |
| 产品 / 运营 | [产品定义](product/product-definition.md)、[Agent 运营手册](product/agent-for-operations.md)、[业务流程](product/business-flows.md) |
| 新人研发入门 | [开发指南](guides/development-guide.md) → [Agent 运行时架构](architecture/agent-runtime-architecture.md) → [记忆系统](architecture/memory-system-architecture.md) |
| 做可靠性 / 守卫改进 | [可靠性重构总设计](architecture/reliability/agent-reliability-refactor-2026-06.md)（文档族三层）+ [安全护栏说明](architecture/security-guardrails.md) |
| 质量评测 / 回归 | [测试套件架构](architecture/test-suite-architecture.md) + [质量评测指南](guides/test-suite-guide.md) |
| 发版 / 部署 | [版本发布指南](workflows/version-release-guide.md) → [构建与部署指南](workflows/deploy-guide.md) |

---

## 🏗️ 架构设计 (architecture/)

### 运行时核心

- **[Agent 运行时架构](architecture/agent-runtime-architecture.md)** ⭐ — 现状主干：分层架构、编排（Generator/Runner）、Context 组装、Provider 三层、工具、消息管线、模块依赖图
- **[Agent 运营手册](product/agent-for-operations.md)** 👉 — 上文的业务语言版（运营向，收录在 product/，见下方产品区）
- **[记忆系统架构](architecture/memory-system-architecture.md)** — 四层记忆（CoALA）、Hybrid 注入/检索、空闲沉淀
- **[记忆与线索数据流](architecture/memory-and-hints-data-flow.md)** — 记忆读写与线索注入的端到端数据流
- **[企微消息服务架构](architecture/message-service-architecture.md)** — 消息管道：去重→过滤→存储→聚合→Agent→投递
- **[群任务通知流水线](architecture/group-task-pipeline.md)** — 群任务定时通知的运行时流水线
- **[Gate 拒绝与人工介入流水线](architecture/handoff-gate-and-intervention-pipeline.md)** — Tool gate → LLM 短路 → Runner handoff → 底账判重 → 暂停托管与飞书告警

### 可靠性重构文档族（设计 → 详设 → 施工）

- **[可靠性重构设计](architecture/reliability/agent-reliability-refactor-2026-06.md)** — 总设计：根因、目标架构、模块设计、落地路线、未决硬约束
- **[HC-1/2/3 Runtime 机制设计](architecture/reliability/agent-reliability-hc-runtime-mechanisms.md)** — 三条硬约束的 runtime 机制详设
- **[二次主动回复（复聊）实现方案](architecture/reliability/agent-reengagement-design.md)** — reengagement 触发/影子/真发设计

### 历史设计与施工记录

- **[实施路线图（PR-A…G）](architecture/reliability/agent-reliability-implementation-roadmap.md)** 🗄️ — 2026-06 施工记录；当前实现以运行时现状文档为准
- **[Agent 架构重设计（基于 63 条 badcase）](architecture/reliability/agent-redesign-from-badcases.md)** 🗄️ — **已归档**，结论已并入上方 refactor 文档

### 守卫与安全

- **[安全护栏说明](architecture/security-guardrails.md)** ⭐ — 护栏现状总览：基础设施层 + Agent 三层守卫（input/tool/output）
- **[Guardrail LLM 层重设计](architecture/guardrail-llm-layer-redesign.md)** — 出站 LLM 语义层设计背景与决策记录（含实现进度）

### 平台系统

- **[测试套件架构](architecture/test-suite-architecture.md)** — LLM 评分对话质量评估框架（单轮 + 多轮 + 批量 + 飞书同步）
- **[监控系统架构](architecture/monitoring-system-architecture.md)** — 消息追踪、小时级聚合、Dashboard

---

## 🗄️ 数据库 (db/)

- **[数据库表设计与使用说明](db/database-schema.md)** — 表结构、索引、RPC 函数、数据生命周期
- **[Redis Key 设计与使用说明](db/redis-schema.md)** — Redis key 命名、TTL、Bull 队列前缀

---

## 🔧 基础设施 (infrastructure/)

- **[飞书通知系统](infrastructure/feishu-alert-system.md)** — 飞书 Webhook 机器人集成
- **[人工告警触发场景清单](infrastructure/human-alert-triggers.md)** — 需要人工介入的告警触发场景

---

## 📋 产品 (product/)

- **[产品定义](product/product-definition.md)** — 定位、用户角色、核心功能
- **[业务流程详细说明](product/business-flows.md)** — 候选人招聘全流程 + 群聊管理
- **[产品规划路线图](product/product-roadmap.md)** — 版本规划与功能优先级
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

- **[版本与发布指南](workflows/version-release-guide.md)** — 发布操作流程 + 版本自动化机制（原 auto-version-changelog 已并入）
- **[构建与部署指南](workflows/deploy-guide.md)** — tag 触发构建部署、健康检查、回滚
- **[分支保护规则配置](workflows/branch-protection-guide.md)** — 分支保护、环境隔离、CI 必需检查
- **[AI Code Review 配置指南](workflows/ai-code-review-guide.md)** — 基于 Claude Code CLI 的 PR 自动审查

---

## 🛠️ 技术专题 (technical/)

- **[Bull Queue 使用指南](technical/bull-queue-guide.md)** — 消息聚合队列的使用与排障

---

## 📌 待办与规划 (todo/)

> 这些是工程 backlog / 规划稿，不代表已实现的设计。落地后应更新对应架构文档或归档。

- **[Agent 高风险流程安全加固](todo/agent-safety-hardening.md)** — 安全加固 TODO（部分已并入守卫现状）
- **[告警链路全链路上下文富化](todo/alert-chain-context-enrichment.md)**
- **[告警持久化入口统一 + 监控 KPI 修正](todo/alert-persistence-unification.md)**
- **[Recruitment Case 跟进窗口与阶段回切治理](todo/recruitment-case-followup-window-and-stage-reset.md)**

---

## 🗂️ 文档规范

- **命名**：kebab-case，全小写，连字符分隔，描述性强，避免缩写（api/http 等公认缩写除外）
- **新增文档**：放到对应分类目录，并在本 README 补一行链接
- **更新文档**：同步文档内"最后更新"日期；重大改动同步本 README 描述
- **代码引用**：优先用 `文件路径 + 方法名`，避免硬编码行号（重构后易漂移）

## 🔗 相关资源

- 代码规范：[../.cursorrules](../.cursorrules) ｜ Agent 配置：[../.claude/agents/](../.claude/agents/)
- 架构原则：[../.claude/agents/architecture-principles.md](../.claude/agents/architecture-principles.md) ｜ 代码标准：[../.claude/agents/code-standards.md](../.claude/agents/code-standards.md)

---

**维护者**：DuLiDay Team ｜ **项目**：Cake Agent Runtime
