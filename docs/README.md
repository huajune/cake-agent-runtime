# 文档中心

> Cake Agent Runtime - 技术文档导航

**最后更新**：2026-03-23

---

## 📁 目录结构

```
docs/
├── README.md              # 本文档（文档索引）
├── architecture/          # 架构设计文档
│   ├── agent-runtime-architecture.md
│   ├── memory-system-architecture.md
│   ├── message-service-architecture.md
│   ├── monitoring-system-architecture.md
│   ├── alert-system-architecture.md
│   ├── test-suite-architecture.md
│   └── security-guardrails.md
├── db/                    # 数据库文档
│   ├── database-schema.md
│   └── redis-schema.md
├── infrastructure/        # 基础设施文档
│   └── feishu-alert-system.md
├── guides/                # 开发指南和教程
│   ├── development-guide.md
│   └── claude-code-safety-guide.md
├── workflows/             # 工作流程文档
│   ├── ai-code-review-guide.md
│   ├── auto-version-changelog.md
│   ├── branch-protection-guide.md
│   ├── deploy-guide.md
│   ├── conversation-test-workflow.md
│   ├── scenario-test-workflow.md
│   └── version-release-guide.md
└── product/               # 产品相关文档
    ├── business-flows.md
    ├── product-definition.md
    └── product-roadmap.md
```

---

## 🏗️ 架构设计 (architecture/)

- **[Agent 运行时架构](architecture/agent-runtime-architecture.md)** ⭐
  - 核心编排循环：Recall → Compose → Execute → Store
  - 三层 Provider 架构（注册 → 容错 → 路由）
  - Context 动态 Prompt 组装、工具系统、MCP 扩展
  - **更新日期**：2026-03-23

- **[Agent 记忆系统架构](architecture/memory-system-architecture.md)**
  - 四层记忆模型：短期、会话事实、程序性、长期档案（基于 CoALA 框架）
  - 固定注入 vs 工具按需检索的 Hybrid 策略
  - 会话沉淀机制：空闲超时 → Profile + Summary
  - **更新日期**：2026-03-19

- **[消息服务架构](architecture/message-service-architecture.md)**
  - 消息管道：去重 → 过滤 → 存储 → 聚合 → Agent → 投递
  - 消息聚合（1s 窗口 / max 3 条）、拟人化分段发送
  - **更新日期**：2025-11-04

- **[测试套件架构](architecture/test-suite-architecture.md)**
  - LLM 评分的对话质量评估框架
  - 单轮测试 + 多轮对话测试 + 批量执行
  - 飞书双向同步
  - **更新日期**：2026-03-12

- **[监控系统架构](architecture/monitoring-system-architecture.md)**
  - 消息追踪、小时级聚合分析、Dashboard 展示
  - **更新日期**：2025-11-25

- **[告警系统架构](architecture/alert-system-architecture.md)**
  - 飞书 Webhook 告警、业务指标告警、节流机制
  - **更新日期**：2025-11-25

- **[安全护栏说明](architecture/security-guardrails.md)**
  - API Token Guard、输入守卫、Prompt Injection 防护、输出上限
  - **更新日期**：2026-03-19

---

## 🗄️ 数据库 (db/)

- **[数据库表设计与使用说明](db/database-schema.md)**
  - 12 张表的完整字段定义与索引说明
  - 表分类：核心业务、用户管理、监控统计、配置管理、测试套件
  - 19 个 RPC 函数（清理、查询、Dashboard、聚合）
  - 数据生命周期与存储估算
  - **更新日期**：2026-03-11

---

## 🔧 基础设施 (infrastructure/)

- **[飞书告警系统](infrastructure/feishu-alert-system.md)**
  - 飞书 Webhook 机器人集成
  - 系统异常告警、话术降级告警、面试预约通知
  - **更新日期**：2026-03-19

**资源使用概览**：

| 服务 | 免费额度 | 当前使用率 |
|------|---------|-----------|
| Upstash Redis | 10K 命令/天 | ~15% |
| Supabase | 500 MB | < 2% |

---

## 📋 产品文档

- **[产品定义](product/product-definition.md)**
  - 产品定位：招聘专用 AI Agent 运行时
  - 用户角色（候选人、招募经理、店长、HR）
  - 核心功能：私聊咨询、群聊管理、数据报告
  - **更新日期**：2025-11-04

- **[业务流程详细说明](product/business-flows.md)**
  - 候选人招聘全流程（私聊 5 阶段）
  - 群聊管理场景（兼职群、店长群）
  - **更新日期**：2025-11-04

- **[产品规划路线图](product/product-roadmap.md)**
  - 版本规划与功能优先级
  - **更新日期**：2025-11-04

---

## 📝 开发指南

### 工作流程 (workflows/)

