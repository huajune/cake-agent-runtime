# 文档中心

> DuLiDay 企业微信服务 - 技术文档导航

**最后更新**：2026-03-12

---

## 📁 目录结构

```
docs/
├── README.md              # 本文档（文档索引）
├── architecture/          # 架构设计文档
│   ├── message-service-architecture.md
│   ├── monitoring-system-architecture.md
│   └── alert-system-architecture.md
├── db/                    # 数据库文档
│   └── database-schema.md
├── infrastructure/        # 基础设施文档
│   └── redis-supabase-usage.md
├── guides/                # 开发指南和教程
│   ├── development-guide.md
│   ├── claude-code-safety-guide.md
├── workflows/             # 工作流程文档
│   ├── ai-code-review-guide.md
│   ├── auto-version-changelog.md
│   ├── branch-protection-guide.md
│   ├── deploy-guide.md
│   └── version-release-guide.md
└── product/               # 产品相关文档
    ├── business-flows.md
    ├── product-definition.md
    └── product-roadmap.md
```

---

## 🏗️ 架构设计 (architecture/)

- **[消息服务架构](architecture/message-service-architecture.md)**
  - 消息处理服务的重构架构
  - 从 1099 行巨石服务 → 5 个专职子服务
  - Bull Queue 智能消息聚合
  - 去重机制、历史管理、消息发送
  - **更新日期**：2025-11-04

- **[监控系统架构](architecture/monitoring-system-architecture.md)** (新增)
  - 三层存储架构：内存 → Redis → Supabase
  - 实时数据流与定时持久化
  - 前端 Dashboard 调用链路
  - 数据结构定义与故障恢复
  - **更新日期**：2025-11-25

- **[告警系统架构](architecture/alert-system-architecture.md)**
  - Orchestrator 编排模式
  - 错误告警与业务指标告警
  - 8 个核心服务组件
  - 飞书 Webhook 集成
  - **更新日期**：2025-11-25

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

- **[Redis 与 Supabase 资源使用指南](infrastructure/redis-supabase-usage.md)**
  - Redis (Upstash) 使用场景和 Key 规范
  - Supabase 表结构和 API 使用量
  - 成本估算和容量规划
  - 监控告警和故障排查
  - **更新日期**：2025-11-25

**资源使用概览**：

| 服务 | 免费额度 | 当前使用率 |
|------|---------|-----------|
| Upstash Redis | 10K 命令/天 | ~15% |
| Supabase | 500 MB | < 2% |

---

## 📋 产品文档

- **[产品定义](product/product-definition.md)** (205 行)
  - 产品定位和核心价值
  - 用户角色和应用场景
  - 核心功能列表和指标
  - **更新日期**：2025-11-04

- **[业务流程详细说明](product/business-flows.md)** (497 行)
  - 候选人招聘全流程（8个阶段）
  - 私聊对话场景（欢迎语、岗位咨询、面试安排、提醒、跟进）
  - 群聊管理场景（兼职群、店长群）
  - 店长报缺流程和数据报告
  - **更新日期**：2025-11-04

- **[产品规划路线图](product/product-roadmap.md)** (148 行)
  - 版本规划（MVP/V1.0、V1.1、V2.0）
  - 功能优先级和实施计划
  - 技术风险与应对策略
  - 成功标准和业务目标
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

- ✅ 推送到 develop/main/master 自动触发
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

- **[构建与部署指南](workflows/deploy-guide.md)** (新增)
  - 🚀 push to master 自动构建 Docker 镜像并发布 GitHub Release
  - 对接方部署步骤（下载 Release 附件 → 配置 .env → docker compose up）
  - 镜像更新流程和 GHCR 登录说明
  - 常见问题排查
  - **更新日期**：2026-03-12

**部署流程**：

- ✅ 自动构建 Docker 镜像推送到 GHCR
- ✅ 自动生成含精确镜像 tag 的 docker-compose.yml
- ✅ 以 GitHub Release 附件形式交付部署文件

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

**维护者**：DuLiDay Team
