# Cake Agent Runtime

**Last Updated**: 2026-03-23

自主 AI Agent 运行时，基于 NestJS + Vercel AI SDK 多 Provider 架构，支持智能对话和自动回复。

## 项目简介

DuLiDay 旗下的**招聘专用 AI Agent 运行时**，通过企业微信渠道为餐饮连锁企业提供智能招聘对话服务。

- 🧠 **Agent 编排**：Recall → Compose → Execute → Store 闭环，多步工具调用
- 🔄 **多模型容错**：三层 Provider 架构（注册 → 重试/降级 → 角色路由）
- 💾 **四层记忆**：短期对话 → 会话事实 → 程序性阶段 → 长期用户画像
- 🛠️ **工具调用**：岗位查询、面试预约、阶段推进 + MCP 动态扩展
- 📊 **质量评估**：LLM 评分的对话测试框架，飞书双向同步

**核心流程**：

```
企业微信用户消息
  → 托管平台回调 → 消息管道（去重 → 过滤 → 存储 → 聚合）
  → Agent 编排（记忆加载 → Prompt 组装 → 多步工具调用 → 记忆沉淀）
  → 拟人化分段回复
```

## 技术栈

| 组件   | 技术                                                    |
| ------ | ------------------------------------------------------- |
| 框架   | NestJS 10.3 + TypeScript 5.3                            |
| AI SDK | Vercel AI SDK（Anthropic、OpenAI、DeepSeek、Gemini 等） |
| 数据库 | Supabase（PostgreSQL）                                  |
| 缓存   | Upstash Redis（REST）                                   |
| 队列   | Bull                                                    |
| 告警   | 飞书 Webhook                                            |
| 日志   | Winston + 文件轮转                                      |
| 前端   | React 18 + Vite                                         |

---

## 快速开始

### 前置要求

**必需软件**

