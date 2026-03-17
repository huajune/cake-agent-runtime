# DuLiDay 企业微信服务

**Last Updated**: 2025-11-25

基于 NestJS 的企业微信智能服务中间层，集成 AI Agent 实现智能对话和自动回复。

## 项目简介

本项目是一个企业微信服务的中间层系统，连接企业微信托管平台和 AI Agent 服务，实现：

- 🤖 **AI 智能回复**：接收企业微信消息，自动调用 AI 生成智能回复
- 💬 **多轮对话**：支持上下文记忆，维护连贯的对话体验
- 🔧 **托管平台集成**：封装企业微信托管平台 API，提供统一的操作接口
- 📦 **模块化设计**：支持按需启用功能，易于扩展

**工作流程**：
```
企业微信用户发送消息
  → 托管平台接收并回调本服务 (/message)
  → 服务调用 AI Agent 生成回复
  → 通过托管平台发送回复给用户
```

## 技术栈

- **框架**：NestJS 10.x
- **语言**：TypeScript 5.x
- **HTTP 客户端**：Axios
- **队列**：Bull + Redis（可选）
- **日志**：Winston
- **配置管理**：@nestjs/config

---

## 快速开始

### 前置要求

**必需软件**

| 软件 | 版本要求 | 安装方式 |
|------|---------|----------|
| Node.js | >= 18.x | [官网下载](https://nodejs.org/) |
| pnpm | >= 8.x | `npm install -g pnpm` |
| Git | >= 2.x | [官网下载](https://git-scm.com/) |

**推荐 IDE**

| IDE | 说明 |
|-----|------|
| [Cursor](https://cursor.sh/) + [Claude Code](https://github.com/anthropics/claude-code) | 🌟 **强烈推荐**：AI 辅助开发，提升 30-50% 效率 |
| [Cursor](https://cursor.sh/) + [Codex](https://codex.so/) | AI 辅助开发的备选方案 |
| [VS Code](https://code.visualstudio.com/) | 传统开源 IDE |

验证安装：
```bash
node --version    # 应输出 v18.x.x 或更高
pnpm --version    # 应输出 8.x.x 或更高
```

### 安装依赖

```bash
# 克隆项目
git clone <repository-url>
cd duliday-wecom-service

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

| Layer | 说明 | 示例 |
|-------|------|------|
| **Layer 1** | 必填密钥/URL（无默认值） | `ANTHROPIC_API_KEY`, `FEISHU_ALERT_WEBHOOK_URL` |
| **Layer 2** | 可选参数（有默认值） | `INITIAL_MERGE_WINDOW_MS=1000` |
| **Layer 3** | 硬编码默认值 | 告警节流 5 分钟 |

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
# INITIAL_MERGE_WINDOW_MS=3000   # 消息聚合等待时间，默认 1000ms
# MAX_MERGED_MESSAGES=5          # 最大聚合条数，默认 3
```

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
curl http://localhost:8080/agent/health

# 查看可用 AI 模型
curl http://localhost:8080/agent/models

# 调试 AI 对话（返回完整原始响应）
curl -X POST http://localhost:8080/agent/debug-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"debug-001"}'
```

---

## 环境变量说明

### Layer 1: 必填配置（密钥/URL）

| 变量 | 说明 | 来源 |
|------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | Anthropic |
| `AGENT_CHAT_MODEL` | 主聊天模型 ID | 环境配置 |
| `UPSTASH_REDIS_REST_URL` | Redis REST API URL | Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST Token | Upstash |
| `DULIDAY_API_TOKEN` | 杜力岱 API Token | 内部系统 |
| `STRIDE_API_BASE_URL` | 托管平台 API | Stride |
| `FEISHU_ALERT_WEBHOOK_URL` | 飞书告警 Webhook | 飞书机器人 |
| `FEISHU_ALERT_SECRET` | 飞书签名密钥 | 飞书机器人 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥 | Supabase |

### Layer 2: 可选配置（有默认值）

| 变量 | 默认值 | 说明 | 使用位置 |
|------|--------|------|----------|
| `PORT` | `8080` | 服务端口 | main.ts |
| `MAX_HISTORY_PER_CHAT` | `60` | Redis 消息数限制 | message-history |
| `HISTORY_TTL_MS` | `7200000` | Redis 消息 TTL (2h) | message-history |
| `INITIAL_MERGE_WINDOW_MS` | `1000` | 聚合等待时间 | message-merge |
| `MAX_MERGED_MESSAGES` | `3` | 最大聚合条数 | message-merge |
| `TYPING_DELAY_PER_CHAR_MS` | `100` | 打字延迟/字符 | message-sender |
| `PARAGRAPH_GAP_MS` | `2000` | 段落间隔 | message-sender |

### Layer 3: 硬编码默认值（无需配置）

| 配置 | 值 | 位置 |
|------|-----|------|
| 告警节流窗口 | 5 分钟 | FeishuAlertService |
| 告警最大次数 | 3 次/类型 | FeishuAlertService |
| 健康检查间隔 | 1 小时 | AgentRegistryService |
| Profile 缓存 TTL | 1 小时 | ProfileLoaderService |

> 完整配置项见 [.env.example](./.env.example)，配置策略详见 [CLAUDE.md](./CLAUDE.md#5-configuration-strategy)。

---

## 项目结构

```
duliday-wecom-service/
├── src/
│   ├── core/                        # 基础设施层（横向）
│   │   ├── config/                  # 配置管理（环境变量验证）
│   │   ├── http/                    # HTTP 客户端工厂
│   │   ├── redis/                   # Redis 缓存（全局模块）
│   │   ├── supabase/                # Supabase 数据库服务
│   │   ├── monitoring/              # 系统监控 & 仪表盘
│   │   ├── alert/                   # 告警系统（单一服务 ~300 行）
│   │   └── server/response/         # 统一响应（拦截器 + 过滤器）
│   │
│   ├── agent/                       # AI Agent 领域
│   │   ├── agent.service.ts         # Agent API 调用层
│   │   ├── services/
│   │   │   ├── agent-api-client.service.ts  # HTTP 客户端层
│   │   │   ├── agent-registry.service.ts    # 模型/工具注册
│   │   │   ├── agent-fallback.service.ts    # 降级消息管理
│   │   │   ├── brand-config.service.ts      # 品牌配置管理
│   │   │   └── agent-profile-loader.service.ts  # Profile 加载（含缓存）
│   │   └── profiles/                # Agent 配置文件
│   │
│   └── wecom/                       # 企业微信领域
│       ├── message/                 # 消息处理（核心业务）
│       │   ├── message.service.ts   # 主协调器（~300 行）
│       │   └── services/            # 子服务（单一职责）
│       │       ├── message-history.service.ts   # Redis 历史
│       │       ├── message-merge.service.ts     # 智能聚合
│       │       └── message-filter.service.ts    # 消息过滤
│       ├── message-sender/          # 消息发送
│       └── ...                      # 其他模块
│
├── docs/                            # 文档目录
├── dashboard/                       # React 监控仪表盘
├── .env.example                     # 环境变量模板
├── .env.local                       # 本地配置（不提交）
├── CLAUDE.md                        # Claude Code 开发指南
└── README.md
```

---

## 开发指南

### NPM 脚本

| 命令 | 说明 |
|------|------|
| `pnpm run start:dev` | 启动开发服务器（支持热重载） |
| `pnpm run build` | 构建生产代码 |
| `pnpm run start:prod` | 启动生产服务（需先 build） |
| `pnpm run lint` | 代码检查并自动修复 |
| `pnpm run format` | 格式化代码 |
| `pnpm run test` | 运行测试 |
| `pnpm run test:cov` | 生成测试覆盖率报告 |

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
> - 分析 commits 更新版本号
> - 生成 CHANGELOG.md
> - 创建版本 tag（如 v1.2.3）
>
> 详见 [Conventional Commits](https://www.conventionalcommits.org/)。

### 调试和测试

```bash
# 查看日志
tail -f logs/combined-$(date +%Y-%m-%d).log

# API 测试（使用 curl）
curl http://localhost:8080/agent/health
curl -X POST http://localhost:8080/agent/debug-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","conversationId":"debug-001"}'

# VS Code 调试：按 F5 启动，在代码中设置断点
# 或使用项目根目录的 api-test.http 文件（需 REST Client 插件）
```

---

## 常见问题

### 端口被占用

```bash
lsof -i :8080        # 查找占用端口的进程
kill -9 <PID>        # 杀死进程
# 或修改 .env 中的 PORT=8081
```

### Agent API 调用失败

检查 `ANTHROPIC_API_KEY` 和 `AGENT_CHAT_MODEL` 是否正确，测试连接：
```bash
curl http://localhost:8080/agent/health
```

### 消息回调未触发

- 服务是否正常运行？`curl http://localhost:8080/agent/health`
- 托管平台是否配置回调地址？`http://your-domain.com/message`
- 服务是否可从外网访问？可使用 [ngrok](https://ngrok.com/) 测试
- `ENABLE_AI_REPLY` 是否为 `true`？

### 其他问题

- **依赖安装失败**：`pnpm store prune && rm -rf node_modules && pnpm install`
- **热重载不工作**：`rm -rf dist && pnpm run start:dev`
- **Redis 连接失败**：开发环境设置 `ENABLE_BULL_QUEUE=false`

---

## 部署

### Docker 部署（推荐）

```bash
# 方式 1: 使用 Docker
docker build -t duliday-wecom-service .
docker run -d -p 8080:8080 --env-file .env --name wecom-service duliday-wecom-service
docker logs -f wecom-service

# 方式 2: 使用 Docker Compose（推荐）
docker-compose up -d
docker-compose logs -f
docker-compose ps
```

**生产环境配置**（`.env`）：

```env
NODE_ENV=production
ENABLE_BULL_QUEUE=true                                     # 启用 Redis 队列
UPSTASH_REDIS_TCP_URL=rediss://default:password@host:6379 # Bull 队列地址
```

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
- [Agent 服务架构](./docs/agent-service-architecture.md)
- [消息服务架构](./docs/message-service-architecture.md)
- [Agent API 使用指南](./docs/huajune-agent-api-guide.md)
- [完整开发指南](./docs/DEVELOPMENT_GUIDE.md)

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
