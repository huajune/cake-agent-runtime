# Cake Agent Runtime

**最后更新**：2026-07-23

DuLiDay 的招聘 AI Agent 运行时。系统通过企业微信承接候选人对话，完成岗位咨询、面试预约、进群、人工介入和主动复聊，并提供监控、质量评测及运营 Dashboard。

## 核心能力

- **Agent 编排**：准备上下文、生成、多步工具调用、结果审查和回合收尾
- **多模型容错**：模型注册、重试降级和按角色路由
- **四层记忆**：短期消息、会话事实、程序性阶段和长期画像
- **三层守卫**：输入风险拦截、工具调用约束和输出事实审查
- **消息管线**：企业微信消息去重、聚合、处理、拟人化投递和失败补偿
- **质量体系**：单轮/多轮测试、批量执行、LLM 评审和飞书回写
- **运营能力**：监控 Dashboard、告警、群任务、转化分析和复聊

```text
企业微信消息
  → 消息接入与聚合
  → Agent Runner
      → Preparation / Context
      → Generator Agent + Tools
      → Guardrails / Repair
      → Memory Lifecycle
  → 分段投递
  → 监控、告警与评测
```

完整介绍见 [文档中心](./docs/README.md) 和 [系统概览](./docs/cake-agent-runtime-overview.md)。

## 技术栈

| 领域 | 技术 |
| --- | --- |
| 后端 | NestJS 10、TypeScript、Vercel AI SDK |
| 模型 | Anthropic、OpenAI、DeepSeek、Gemini、OpenRouter 等 |
| 数据 | Supabase/PostgreSQL、Upstash Redis、Bull |
| 前端 | React 18、Vite |
| 集成 | 企业微信、飞书、DuLiDay/Stride、MCP |
| 工程 | pnpm workspace、Jest、ESLint、Prettier、Husky |

## 快速开始

### 环境要求

- Node.js `>= 22`
- pnpm `10.x`（仓库声明版本：`10.34.5`）
- Git

```bash
git clone https://github.com/huajune/cake-agent-runtime.git
cd cake-agent-runtime

pnpm install --frozen-lockfile
cp .env.example .env.local
# 编辑 .env.local，填入本地环境所需配置

pnpm run start:dev
```

`start:dev` 会先构建 `web/`，再以 watch 模式启动 NestJS。默认端口是 `8585`。

环境变量以 [.env.example](./.env.example) 为准。关键配置包括：

- 模型 Provider 密钥和 `AGENT_*_MODEL` 角色映射
- Redis、Supabase 和 DuLiDay/Stride 连接信息
- `API_GUARD_TOKEN`
- 飞书应用、表格和告警配置
- 可选的复聊、测试套件和外部集成配置

不要提交 `.env.local`、`.env.production` 或任何真实密钥。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm run start:dev` | 构建前端并启动后端 watch 模式 |
| `pnpm run web:dev` | 单独启动 Vite 开发服务器 |
| `pnpm run build` | 构建后端 |
| `pnpm run build:web` | 构建前端到 `public/web/` |
| `pnpm run build:ci` | 构建前后端 |
| `pnpm run typecheck` | TypeScript 类型检查 |
| `pnpm run lint:check` | ESLint 只读检查 |
| `pnpm run format:check` | Prettier 只读检查 |
| `pnpm run test` | 运行 Jest 测试 |
| `pnpm run test:ci` | 运行 CI 测试并生成覆盖率 |
| `pnpm run ci:check` | 执行完整本地 CI 校验 |
| `pnpm run test:di-smoke` | 运行依赖注入 smoke test |

需要自动修复时再运行 `pnpm run lint` 或 `pnpm run format`。

## 项目结构

```text
cake-agent-runtime/
├── src/
│   ├── agent/
│   │   ├── runner/             # 回合编排、结果状态与收尾
│   │   ├── generator/          # Agent、Preparation、Context 与 Prompt Sections
│   │   ├── guardrail/          # input / tool / output 三层守卫
│   │   ├── reply-repair/       # 受控回复修复
│   │   └── reengagement/       # 主动复聊调度、生成和触达底账
│   ├── channels/wecom/         # 企业微信接入、消息处理与发送
│   ├── biz/                    # 业务模块、监控、策略、测试套件、群任务
│   ├── memory/                 # 四层记忆与生命周期
│   ├── providers/              # 模型注册、重试降级和角色路由
│   ├── llm/                    # 统一 LLM 执行入口
│   ├── tools/                  # 内置工具及工具契约
│   ├── resolution/             # 品牌、地理等确定性解析
│   ├── observability/          # Trace、运行记录与事故上报
│   ├── notification/           # 告警通知与渲染
│   ├── evaluation/             # LLM 质量评估
│   ├── infra/                  # HTTP、Redis、Supabase、队列、飞书、服务入口
│   └── mcp/                    # MCP 客户端
├── web/                        # React Dashboard
├── tests/                      # 单元、集成和回归测试
├── supabase/                   # 数据库迁移
├── docs/                       # 当前文档与历史归档
├── scripts/                    # 运维、数据和发布脚本
├── public/web/                 # 可重新生成的前端构建产物
└── .release/                   # 发布自动化状态
```

## API 快速验证

健康检查是公开接口：

```bash
curl http://localhost:8585/agent/health
```

配置了 `API_GUARD_TOKEN` 后，其余接口需要 Bearer Token：

```bash
curl \
  -H "Authorization: Bearer $API_GUARD_TOKEN" \
  http://localhost:8585/agent/models
