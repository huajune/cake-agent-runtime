# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cake Agent Runtime — DuLiDay（独立客）旗下的招聘专用 AI Agent 运行时，通过企业微信渠道为餐饮连锁企业提供智能招聘对话服务。后端 NestJS，前端 `web/`（React 18 + Vite 的运营 Dashboard），随主服务一起构建部署。

**Tech Stack**: NestJS 10.3 | TypeScript 5.3 | Node.js 20+ | Vercel AI SDK | Supabase (Postgres) | Upstash Redis | Bull Queue | React 18 + Vite (web/)

## Development Commands

```bash
pnpm run install:all       # 安装根 + web 依赖
pnpm run start:dev         # 开发（先 build web，再 nest --watch）
pnpm run web:dev           # 仅前端 Dashboard 热更新
pnpm run build             # 构建后端；build:ci 含 web + 占位 token

# 质量检查（CI 跑的是 ci:check 全家桶）
pnpm run lint:check        # ESLint（--max-warnings=0）
pnpm run typecheck         # tsc --noEmit
pnpm run test              # Jest；tests/ 目录镜像 src/ 结构

# 单测文件
pnpm run test -- tests/agent/runner/agent-runner.service.spec.ts --watchman=false
```

⚠️ **跑测试的坑**：shell 默认 node 可能是 16（先 `node -v` 确认），本项目要求 Node 20+，实践用 `nvm use 22.16.0`；jest 不加 `--watchman=false` 会静默 0 测试无输出。

⚠️ 本地无 Redis 时设 `ENABLE_BULL_QUEUE=false`（.env.local）。

### Database Migrations（Supabase CLI，测试/生产隔离）

```bash
pnpm run db:new <name>       # 新建迁移（supabase/migrations/YYYYMMDDHHMMSS_*.sql）
pnpm run db:push:test        # 应用到 TEST（gaovfitvetoojkvtalxy）
pnpm run db:push:prod        # 应用到 PROD（uvmbxcilpteaiizplcyp）
pnpm run db:status:test      # / db:status:prod 查看迁移状态
```

**流程：先测试后生产**。SQL 用 `IF NOT EXISTS` / `ON CONFLICT` 保证幂等；但**修改既有索引/函数定义时不要依赖 IF NOT EXISTS**（只查名字不查定义，会静默跳过），用 `DROP IF EXISTS + CREATE`。**生产 push 必须与代码发版同步**——只发代码不推迁移（或反之）是本仓库反复出现过的事故源。上线新表后用一条真实写入验证落库，别只看部署成功。

## Architecture

### Layering Rule

依赖业务数据（用户、消息等）→ `biz/`；可独立于业务存在 → `infra/`。
**`infra/` 禁止 import `biz/`、`channels/`、`agent/`。**
**`resolution/` 只依赖 `sponge/`**（可被 memory/agent/tools/guardrail 依赖，禁止反向 import）。

```
src/
├── infra/              # 基础设施：config / redis / supabase / feishu / alert / http / server-response
├── providers/          # 多模型三层：registry(注册) → reliable(重试/降级) → router(角色路由)
├── llm/                # LLM 执行器（llm-executor：底层 generateText 封装、重试）
├── resolution/brand/   # 品牌解析域（唯一居所）：目录索引/匹配/极性/品类展开/状态 reducer/同音回指/公司名规范化
│                       #   纯确定性代码零 LLM；resolve() 输出标准品牌+极性+置信度；只依赖 sponge 品牌目录
├── tools/              # Agent 工具（duliday 岗位/约面/改约/取消、拉群、handoff、召回历史等）+ tool-registry
├── memory/             # 四层记忆：short-term(对话窗口) / session(会话事实) / procedural(阶段) / long-term(画像)
│                       #   + settlement(空闲沉淀) / facts(规则提取) / stores(Redis+Supabase 适配)
├── agent/              # Agent 编排
│   ├── runner/         #   回合入口 agent-runner + turn-finalizer(统一副作用出口) + reply-rewrite
│   ├── generator/      #   preparation(召回/上下文准备) + generator(LLM 调用) + context/(Prompt Section 体系)
│   ├── guardrail/      #   input(注入/风险拦截) / output(hard-rules + llm-reviewer + sanitizer) / tool(catalog)
│   └── reengagement/   #   二次触发：anchor → follow-up-scheduler → processor → proactive-composer
├── observability/      # AsyncLocalStorage 请求上下文 + AgentTracer → CompositeObserver
│                       #   → PersistingObserver 落 agent_execution_events（与 message_processing_records 同 traceId 可 join）
├── mcp/                # MCP 客户端（动态工具扩展）
├── sponge/             # 海绵（外部岗位/工单数据服务）
├── analytics/          # 指标/趋势/规则计算
├── notification/       # 告警通知（渠道 + 渲染器）
├── evaluation/         # LLM 评分的对话质量评估
├── biz/                # 业务域：monitoring(观测落库+查询) / hosting-config / strategy(persona+红线+阶段目标)
│                       #   user / message / ops-events / conversion-analytics / candidate-blacklist
│                       #   group-task / handoff-events / intervention / test-suite / feishu-sync / huajune
├── channels/wecom/     # 企微渠道
│   └── message/        #   ingress(回调入口) → application(过滤/管道/回复工作流) → runtime(去重/debounce 合并)
│                       #   → delivery(拟人化投递) + telemetry(观测采集)
├── skills/             # Claude Code skills（analyze-chat-badcases，软链进 .claude/skills）
└── enums/ types/       # 共享枚举与类型

web/                    # React Dashboard（视图：dashboard / message-processing / reengagement / test-suite /
                        #   conversion-analysis / strategy / hosting / users / chat-records / system 等）
supabase/migrations/    # 120+ 迁移；baseline 是 20260310000000
```

