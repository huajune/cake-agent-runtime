# 构建与部署指南

**最后更新**：2026-03-25

## 概述

代码合并到 `master` 分支后，GitHub Actions 自动完成以下流程：

```
push to master
  → test（类型检查 + 构建 + 单测）
  → deploy（SSH 到服务器 → git pull → docker build → 健康检查 → 失败自动回滚）
  → notify（飞书通知部署结果）
```

---

## CI 自动部署流程

### 触发条件

`push to master` 分支自动触发。

### 执行顺序

```
1. test
   ├── TypeScript 类型检查
   ├── NestJS 构建验证
   └── 单元测试

2. deploy（SSH 到生产服务器）
   ├── 备份当前镜像为 :previous
   ├── git fetch 拉取最新代码
   ├── docker build 构建新镜像
   ├── docker compose up -d 启动
   ├── 健康检查（60s，验证 status: "healthy"）
   ├── ✅ 成功 → 清理旧镜像
   └── ❌ 失败 → 自动回滚到 :previous

3. notify
   └── 飞书通知部署成功/失败
```

### 回滚机制

部署前自动备份当前镜像为 `cake-agent-runtime:previous`：
- **健康检查通过**：删除 `:previous`，清理无用镜像
- **健康检查失败**：自动将 `:previous` tag 回 `:latest` 并重启，恢复上一版本

手动回滚：

```bash
ssh haimian-deploy 'cd /data/cake && docker tag cake-agent-runtime:previous cake-agent-runtime:latest && docker compose up -d'
```

---

## 本地手动部署

适用于不走 CI、直接从本地触发部署的场景。

```bash
# 部署 master 分支
pnpm run deploy

# 部署指定分支
pnpm run deploy haimian-deploy develop
```

脚本流程与 CI 一致：SSH 到服务器 → git fetch → docker build → 启动 → 健康检查 → 失败回滚。

> 注意：部署的是服务器上 git 仓库的代码，请确保代码已 push 到远程。

---

## 服务器环境要求

服务器需要安装以下依赖：

| 依赖 | 用途 |
|------|------|
| Git | 拉取源码 |
| Docker + Docker Compose | 构建镜像和运行容器 |

> Node.js、pnpm 等构建工具**不需要**安装，全部在 Docker 多阶段构建内完成。

### 服务器目录结构

```
/data/cake/
├── source/              # 源码（git clone）
├── docker-compose.yml   # 容器编排配置
├── .env.prod            # 生产环境变量
└── logs/                # 应用日志（volume 挂载）
```

---

## 环境变量配置

```bash
cp .env.example .env.prod
# 编辑 .env.prod，填写必填项（Layer 1）
```

必填配置项：

| 变量 | 说明 | 来源 |
|------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | Anthropic |
| `AGENT_CHAT_MODEL` | 主聊天模型 ID | 环境配置 |
| `UPSTASH_REDIS_REST_URL` | Redis REST URL | Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST Token | Upstash |
| `DULIDAY_API_TOKEN` | 杜力岱 API Token | 内部系统 |
| `STRIDE_API_BASE_URL` | 托管平台 API | Stride |
| `FEISHU_ALERT_WEBHOOK_URL` | 飞书告警 Webhook | 飞书机器人 |
| `FEISHU_ALERT_SECRET` | 飞书签名密钥 | 飞书机器人 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥 | Supabase |

> 完整配置说明见 `.env.example` 内注释。

---

## 验证部署

```bash
# 查看容器状态
docker compose ps

# 健康检查
curl http://localhost:8585/agent/health
```

健康检查返回 `"status": "healthy"` 表示 Redis + Supabase 均正常。

---

## 排查问题

### 容器无法启动

```bash
# 查看日志
docker compose logs cake-agent

# 常见原因：.env.prod 缺少必填项
```

### 健康检查失败

```bash
# 服务启动约需 10-20s，稍等后重试
curl http://localhost:8585/agent/health

# 查看启动日志
docker compose logs --tail=50 cake-agent
```

### 构建失败

```bash
# SSH 到服务器手动构建查看详细错误
ssh haimian-deploy 'cd /data/cake && docker build -t cake-agent-runtime:latest ./source'
```

---

## 相关文档

- [版本发布指南](./version-release-guide.md) — 版本号规则和 CHANGELOG 自动生成
- [环境变量说明](../../.env.example) — 完整配置项列表
