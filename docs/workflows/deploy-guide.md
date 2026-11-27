# 构建与部署指南

**最后更新**：2026-04-23

## 概述

项目提供两种部署方式：CI/CD 自动部署和本地手动部署。两者都遵循相同的核心流程：构建镜像 → 启动容器 → 健康检查 → 失败回滚。

---

## 核心概念

### 镜像构建（Dockerfile）

Dockerfile 把源代码打包成可运行的镜像，分三个阶段：

```
阶段 1: deps（装依赖）
  └─ 安装 pnpm → 复制 package.json → pnpm install

阶段 2: builder（编译）
  └─ 复制源代码 → 编译前端(build:web) → 编译后端(build) → 删掉 devDependencies

阶段 3: runner（最终镜像，只保留运行需要的东西）
  └─ 复制 dist/ + node_modules/ + package.json → node dist/main 启动
```

最终镜像里没有源代码，只有编译产物，体积小、安全。

### 容器编排（docker-compose.yml）

`docker-compose.yml` 告诉 Docker 怎么启动镜像：端口映射、环境变量、日志挂载、健康检查等。一条 `docker compose up -d` 搞定。

### 两者的关系

```
Dockerfile 构建镜像            docker-compose.yml 启动容器
源代码 → docker build → 镜像 → docker compose up → 运行中的容器
                                  ↑ 在这里指定端口、环境变量、日志等
```

容器启动时需要 `.env.production`，而镜像构建阶段也会从中读取前端构建必需的变量（如 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`）并注入到 `docker build`。

---

## 服务器目录结构

```
/data/cake/
├── .env.production        ← 环境变量（密钥等，手动维护，不在 Git 里）
├── docker-compose.yml     ← 容器启动配置（部署时自动从代码同步）
├── logs/                  ← 容器运行日志（volume 映射出来的）
└── source/                ← CI/CD 拉取的代码（仅用来构建镜像）
    ├── src/
    ├── Dockerfile
    ├── docker-compose.yml ← 代码中的版本（部署时复制到上层目录）
    └── ...
```

> `docker-compose.yml` 以代码仓库为唯一真相源，两种部署方式都会自动将代码中的版本同步到 `/data/cake/`。

---

## CI/CD 自动部署

### 触发条件

`v*` 版本 tag 自动触发。通常由 `master` 合并后的自动版本流程创建。

### 完整流程

```
GitHub Actions                        远程服务器 /data/cake/
──────────────                        ──────────────────────
1. release tag 触发 test（类型检查 + 编译 + 单测）
2. SSH 连到服务器 ──────────────────→  3. 拉取对应 tag 的代码到 source/
                                       4. docker build ./source → 生成版本镜像
                                       5. docker compose up -d 启动容器
                                       6. 健康检查（60s 内轮询 /agent/health）
                                       7. 成功 → 保留该版本为当前版本
                                          失败 → 自动回滚到上一版本
3. 飞书企微私域监控群通知部署结果
```

11 月 26 日，Supabase 测试项目已验过聊天、消息流水及两类快照的归属、托管开关和租户查询。4 个虚拟员工完成手机号和密码实登，核对了租户范围、重置和停用。外部供应商启用海绵等业务能力时另行验收对应路由。[租户隔离与登录验收](../product/organization-members-and-business-accounts.md#实现与上线边界)

在授权的发布窗口内，先核对目标项目引用、自助注册已关闭（`disable_signup=true`）、Email 已启用。通过 `PATCH /v1/projects/{ref}/config/auth` 单独提交 `{"external_phone_enabled":true}`。回读目标项目的 `/auth/v1/settings`，核对 `external.phone=true`、`external.email=true`、`disable_signup=true`。总部开户时逐个确认已核实的手机号，员工登录走密码校验，整个流程无需配置短信服务。[Supabase Auth 配置接口](https://supabase.com/docs/reference/api/v1-update-auth-service-config)

v11.22.1 已先行应用日期较晚的消息存储迁移。11 月 27 日只读核对时，测试库已执行本 PR 的 23 份迁移，生产库待执行 23 份。消息快照归属迁移之后还有 4 份，分别支持删除空组织、停用与恢复登录、注销与重新开户、查询当前会话权限。最后一份为 `20261127103000_current_dashboard_account.sql`。发布窗口使用 `pnpm exec supabase db push --db-url "$SUPABASE_DB_URL_PROD" --include-all --dry-run` 对照实际待执行清单。如有额外迁移，先核对所属版本，再执行已核实的清单。

验收通过后的发布窗口内，发布人应用相应迁移、启用 Supabase Email 和 Phone 密码认证并关闭自助注册，将本机私有的开户名单、员工和管理员的初始密码文件交到服务器。部署脚本在旧服务运行时核对名单并登记 Stride 托管归属，等旧服务处理完登记前的待回复消息再切换。登记失败或等待超时会保留旧服务。新服务通过健康检查后先开通专用管理员 `cakeadmin`，再为已有手机号的员工开户。中途失败可用同一批文件重试，总部核对实际开户结果后按清单交付。详细步骤见[全员账号开通说明](../../src/biz/center-dashboard/README.md#随正式发布初始化全员账号)。

### 主聊并发首档

包含 #1589 的首个正式发布通过容器健康检查后，发布任务在新容器内调用 `POST /message/worker-concurrency`，设置 `{"concurrency":50}`。随后轮询 `GET /message/worker-status`，核对 `maxConcurrency=100`、`concurrency=50`、`registeredConcurrency=50`。最后在部署主机写入 `/data/cake/.rollout-message-worker-50`。后续发版见到此标记就沿用管理员后来保存的值。[发布工作流](../../.github/workflows/deploy.yml) · [首档核验脚本](../../scripts/rollout-message-worker-50.cjs)

若核验超过五分钟，发布任务会报告当时的注册数和在途数，容器继续处理已领取的任务。可在后台查看实际注册数和队列等待量，或重试核验。首次生产切换若采用手动部署，在部署主机使用与镜像相同版本的脚本执行同一步。以下命令适用于脚本已在 `source/` 的部署目录。[后台状态字段](../architecture/message-service-architecture.md#42-worker-并发)

```sh
cd /data/cake
if [ ! -f .rollout-message-worker-50 ]; then
  docker exec -i cake-agent node - < source/scripts/rollout-message-worker-50.cjs && touch .rollout-message-worker-50