### Message Flow

```
企微用户消息 → 托管平台回调 POST /message (ingress，@Public 放行)
  → application：接收 → 过滤规则 → 存历史 → 立即返回 200
  → runtime：每条消息注册 delay=静默窗口 的 Bull job（debounce），
             Worker 触发时距最后一条消息静默足够久才处理（simple-merge，90s 租约锁+心跳续期）
  → agent/runner：runTurn（记忆召回 → prompt 组装 → 多步工具调用 → 出站守卫审查 → turn-finalizer 沉淀副作用）
  → delivery：分段（\n\n + ~）+ 打字延迟拟人化发送
```

出站守卫（output guardrail）三档：确定性 hard-rules → LLM 语义审查（shadow/enforce 由 `system_config.agent_reply_config` 控制）→ sanitizer；审查全程档案落 `guardrail_review_records`。

复聊（reengagement）是独立链路：**不复用主 generator**，走 ProactiveComposer（事实齐全场景用确定性模板，话术场景用一次性 completion 调用），全生命周期落 `reengagement_touch_records`。

### Path Aliases (tsconfig.json)

`@infra/* @agent/* @channels/* @wecom/* @biz/* @providers/* @tools/* @memory/* @mcp/* @sponge/* @resolution/* @observability/* @notification/* @analytics/* @enums/* @evaluation/* @test-suite/* @shared-types/*`

## Configuration

三层配置，完整清单见 `.env.example`；本地开发 `cp .env.example .env.local`。

1. **必填环境变量**（密钥/URL，无默认值）：各厂商 API key（`ANTHROPIC_API_KEY` 等）、角色路由模型 `AGENT_CHAT_MODEL` / `AGENT_EXTRACT_MODEL` / `AGENT_VISION_MODEL` / `AGENT_EVALUATE_MODEL`、`API_GUARD_TOKEN`（全局 ApiTokenGuard，`@Public()` 装饰器放行）、Upstash Redis、`DULIDAY_API_TOKEN`、Stride 托管平台、飞书告警/多维表格、Supabase URL + `SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_DB_URL_TEST/PROD`（迁移用）。
2. **可选环境变量**（代码有默认值）：`PORT`(8585)、消息历史上限/TTL、打字延迟等。
3. **托管配置（DB 动态）**：消息聚合窗口 `initialMergeWindowMs` 等在 `hosting_config` 表，Dashboard 可改，不走环境变量；守卫开关在 `system_config`。

⚠️ `.env.local`（本地，Supabase 指 TEST 库）与 `.env.production`（生产镜像，Supabase 指 PROD 库）键名一致但**数据源不同，不可无脑同步**；跑读写生产的一次性脚本必须用 `.env.production`。

## Code Standards

- TypeScript 严格模式：禁 `any`（不确定用 `unknown` + 收窄）；禁 `console.log`（用 NestJS `Logger`）；禁手动 `new Service()`（走 DI）；禁硬编码密钥（走 ConfigService）。
- Service 结构顺序：logger → config 属性 → constructor(DI) → public 方法 → private helpers；单一职责，超过 ~500 行考虑拆分。
- 命名：文件 kebab-case；类/接口 PascalCase；变量/函数 camelCase；常量 UPPER_SNAKE_CASE。
- 完整错误处理；统一响应由 ResponseInterceptor / HttpExceptionFilter 处理，第三方回调用 `@RawResponse` 绕过包装。

## Git & Release Convention

> **分支约定**：默认分支 `develop`，长期主线 `master`，**不存在 `main`**。PR 一律目标 `develop`；`develop` → `master` 走 release 流程。CLI 提示的 "Main branch: main" 不准确，以本说明为准。

Conventional Commits + 标准 semver：`feat:` → minor，`fix:`/其余 → patch。develop 合入 master 后 GitHub Actions 自动更新版本、生成 CHANGELOG、打 tag。发版链路有多个 bot PR（元数据/发布/固化/回同步），配置了 `RELEASE_BOT_TOKEN` 自动放行；**回同步 PR 必须 merge commit（勿 squash）**，否则下轮 release 必冲突。

仓库常有多个 AI 会话并发改码：**commit 时用 pathspec 限定自己的文件**；发现 stash / 工作树有他人改动勿动，先确认。

## Testing & Debugging

```bash
curl http://localhost:8585/agent/health       # 健康检查（已注册 Provider）
curl http://localhost:8585/agent/models       # 可用模型
curl -X POST http://localhost:8585/agent/debug-chat \
  -H "Content-Type: application/json" -H "Authorization: Bearer $API_GUARD_TOKEN" \
  -d '{"message":"你好","conversationId":"debug-001"}'

tail -f logs/combined-$(date +%Y-%m-%d).log   # 日志
```

排障数据都在 Supabase：回合流水 `message_processing_records`（完整 prompt 在 `agent_invocation.request.agentRequest`）、执行事件 `agent_execution_events`、守卫档案 `guardrail_review_records`、复聊触达 `reengagement_touch_records`——同 `trace_id` 可互相 join。Dashboard 前端即 `web/`。

## Advanced Documentation

- **[.claude/agents/README.md](./.claude/agents/README.md)** — 规范文档中心：code-standards / architecture-principles / frontend-standards / commit-guidelines / documentation-standards / code-quality-guardian
- **docs/** — 架构（architecture/）、产品方案（product/）、数据库（db/）、技术调研（technical/）
- **src/memory/README.md**、**src/agent/guardrail/tool/README.md** — 子系统内文档