- **[自动化版本管理文档](workflows/auto-version-changelog.md)** (365 行)
  - GitHub Actions 自动化版本更新系统
  - Conventional Commits 规范和版本号规则
  - 完整使用示例和工作流程
  - 本地测试和故障排查
  - **更新日期**：2025-11-04

**系统特性**：

- ✅ 合并到 `master` 后自动更新版本并创建 release tag
- ✅ 根据 commits 智能判断版本类型
- ✅ 自动更新 package.json 和 CHANGELOG.md
- ✅ 支持 Conventional Commits 规范

**提交规范示例**：

```bash
feat: 添加新功能        # 次版本 +1
fix: 修复 bug         # 修订号 +1
docs: 更新文档        # 修订号 +1
```

- **[AI 代码审查指南](workflows/ai-code-review-guide.md)**
  - 🤖 配置 AI 自动代码审查功能（基于 Claude Code CLI）
  - Anthropic API Key 设置指南（与本地 Claude Code 复用同一 Key）
  - 审查范围和触发条件（仅 PR to `develop`）
  - 自定义审查规则和成本参考
  - **更新日期**：2026-03-12

**核心功能**：

- ✅ 自动审查 PR 的 TypeScript/JavaScript 代码
- ✅ 检查安全漏洞、性能问题、代码质量
- ✅ 验证架构合规性和项目规范
- ✅ 使用 Claude Code CLI 提供专业建议

- **[构建与部署指南](workflows/deploy-guide.md)**
  - 🚀 release tag → test → 服务器按 tag 构建部署 → 健康检查 → 飞书通知
  - 本地手动部署（`pnpm run deploy`）
  - 自动回滚机制和排查指南
  - **更新日期**：2026-03-25

**部署流程**：

- ✅ 版本 tag 触发后 SSH 到服务器拉取对应 tag 源码并构建
- ✅ 健康检查失败自动回滚到上一版本
- ✅ 飞书通知部署结果

- **[分支保护规则配置指南](workflows/branch-protection-guide.md)** (新增)
  - 🔒 GitHub 分支保护规则配置步骤
  - CI 检查项配置和必需状态检查
  - 常见阻塞场景和解决方案
  - 本地预检查最佳实践
  - 故障排查和安全建议
  - **更新日期**：2025-11-10

**必需检查项**：

- ✅ 代码质量检查 (ESLint + Prettier)
- ✅ TypeScript 类型检查
- ✅ 构建验证
- ✅ 单元测试通过
- ✅ PR 审批（至少 1 人）

### 开发工具指南

- **[开发指南](guides/development-guide.md)**
  - 开发环境配置和工作流程
  - Git hooks、Prettier、ESLint 配置
  - 环境变量管理（.env / .env.local）
  - 测试和构建流程
  - **更新日期**：2025-11-05

- **[Claude Code 安全使用指南](guides/claude-code-safety-guide.md)**
  - 🛡️ 已启用的安全防护机制
  - 危险命令黑名单（8个被禁止的命令）
  - 需要确认的高风险命令（5个）
  - 自动文件保护和提醒
  - 安全操作指南和最佳实践
  - 紧急情况处理方法
  - **更新日期**：2025-11-05

---

## 🗂️ 文档命名规范

所有文档文件必须遵循 **kebab-case** 命名规范：

### ✅ 正确示例

```
message-service-architecture.md
monitoring-system-architecture.md
product-definition.md
business-flows.md
```

### ❌ 错误示例

```
ARCHITECTURE.md          # 全大写
API_CONFIG.md            # SNAKE_CASE
ChatAgentGuide.md        # PascalCase
productDefinition.md     # camelCase
```

### 命名规则

1. **全小写字母**
2. **单词间用连字符 `-` 分隔**
3. **使用描述性名称**（能清楚表达文档内容）
4. **避免缩写**（除非是广泛认可的缩写，如 api、http）

---

## 📝 贡献指南

### 添加新文档

1. **确定文档类型**
   - 技术文档 → 放在 `docs/` 根目录
   - 产品文档 → 放在 `docs/product/`

2. **命名文件**
   - 使用 kebab-case 格式
   - 文件名要描述性强

3. **更新本 README**
   - 在对应分类下添加文档链接
   - 包含行数、简介、更新日期

4. **文档内容要求**
   - 添加标题和目录
   - 注明最后更新日期
   - 使用清晰的章节结构

### 更新现有文档

1. **修改文档内容**后，更新文档内的"最后更新"日期
2. 如果是重大更新，在本 README 中更新描述
3. 保持文档目录（TOC）与内容同步

---

## 🔗 相关资源

- **代码规范**：[../.cursorrules](../.cursorrules)
- **Agent 配置**：[../.claude/agents/](../.claude/agents/)
- **架构原则**：[../.claude/agents/architecture-principles.md](../.claude/agents/architecture-principles.md)
- **代码标准**：[../.claude/agents/code-standards.md](../.claude/agents/code-standards.md)

---

**维护者**：DuLiDay Team | **项目**：Cake Agent Runtime