fi
```

---

## 本地手动部署

适用于不走 CI、直接从本地触发部署的场景（开发调试、紧急修复）。

```bash
pnpm run deploy              # 部署到默认服务器（haimian-deploy）
pnpm run deploy other-host   # 部署到指定服务器
```

### 完整流程

```
你的 Mac                              远程服务器 /data/cake/
─────────                             ──────────────────────
1. 预检（类型检查 + 编译 + 测试）
2. docker build → 在本地生成镜像
3. docker save → 导出 .tar 文件
4. scp 上传 .tar + docker-compose.yml ──→  收到文件
                                       5. 备份当前发布配置和镜像 tag
                                       6. docker load 加载新镜像
                                       7. docker compose up -d 启动容器
                                       8. 健康检查（60s 内轮询 /agent/health）
                                       9. 成功 → 保留新版本并通知飞书企微私域监控群
                                          失败 → 自动回滚到上一版本并通知飞书企微私域监控群
```

### 两种方式对比

| | 本地部署 | CI/CD |
|---|---|---|
| 镜像在哪构建 | 你的 Mac | 服务器上 |
| 代码怎么传 | 只传镜像（.tar） | 服务器 git pull |
| 触发方式 | 手动 `pnpm run deploy` | push `v*` tag 自动触发 |
| 适用场景 | 开发调试、紧急修复 | 正式发布 |

---

## 回滚机制

消息存储与普通回复这批发布会迁表和删列。镜像备份只覆盖应用。维护窗口内还需保留相应的数据库备份，并在恢复流量前核对备份时点之后已发生的外部派发。[联合迁移的验收与回滚](../technical/runtime-storage-batch.md#验收与回滚)

部署前会自动备份：
- 当前 `docker-compose.yml`
- 当前 `.deploy.env`
- 当前运行中的镜像 tag（临时标记为 `cake-agent-runtime:rollback`）

如果健康检查失败，部署脚本会自动恢复上一版本的配置和镜像 tag，并重新执行 `docker compose up -d`。

手动回滚：

```bash
ssh haimian-deploy 'cd /data/cake && printf "IMAGE_TAG=rollback\n" > .deploy.env && docker compose --env-file .deploy.env up -d --force-recreate'
```

---

## 环境变量配置

服务器上的 `.env.production` 需要手动维护（包含密钥，不提交 Git）。

首次部署时创建：

```bash
ssh haimian-deploy
cd /data/cake
nano .env.production
# 参考 .env.example 填写
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
| `PRIVATE_CHAT_MONITOR_WEBHOOK_URL` | 发版通知 Webhook | 飞书企微私域监控群机器人 |
| `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET` | 发版通知签名密钥 | 飞书企微私域监控群机器人 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL | Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 前端匿名密钥 | Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 密钥 | Supabase |

> 完整配置说明见 `.env.example` 内注释。

CI/CD 自动部署需要在 GitHub Secrets 中配置 `PRIVATE_CHAT_MONITOR_WEBHOOK_URL` / `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET`。本地 `pnpm run deploy` 会优先读取当前 shell 环境变量，其次读取 `.env.production` 中的同名配置。

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

# 常见原因：.env.production 缺少必填项
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
ssh haimian-deploy 'cd /data/cake && docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$(sed -n "s/^NEXT_PUBLIC_SUPABASE_URL=//p" .env.production | head -n1)" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$(sed -n "s/^NEXT_PUBLIC_SUPABASE_ANON_KEY=//p" .env.production | head -n1)" \
  -t cake-agent-runtime:latest ./source'
```

---

## 服务器环境要求

| 依赖 | 用途 |
|------|------|
| Git | 拉取源码 |
| Docker + Docker Compose | 构建镜像和运行容器 |

> Node.js、pnpm 等构建工具**不需要**安装，全部在 Docker 多阶段构建内完成。

---

## 相关文档

- [版本发布指南](./version-release-guide.md) — 版本号规则和 CHANGELOG 自动生成
- [环境变量说明](../../.env.example) — 完整配置项列表