```

调试 Agent：

```bash
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Authorization: Bearer $API_GUARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "你好，我想找附近的兼职",
    "sessionId": "debug-001",
    "scenario": "candidate-consultation",
    "userId": "debug-user"
  }'
```

主要入口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/agent/health` | Redis、Supabase 和运行时健康状态 |
| `GET` | `/agent/models` | 已注册模型 |
| `POST` | `/agent/debug-chat` | 使用生产同款守卫链路调试 Agent |
| `POST` | `/message` | 企业微信消息接入 |
| `POST` | `/message/send` | 单条消息发送 |
| `POST` | `/message/broadcast` | 批量消息发送 |
| `GET` | `/analytics/dashboard/overview` | Dashboard 总览 |
| `POST` | `/test-suite/batches` | 创建测试批次 |

详细接口以对应 Controller 和 [文档中心](./docs/README.md) 为准。

## 开发与提交

推荐从 `develop` 创建功能分支，通过 Pull Request 合并：

```bash
git checkout develop
git pull --ff-only origin develop
git checkout -b feature/your-change

pnpm run ci:check
git commit -m "feat: 描述改动"
git push origin feature/your-change
```

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

发版是 PR 驱动的两段式流程：日常改动进入 `develop`，正式版本通过 `develop → master` release PR 发布。不要手工修改版本号或 `.release/pending-release.json`。详见：

- [版本与发布指南](./docs/workflows/version-release-guide.md)
- [发版底账](./docs/releases/README.md)
- [构建与部署指南](./docs/workflows/deploy-guide.md)

## 文档导航

- [文档中心](./docs/README.md)
- [Agent 运行时架构](./docs/architecture/agent-runtime-architecture.md)
- [消息服务架构](./docs/architecture/message-service-architecture.md)
- [记忆系统架构](./docs/architecture/memory-system-architecture.md)
- [安全护栏](./docs/architecture/security-guardrails.md)
- [监控系统架构](./docs/architecture/monitoring-system-architecture.md)
- [开发指南](./docs/guides/development-guide.md)
- [测试套件指南](./docs/guides/test-suite-guide.md)

已经完成或被替代的设计记录位于 [历史文档](./docs/archive/README.md)，不代表当前实现。

## 常见问题

### 端口被占用

开发启动会尝试清理占用默认端口的本地进程。需要手工排查时：

```bash
lsof -i :8585
```

也可以在 `.env.local` 中调整 `PORT`。

### 依赖或构建异常

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build:ci
```

### Redis、Supabase 或模型不可用

先访问 `/agent/health`，再检查 `.env.local` 中对应连接配置。模型调用问题可通过 `/agent/debug-chat` 查看完整 steps、guardrail 和 trace。

## License

ISC

问题反馈请提交到 [GitHub Issues](https://github.com/huajune/cake-agent-runtime/issues)。
