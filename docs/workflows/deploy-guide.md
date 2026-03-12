# 构建与部署指南

**最后更新**：2026-03-12

## 概述

代码合并到 `master` 分支后，GitHub Actions 自动完成以下流程：

```
push to master
  → 构建 Docker 镜像 → 推送到 GHCR
  → 创建 GitHub Release（附 docker-compose.yml + .env.example）
```

对方收到 Release 附件后，按本文档执行部署。

---

## 对接方部署步骤

### 1. 获取部署文件

进入仓库 [Releases](../../releases) 页面，下载最新 Release 的附件：

- `docker-compose.yml` — 已包含正确的镜像地址，开箱即用
- `.env.example` — 环境变量配置模板

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写以下必填项（Layer 1）
```

必填配置项：

| 变量 | 说明 | 来源 |
|------|------|------|
| `AGENT_API_KEY` | AI Agent API 密钥 | 花卷平台 |
| `AGENT_API_BASE_URL` | AI Agent API 地址 | 花卷平台 |
| `UPSTASH_REDIS_REST_URL` | Redis REST URL | Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST Token | Upstash |
| `DULIDAY_API_TOKEN` | 杜力岱 API Token | 内部系统 |
| `STRIDE_API_BASE_URL` | 托管平台 API | Stride |
| `FEISHU_ALERT_WEBHOOK_URL` | 飞书告警 Webhook | 飞书机器人 |
| `FEISHU_ALERT_SECRET` | 飞书签名密钥 | 飞书机器人 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥 | Supabase |

> 完整配置说明见 `.env.example` 内注释。

### 3. 首次部署

```bash
# 确保 docker-compose.yml 和 .env 在同一目录
docker compose up -d
```

### 4. 验证

```bash
# 查看容器状态
docker compose ps

# 健康检查（等待约 30s）
curl http://localhost:8080/agent/health
```

---

## 更新部署（收到新版本）

```bash
# 拉取新镜像并重启
docker compose pull
docker compose up -d

# 清理旧镜像
docker image prune -f
```

> `docker-compose.yml` 中的镜像 tag 会随每次 Release 更新。如果使用 `latest` tag，`docker compose pull` 即可拉到最新版本。

---

## 镜像信息

镜像托管在 **GitHub Container Registry（GHCR）**：

```
ghcr.io/<org>/<repo>:latest         # 始终指向最新构建
ghcr.io/<org>/<repo>:sha-<7位hash>  # 特定版本（见 Release 说明）
```

### 登录 GHCR（拉取镜像前）

如果镜像仓库为私有，需要先登录：

```bash
# 用 GitHub Personal Access Token（需要 read:packages 权限）
echo <GITHUB_PAT> | docker login ghcr.io -u <GitHub用户名> --password-stdin
```

---

## CI 工作流说明

### 触发条件

`push to master` 分支自动触发。

### 执行顺序

```
build-and-push（并行）
  ├── 构建 Docker 镜像
  └── 推送到 ghcr.io（latest + sha-xxxxxxx 两个 tag）

create-release（依赖 build-and-push 完成）
  ├── 读取 package.json 版本号
  ├── 生成 docker-compose.yml（写入精确的 sha tag）
  └── 创建 GitHub Release，附上 docker-compose.yml 和 .env.example
```

### Release Tag 规则

```
v{package.json version}-{git sha 前7位}
示例：v1.2.3-a1b2c3d
```

---

## 排查问题

### 容器无法启动

```bash
# 查看日志
docker compose logs wecom-service

# 常见原因：.env 缺少必填项
```

### 健康检查失败

```bash
# 服务启动约需 10–20s，稍等后重试
curl http://localhost:8080/agent/health

# 查看启动日志
docker compose logs --tail=50 wecom-service
```

### 无法拉取镜像

```bash
# 确认已登录 GHCR
docker login ghcr.io

# 确认镜像地址正确（见 docker-compose.yml 中的 image 字段）
```

---

## 相关文档

- [版本发布指南](./version-release-guide.md) — 版本号规则和 CHANGELOG 自动生成
- [环境变量说明](../../.env.example) — 完整配置项列表