| 软件    | 版本要求 | 安装方式                         |
| ------- | -------- | -------------------------------- |
| Node.js | >= 20.x  | [官网下载](https://nodejs.org/)  |
| pnpm    | >= 10.x  | `npm install -g pnpm`            |
| Git     | >= 2.x   | [官网下载](https://git-scm.com/) |

**推荐 IDE**

| IDE                                                                                     | 说明                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [Cursor](https://cursor.sh/) + [Claude Code](https://github.com/anthropics/claude-code) | 🌟 **强烈推荐**：AI 辅助开发，提升 30-50% 效率 |
| [Cursor](https://cursor.sh/) + [Codex](https://codex.so/)                               | AI 辅助开发的备选方案                          |
| [VS Code](https://code.visualstudio.com/)                                               | 传统开源 IDE                                   |

验证安装：

```bash
node --version    # 应输出 v20.x.x 或更高
pnpm --version    # 应输出 10.x.x 或更高
```

### 安装依赖

```bash
# 克隆项目
git clone <repository-url>
cd cake-agent-runtime

# 安装依赖
pnpm install
```

### 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env.local

# 编辑配置文件，填写必填项
vim .env.local
```

**配置策略**：采用三层配置，简化管理

| Layer        | 说明                     | 示例                                               |
| ------------ | ------------------------ | -------------------------------------------------- |
| **Layer 1**  | 必填密钥/URL（无默认值） | `ANTHROPIC_API_KEY`, `FEISHU_ALERT_WEBHOOK_URL`    |
| **Layer 2**  | 可选参数（有默认值）     | `PARAGRAPH_GAP_MS=2000`                            |
| **Layer 3**  | 硬编码默认值             | 告警节流 5 分钟                                    |
| **托管配置** | Dashboard 动态调整       | `initialMergeWindowMs` (消息静默窗口, 默认 3000ms) |

**最小配置示例**（只需填写 Layer 1）：

```env
# === Layer 1: 必填密钥/URL ===
ANTHROPIC_API_KEY=your-anthropic-key
AGENT_CHAT_MODEL=anthropic/claude-sonnet-4-5-20250929
AGENT_DEFAULT_MODEL=anthropic/claude-sonnet-4-5-20250929

UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token

DULIDAY_API_TOKEN=your-token

STRIDE_API_BASE_URL=https://stride-bg.dpclouds.com
STRIDE_ENTERPRISE_API_BASE_URL=https://stride-bg.dpclouds.com/hub-api

FEISHU_ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_ALERT_SECRET=your-secret

NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key

# === Layer 2: 按需覆盖（都有默认值）===
# PARAGRAPH_GAP_MS=2500          # 段落间隔，默认 2000ms
# TYPING_DELAY_PER_CHAR_MS=120   # 打字延迟/字符，默认 100ms
```

> 💡 消息聚合的静默窗口 (`initialMergeWindowMs`, 默认 3000ms) 通过 Dashboard 托管配置动态调整，不再是环境变量。

**获取配置的地方**：
| 配置项 | 获取方式 |
|--------|----------|
| AI Provider API Key | 各 Provider 官网 (Anthropic, OpenAI 等) |
| Upstash Redis | [Upstash Console](https://console.upstash.com/) |
| 飞书 Webhook | 飞书群 → 设置 → 群机器人 → 添加自定义机器人 |
| Supabase | [Supabase Dashboard](https://supabase.com/dashboard) |
| DuLiDay/Stride | 联系管理员 |

### 启动服务

```bash
# 开发模式（支持热重载）
pnpm run start:dev

# 看到以下输出表示启动成功：
# [Nest] LOG [NestApplication] Nest application successfully started
```

### 验证服务

```bash
# 健康检查
curl http://localhost:8585/agent/health

# 查看可用 AI 模型
curl http://localhost:8585/agent/models

# 调试 AI 对话（返回完整原始响应）
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"debug-001"}'
```

---

## 环境变量说明

### Layer 1: 必填配置（密钥/URL）

| 变量                        | 说明               | 来源       |
| --------------------------- | ------------------ | ---------- |
| `ANTHROPIC_API_KEY`         | Anthropic API 密钥 | Anthropic  |
| `AGENT_CHAT_MODEL`          | 主聊天模型 ID      | 环境配置   |
| `UPSTASH_REDIS_REST_URL`    | Redis REST API URL | Upstash    |
| `UPSTASH_REDIS_REST_TOKEN`  | Redis REST Token   | Upstash    |
| `DULIDAY_API_TOKEN`         | 杜力岱 API Token   | 内部系统   |
| `STRIDE_API_BASE_URL`       | 托管平台 API       | Stride     |
| `FEISHU_ALERT_WEBHOOK_URL`  | 飞书告警 Webhook   | 飞书机器人 |
| `FEISHU_ALERT_SECRET`       | 飞书签名密钥       | 飞书机器人 |
| `NEXT_PUBLIC_SUPABASE_URL`  | Supabase URL       | Supabase   |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥      | Supabase   |

### Layer 2: 可选配置（有默认值）

| 变量                       | 默认值    | 说明                | 使用位置        |
| -------------------------- | --------- | ------------------- | --------------- |
| `PORT`                     | `8585`    | 服务端口            | main.ts         |
| `MAX_HISTORY_PER_CHAT`     | `60`      | Redis 消息数限制    | message-history |
| `HISTORY_TTL_MS`           | `7200000` | Redis 消息 TTL (2h) | message-history |
| `TYPING_DELAY_PER_CHAR_MS` | `100`     | 打字延迟/字符       | message-sender  |
| `PARAGRAPH_GAP_MS`         | `2000`    | 段落间隔            | message-sender  |

> **消息聚合参数已下沉到托管配置 (`hosting_config` 表)**：
>
> - `initialMergeWindowMs` — 默认 `3000`，语义：距离最后一条用户消息静默多久后才触发 Agent（debounce 窗口）
> - 通过 Dashboard 动态修改，即时生效
> - 旧的 `INITIAL_MERGE_WINDOW_MS` / `MAX_MERGED_MESSAGES` 环境变量已废弃

### Layer 3: 硬编码默认值（无需配置）

| 配置             | 值        | 位置               |
| ---------------- | --------- | ------------------ |
| 告警节流窗口     | 5 分钟    | FeishuAlertService |
| 告警最大次数     | 3 次/类型 | FeishuAlertService |
| Profile 缓存 TTL | 1 小时    | ContextService     |

> 完整配置项见 [.env.example](./.env.example)，配置策略详见 [CLAUDE.md](./CLAUDE.md#5-configuration-strategy)。

---

## 项目结构

```
cake-agent-runtime/
├── src/
│   ├── agent/                       # Agent 编排层
│   │   ├── runner.service.ts        # 核心编排引擎（Recall → Compose → Execute → Store）
│   │   ├── completion.service.ts    # 简单一次性 LLM 调用
│   │   ├── context/                 # 动态 Prompt 组装（Section 体系）
│   │   ├── fact-extraction.service.ts  # LLM 事实提取
│   │   └── input-guard.service.ts   # 输入安全检测
│   │
│   ├── llm/                         # 共享 LLM 门面层
│   │   ├── llm.gateway.service.ts   # 统一 generate / structured / stream / chat-turn
│   │   └── llm.types.ts             # 角色等 LLM 语义类型
│   │
│   ├── providers/                   # 多模型 Provider 层
│   │   ├── registry.service.ts      # Layer 1: 工厂注册
│   │   ├── reliable.service.ts      # Layer 2: 重试 + 降级
│   │   └── router.service.ts        # Layer 3: 角色路由
│   │
│   ├── memory/                      # 四层记忆系统
│   │   ├── short-term.service.ts    # 对话窗口
│   │   ├── session-facts.service.ts # 会话事实（意向/推荐）
│   │   ├── procedural.service.ts    # 阶段追踪
│   │   ├── long-term.service.ts     # 用户画像（持久化）
│   │   └── settlement.service.ts    # 空闲沉淀
│   │
│   ├── tools/                       # 工具注册表 + 内置工具
│   ├── channels/wecom/              # 企业微信渠道
│   │   └── message/                 # 消息管道（去重/过滤/聚合/投递）
│   ├── biz/                         # 业务层（监控/用户/策略/测试套件）
│   ├── evaluation/                  # 对话质量评估框架
│   ├── infra/                       # 基础设施（Redis/Supabase/飞书/日志）
│   └── mcp/                         # MCP 客户端（动态工具扩展）
│
├── web/                             # React 前端 Dashboard
├── supabase/migrations/             # 数据库迁移
├── docs/                            # 技术文档
├── .env.example                     # 环境变量模板
└── CLAUDE.md                        # Claude Code 开发指南
```

---

## 开发指南

### NPM 脚本

| 命令                  | 说明                         |
| --------------------- | ---------------------------- |
| `pnpm run start:dev`  | 启动开发服务器（支持热重载） |
| `pnpm run build`      | 构建生产代码                 |
| `pnpm run start:prod` | 启动生产服务（需先 build）   |
| `pnpm run lint`       | 代码检查并自动修复           |
| `pnpm run format`     | 格式化代码                   |
| `pnpm run test`       | 运行测试                     |
| `pnpm run test:cov`   | 生成测试覆盖率报告           |

### 开发流程

```bash
# 1. 创建功能分支
git checkout -b feature/your-feature-name

# 2. 启动开发服务器（修改代码后自动重启）
pnpm run start:dev

# 3. 提交代码（遵循 Conventional Commits 规范）
git commit -m "feat: 添加新功能"      # 新功能（次版本号 +1）
git commit -m "fix: 修复 Bug"        # Bug 修复（修订号 +1）
git commit -m "docs: 更新文档"       # 文档更新

# 4. 提交前检查
pnpm run lint && pnpm run format && pnpm run test
```

> **版本管理**：当 develop 合并到 master 后，GitHub Actions 会自动：
>
> - 分析 commits 更新版本号
> - 生成 CHANGELOG.md
> - 推送 release commit 到 `master`
> - 将该 release commit 同步回 `develop`
> - 创建版本 tag（如 `v1.2.3`）
> - 由该 tag 触发生产部署
>
> 详见 [Conventional Commits](https://www.conventionalcommits.org/)。

### 调试和测试

```bash
# 查看日志
tail -f logs/combined-$(date +%Y-%m-%d).log

# API 测试（使用 curl）
curl http://localhost:8585/agent/health
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"debug-001"}'

# VS Code 调试：按 F5 启动，在代码中设置断点
# 或使用项目根目录的 api-test.http 文件（需 REST Client 插件）
```

---

## 常见问题

### 端口被占用

```bash
lsof -i :8585        # 查找占用端口的进程
kill -9 <PID>        # 杀死进程
# 或修改 .env 中的 PORT
```

### Agent API 调用失败

检查 `ANTHROPIC_API_KEY` 和 `AGENT_CHAT_MODEL` 是否正确，测试连接：

```bash
curl http://localhost:8585/agent/health
```

### 消息回调未触发

- 服务是否正常运行？`curl http://localhost:8585/agent/health`
- 托管平台是否配置回调地址？`http://your-domain.com/message`
- 服务是否可从外网访问？可使用 [ngrok](https://ngrok.com/) 测试
- `ENABLE_AI_REPLY` 是否为 `true`？

### 其他问题

- **依赖安装失败**：`pnpm store prune && rm -rf node_modules && pnpm install`
- **热重载不工作**：`rm -rf dist && pnpm run start:dev`
- **Redis 连接失败**：开发环境设置 `ENABLE_BULL_QUEUE=false`

---

## 部署

### CI 自动部署

代码合并到 `master` 后，GitHub Actions 会先自动更新版本、同步 release commit 到 `develop`，再创建 `vX.Y.Z` tag，并由该 tag 触发生产部署。

### 本地手动部署

```bash
# 部署 master 分支
pnpm run deploy

# 部署指定分支
pnpm run deploy haimian-deploy develop
```

详见 [构建与部署指南](./docs/workflows/deploy-guide.md)。

---

## API 文档

### 核心接口

**消息回调接口**（托管平台调用）

```bash
POST /message
Content-Type: application/json

{
  "token": "group_token",
  "msgId": "msg-123",
  "fromUser": "wxid_xxxxx",
  "content": "用户发送的消息",
  "messageType": "text",
  "timestamp": 1697000000000,
  "isRoom": false,
  "roomId": ""
}
```

**Agent 测试接口**

```bash
# 健康检查
GET /agent/health

# 获取可用模型
GET /agent/models

# 获取可用工具
GET /agent/tools

# 调试聊天（完整原始响应）
POST /agent/debug-chat
{
  "message": "你好",
  "conversationId": "debug-001"
}
```

**消息发送接口**

```bash
# 发送消息
POST /message-sender/send
{
  "token": "group_token",
  "content": "消息内容",
  "toWxid": "wxid_xxxxx",
  "msgType": 1
}

# 群发消息
POST /message-sender/broadcast
{
  "token": "group_token",
  "content": "群发消息",
  "toWxids": ["wxid_1", "wxid_2"],
  "msgType": 1
}
```

**详细文档**：

- [Agent 运行时架构](./docs/architecture/agent-runtime-architecture.md)
- [消息服务架构](./docs/architecture/message-service-architecture.md)
- [记忆系统架构](./docs/architecture/memory-system-architecture.md)
- [开发指南](./docs/guides/development-guide.md)

---

## 相关资源

**API 文档**

- [托管平台企业级 API](https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445)
- [托管平台小组级 API](https://s.apifox.cn/acec6592-fec1-443b-8563-10c4a10e64c4)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)

**技术文档**

- [NestJS 官方文档](https://docs.nestjs.com/)
- [Conventional Commits 规范](https://www.conventionalcommits.org/)

**推荐开发工具**

- [Cursor](https://cursor.sh/) + [Claude Code](https://github.com/anthropics/claude-code) - 强烈推荐的 AI 编程工具（推荐）
- [Cursor](https://cursor.sh/) + [Codex](https://codex.so/) - AI 辅助开发（推荐）
- [Postman](https://www.postman.com/) - API 测试
- [ngrok](https://ngrok.com/) - 内网穿透（测试回调）
- [Upstash Console](https://console.upstash.com/) - Redis 管理

---

## 贡献

欢迎提交 Issue 和 Pull Request！

提交前请确保：

- 代码通过 `pnpm run lint` 检查
- 代码通过 `pnpm run test` 测试
- Commit 信息遵循 Conventional Commits 规范

---

## 许可证

ISC

---

## 获取帮助

- **快速开始**：查看本文档的[快速开始](#快速开始)部分
- **常见问题**：查看[常见问题](#常见问题)部分
- **详细文档**：查看 [docs/](./docs/) 目录
- **问题反馈**：提交 [Issue](../../issues)

---

**开发愉快！** 🚀
