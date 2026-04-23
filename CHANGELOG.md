# Changelog

所有重要的项目更改都将记录在此文件中。

本项目遵循 语义化版本 规范。
版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。
变更记录按 PR 驱动整理：更新摘要优先保留 PR 正文摘要 bullet，分类内容保留团队关心的业务/技术影响，不展开文件级流水账。

---

<!-- release:pending:start -->
## 待发布

**预计版本**: `v5.2.0`
**最近更新**: `2026-04-23`
**来源分支**: `develop`
**累计 PR**: 18

### 更新摘要
- PR #72 fix: 完善通知链路并修复群任务与消息处理后续问题
- PR #74 refactor: 重构可观测性与通知链路
- PR #76 refactor: 简化企微运行时处理并对齐 Sponge 合同
- PR #78 feat: 新增对话风险与入职交接监控
- PR #79 feat: 将风险干预改为 Agent 驱动
- PR #81 refactor: 统一记忆事实抽取并下线 LocationCityResolver
- PR #82 fix: 提升监控可见性与运行时配置一致性
- PR #84 feat: 强化监控统计投影与请求级可观测性
- PR #86 fix: 限制单轮同名工具调用并补齐处理链路追踪
- PR #87 chore: 批量整理运行时、工具描述与本地环境隔离
- PR #89 perf: 消除企微消息队列 Queue 与 PreDispatch 延迟
- PR #90 fix: 企微回调立即 ACK、队列/缓存降延与健康证修复
- PR #91 feat: 模型能力标签与发布时间展示
- PR #93 chore: changelog 脚本化
- PR #96 fix: 时段硬约束/开场问地址修复
- PR #98 feat: 飞书表切换 + 表情识别
- PR #99 chore: 统一 CHANGELOG 更新摘要规则，保留 `feat:` / `fix:` / `chore:` 等轻量类型前缀
- PR #99 feat: 新增部署完成后的飞书企微私域监控群通知脚本，并接入本地部署和 tag 部署 workflow
- PR #99 chore: 更新发布/部署文档与待发布状态，确保后续自动生成不会覆盖摘要类型信息
- PR #102 Added a WeCom short-term memory cutoff so a processing batch only reads chat history up to the latest message actually included in that batch.
- PR #102 Updated replay observability so merged replay inputs refresh trace content/source message IDs before the final Agent call.
- PR #102 Added empty-text recovery and persisted empty Agent telemetry before failure handling, so production incidents retain tool/step context.
- PR #102 Tightened candidate-consultation rules for meal objections, salary details, same-day interview precheck, booking promises, and current-focus job extraction.
- PR #102 Added labor-form normalization so generic "兼职/全职" does not become a misleading platform-level filter.

### 新功能
- PR #72 新增飞书通知路由，支持 bot 到接收人的映射。
- PR #78 新增对话风险监控、入职交接检测、`recruitment_cases` 持久化和 Web 手动恢复流程。
- PR #79 新增 `raise_risk_alert` / `request_handoff` Agent 工具，由模型同步触发暂停托管、飞书告警和 case 状态变更。
- PR #91 模型选择器展示能力标签、发布时间和多模态能力，便于配置时判断模型适用场景。
- PR #93 群任务招聘对象年龄改为读取岗位 `minAge/maxAge`，支持两端、单端和缺失回退。
- PR #93 test-suite 支持 `disableFallbacks=true`，避免指定模型评估被 fallback 链静默切走。
- PR #98 暂停托管新增 3 天自动解禁期限，包含定时清理和 lazy 清理。
- PR #98 表情消息复用 vision 识别管线，按消息类型区分图片与表情前缀。
- PR #98 replay 命中 `advance_stage` / `invite_to_group` / `duliday_interview_booking` 等不可逆工具时跳过重跑，避免副作用与回复丢弃冲突。
- PR #99 feat: 新增部署完成后的飞书企微私域监控群通知脚本，并接入本地部署和 tag 部署 workflow

### 问题修复
- PR #72 修复企业级群任务发送、后续 BI 查询、回复归一化与次要消息监控问题。
- PR #78 修复暂停用户后续消息不落库的问题，并从 active 入职 case 解析 `effectiveStage`。
- PR #82 托管开关、paused-user、群黑名单统一走 local hot cache -> Redis -> DB，修复多实例长期读取陈旧值。
- PR #86 对 `duliday_job_list` 增加同名工具调用上限、硬约束渲染和结果处理规则，降低循环查询与误用结果风险。
- PR #87 修复 hard-constraints 将“用工形式”错误引导到 `jobCategoryList` 的问题，改为查询后过滤。
- PR #89 将 Bull worker 并发与内部 semaphore 对齐，避免 handler 持有 lock 阻塞 delayed job 调度。
- PR #90 企微消息回调同步返回 200，消除托管平台因响应慢造成的重复补发。
- PR #90 修复健康证字段匹配、打招呼语误提取姓名、群任务静默失败和中文断句漏判。
- PR #96 将 `invite_to_group` 的 `already_in_group` 结果写入记忆，避免同会话反复调用慢接口。
- PR #96 修正 `stepDurationMs` 统计精度，避免 Anthropic 秒级时间戳造成排障误判。
- PR #98 修复 `invite_to_group` 记忆、MCP package exports 解析与相关 Agent 链路问题。
- PR #99 chore: 统一 CHANGELOG 更新摘要规则，保留 `feat:` / `fix:` / `chore:` 等轻量类型前缀

### 优化调整
- PR #74 抽取全局 `NotificationModule`，拆分告警、运维、私聊监控 channel 与卡片渲染。
- PR #74 接入 incident 上报、进程级异常监控和复用型 analytics helpers，统一监控与投递计算口径。
- PR #76 将企微消息运行时改为请求级模型，移除旧 `is_primary` 兼容语义，并简化为静默窗口触发。
- PR #81 将 `Preferences.city` 升级为带置信度和证据的 `CityFact`，统一地理映射与高置信事实抽取。
- PR #82 在入口与 merge 调度刷新 runtime config 快照，并扩展监控、tracking、analytics 与 Dashboard 展示。
- PR #84 新增日级统计投影和更丰富的小时聚合字段，区分静默窗口等待与真实队列等待。
- PR #84 将 message processing 详情改为保存真实 LLM 请求快照，提升请求回放和排障可见性。
- PR #86 为 message processing 增加结构化 tool calls、agent steps、memory snapshot、reasoning、usage 与 finishReason。
- PR #87 统一工具 DESCRIPTION 的“何时调用/何时不调用/参数/边界”结构，并精简 message filter 与 Redis key util。
- PR #89 将历史写入、source record 清理和配置读取从关键路径拆出，生产 queueDuration 从 36-89s 降至约 13s。
- PR #90 短期记忆缓存改为 INSERT-only 原子镜像，`updateMessageContent` 改为失效整 list 后按需 backfill。
- PR #90 在 Agent prompt 前置优先级栈和发送前自检，减少硬规则反复横跳。
- PR #93 重写 Changelog 生成链路，按 PR body 的中文/英文栏目和关键词分发到具体分类。
- PR #98 精简 recruitment-case 模块依赖，并适配 Feishu bitable 与 curated-dataset 重构后的测试。
- PR #102 Tightened candidate-consultation rules for meal objections, salary details, same-day interview precheck, booking promises, and current-focus job extraction.

### 运维与流程
- PR #74 `uncaughtException` 与 `unhandledRejection` 统一进入 incident pipeline。
- PR #78 新增 hourly stats 聚合修复与 `recruitment_cases` 数据库迁移。
- PR #84 新增 `monitoring_daily_stats`，将跨小时聚合中的唯一用户等指标改回精确查询或投影。
- PR #87 引入 `RUNTIME_ENV` 做 Redis/Bull key 隔离，避免本地环境误消费生产队列。
- PR #87 新增 `analyze-chat-badcases` 生产对话质量分析 skill，并同步文档与测试。
- PR #89 新增 `/message/queue-status` 运维端点，暴露 waiting/active/delayed/completed/failed/paused 队列计数。
- PR #93 合入告警持久化统一方案设计稿，并补齐版本脚本 dry-run 验证。
- PR #98 切换到新版飞书多维表格。
- PR #99 chore: 更新发布/部署文档与待发布状态，确保后续自动生成不会覆盖摘要类型信息
- PR #102 Added a WeCom short-term memory cutoff so a processing batch only reads chat history up to the latest message actually included in that batch.
- PR #102 Updated replay observability so merged replay inputs refresh trace content/source message IDs before the final Agent call.
- PR #102 Added empty-text recovery and persisted empty Agent telemetry before failure handling, so production incidents retain tool/step context.
- PR #102 Added labor-form normalization so generic "兼职/全职" does not become a misleading platform-level filter.

### 配置变更
- PR #76 调整企微 callback/runtime 相关配置类型与 UI 表达。
- PR #87 新增 `RUNTIME_ENV` 环境隔离约定。
- PR #89 将运行时配置快照 TTL 从 1s 调整为 30s。
- PR #98 移除 tsconfig MCP 路径别名，改用 package exports 解析。

### 验证记录
- PR #74 `pnpm run ci:check` 通过，覆盖 162 suites / 2148 tests。
- PR #78 `pnpm run ci:check` 通过，pre-push 全量 `jest --coverage` 通过，覆盖 182 suites / 2238 tests。
- PR #81 `pnpm run build` / `pnpm run lint` / `pnpm run test` 通过，覆盖 197 suites / 2317 tests。
- PR #82 `pnpm run ci:check` 与 pre-push 通过，覆盖 198 suites / 2283 tests。
- PR #86 `pnpm run build` / `pnpm run lint` / `pnpm run test` 通过，覆盖 2296 tests。
- PR #87 pre-push 通过，覆盖 2318 tests，并要求灰度验证 `jobCategoryList` 不再传入“兼职/全职”。
- PR #90 `pnpm run test` 通过 2420 tests，`tsc --noEmit` 0 errors，并补齐回调 ACK、健康证和 name-guard 回归测试。
- PR #93 `pnpm exec jest` 全量 207 suites / 2424 tests 通过，`pnpm run lint` + `pnpm run format` 通过。
- PR #96 本地 dev server 跑完 7 条 badcase scenario，人工核验 T1/T4/T6 通过，T2/T3/T7 待多轮 history 补充。
- PR #98 `pnpm run build` / `pnpm run lint` / `pnpm run test` 通过，覆盖 213 suites / 2441 tests，并列出飞书表、表情、托管到期与 replay 灰度项。
- PR #99 `node --check scripts/send-deploy-notification.js && node --check scripts/update-version-changelog.js && node --check scripts/get-release-notes.js`
- PR #99 `bash -n scripts/deploy-local.sh && bash -n scripts/deploy-remote.sh && git diff --check`
- PR #99 本地假 webhook 捕获部署通知 payload
- PR #99 pre-commit hook: `pnpm run lint` + `pnpm run format`
- PR #99 pre-push hook: `pnpm run ci:check`，213 suites / 2441 tests 通过
- PR #102 `pnpm jest tests/agent/agent.service.spec.ts tests/channels/wecom/message/application/reply-workflow.service.spec.ts tests/memory/short-term.service.spec.ts tests/memory/memory-lifecycle.service.spec.ts tests/agent/agent-preparation.service.spec.ts tests/agent/context/context.service.spec.ts tests/memory/session-extraction.prompt.spec.ts --runInBand --watchman=false`
- PR #102 `pnpm run typecheck`
- PR #102 `pnpm run lint:check`
- PR #102 `pnpm exec prettier --check ...`
- PR #102 Pre-push hook: `pnpm run ci:check` passed, including 214 Jest suites / 2449 tests.
<!-- release:pending:end -->

## [5.1.0] - 2026-04-09

**来源分支**: `develop`
**覆盖 PR**: `#59/#60/#63/#66/#70`

### 更新摘要
- PR #59 fix: 收紧运行时校验护栏
- PR #60 fix: 修复群任务静默拉群、真实成员检查与时段过滤
- PR #63 chore: 自动化受保护分支发布流程
- PR #66 feat: 面试预检 deadline 解析与岗位列表 prompt 引导
- PR #70 fix: 修复企微群消息发送失败与群任务模板

### 新功能
- PR #63 将版本与变更记录流程改为受保护分支友好的机器人元数据 PR 模式。
- PR #63 发布通知改为发送到消息通知群，使用中文卡片并 `@所有人`。
- PR #66 新增面试预检 deadline 解析，并增强岗位列表 prompt 引导。

### 问题修复
- PR #59 启用全局 `ValidationPipe`，补齐 debug 和 worker concurrency DTO，阻断非法输入进入核心链路。
- PR #59 将 LLM 评估改为 schema-driven structured output，校验 webhook、Redis session facts 和 Sponge API 响应。
- PR #60 拉群工具在城市无群时静默跳过，并以真实群成员缓存替代单次 API 调用去重。
- PR #60 抢单群按早/中/晚时段限定查询范围，避免多次推送重复的一周订单。
- PR #70 修复企业级群消息 `imBotId` 取错字段导致的静默失败，并检查 Stride API 业务状态码。

### 优化调整
- PR #60 群任务订单过滤按时段落地：上午仅今天、下午查明天、晚上查周末，保留手动触发兜底。
- PR #70 抢单群通知模板增加表情前缀，群成员服务、拉群工具与 GroupTaskPanel 样式同步精简。

### 运维与流程
- PR #63 发布工作流改为 `develop` 准备待发布信息、`master` 固化正式版本、tag 与 GitHub Release。
- PR #63 补充中文 PR 模板、版本说明脚本和发布流程文档。

### 配置变更
- PR #63 新增 `MESSAGE_NOTIFICATION_WEBHOOK_URL` 与 `MESSAGE_NOTIFICATION_WEBHOOK_SECRET` 发布通知配置。

### 验证记录
- PR #59 `jest` 指定回归集通过，`tsc -p tsconfig.json --noEmit` 通过。
- PR #60 拉群工具 11 条测试通过，抢单策略 6 条测试通过，`pnpm run build` 通过。
- PR #70 通过 Stride 企业级 API curl 和 `/group-task/test-send` 验证企微群消息可送达。

## [5.0.0] - 2026-04-08

**来源分支**: `develop`
**覆盖 PR**: `#52/#53/#55/#57`

### 更新摘要
- PR #52 feat: 策略配置版本化与环境隔离
- PR #53 feat: 拉人进群工具产品设计与基础依赖
- PR #55 chore: 通过 PR 同步 release 更新到 develop
- PR #57 chore: 同步 master 4.0.0 发布文件到 develop

### 新功能
- PR #52 将 Supabase 拆分为 prod/test 项目，策略配置新增 testing/released/archived 状态。
- PR #52 Web 编辑只影响 testing 版本，微信用户始终读取 released 版本，并新增 `publish_strategy` 原子发布 RPC。
- PR #52 策略页面新增发布按钮和版本状态栏，ChatTester 支持图片上传与图片描述工具。
- PR #53 新增拉人进群产品设计：按城市 + 行业匹配群，支持群满告警、负载均衡和防重复拉群策略。

### 问题修复
- PR #55 release sync 改为创建/更新 develop PR，避免受保护分支直推失败和 cherry-pick 冲突。

### 优化调整
- PR #53 为 ToolModule 补充 BizMessageModule 依赖，并将 ChatTester “清空”按钮改为“重置会话”。

### 运维与流程
- PR #55 release 同步仅限 `package.json` 与 `CHANGELOG.md`，降低版本文件分叉风险。
- PR #57 将 master 4.0.0 发布文件同步回 develop，解除后续 PR 冲突。

### 配置变更
- PR #52 新增策略配置状态、版本字段与发布 RPC 相关数据库迁移。

### 验证记录
- PR #52 本地验证策略页面加载 testing 版本，编辑后 ChatTester 使用新配置。
- PR #53 产品设计文档 review 通过，`pnpm run build` 通过。
- PR #55 校验 workflow YAML、`git diff --check`，并本地模拟 develop sync PR 创建路径。

## [4.0.0] - 2026-04-01

**来源分支**: `develop`
**覆盖 PR**: `#22/#24/#26/#27/#28/#30/#32/#34/#36/#38/#39/#42/#45/#50`

### 更新摘要
- PR #22 feat: 支持多消息类型并清理评估模块
- PR #24 chore: 自动部署与 Docker Web 构建
- PR #26 chore: 自动部署流水线与飞书通知
- PR #30 fix: 修复 Web 问题、增强健康检查并新增角色设置
- PR #34 refactor: 重构部署流水线并更新文档
- PR #38 feat: 智能推荐、地理编码与主动告知招聘要求
- PR #39 feat: 群任务定时通知自动化
- PR #50 chore: 稳定 release 与部署工作流

### 新功能
- PR #22 支持语音、表情、图片、小程序消息解析、过滤、展示与 vision 图片描述。
- PR #22 新增 `AGENT_EVALUATE_MODEL` 评估角色，评估模型不再占用主聊天模型。
- PR #24 Dockerfile 在后端构建前加入 Web 前端构建，部署产物包含 Dashboard。
- PR #26 部署成功/失败发送飞书卡片通知，包含项目、分支、提交信息。
- PR #30 新增 Redis/Supabase 真实健康检查、`role_setting` 全栈 CRUD、worker 队列状态卡片和 Dashboard 增强。
- PR #38 新增 geocode 工具，支持地址解析、行政区划、经纬度、按距离排序和过滤岗位。
- PR #38 首次推荐岗位时主动展示招聘硬性条件，避免推岗后逐项追问。
- PR #39 新增群任务定时通知系统：Cron 调度、群解析、AI/模板生成、企微群发送、飞书报告。
- PR #39 Dashboard 新增 GroupTaskPanel，支持开关控制、试运行模式和手动触发。

### 问题修复
- PR #27 与 PR #28 解决 master/develop 冲突，移除重复 evaluation 文件和孤立测试。
- PR #30 修复聊天记录日期范围、agent-test 草稿持久化和 stuck `processing` 记录恢复问题。
- PR #32 修复部署 SSH passphrase 与 notify job 被 production environment 保护规则阻塞的问题。
- PR #36 简化 Dockerfile 为 3 stages，并使用 `pnpm prune --prod` 降低镜像风险。
- PR #38 修复 vision 模型连接超时和 version-changelog workflow 相关问题。
- PR #42 转义 docker-compose healthcheck 中的 `$`，修复部署插值失败。

### 优化调整
- PR #30 移除类型 hack，补充接口输入校验，抽取业务指标类型并修复 AI SDK 类型转换。
- PR #34 部署从 GHCR 大镜像传输改为服务器 git fetch + docker build，并新增健康检查失败自动回滚。
- PR #34 精简 package scripts、统一默认端口到 8585，并重写部署文档。
- PR #39 修复群任务配置默认值双源头、dryRun 竞态和表单状态丢失。
- PR #50 统一本地与 CI 部署的 immutable image tag 和远端回滚逻辑。

### 运维与流程
- PR #24 新增 SSH 自动部署 job。
- PR #26 合并到 develop 后通过 release PR 触发 master 部署。
- PR #34 部署流水线简化为 test -> deploy -> notify。
- PR #45 version-changelog workflow 更新版本后自动同步 `package.json` 与 `CHANGELOG.md` 到 develop。
- PR #50 发布流程改为 master bump、tag-driven deployments，并将 release commit 同步回 develop。

### 配置变更
- PR #26 docker-compose 模板 `env_file` 改为 `.env.prod`。
- PR #32 新增 `DEPLOY_SSH_PASSPHRASE` 与 `FEISHU_DEPLOY_WEBHOOK_URL` 配置要求。
- PR #34 全局端口从 8080 统一为 8585。
- PR #38 部署配置统一 `.env.prod`，vision 模型切换为 `qwen/qwen-vl-plus`。

### 验证记录
- PR #24 验证 Docker 镜像包含 Web 前端并可触发部署。
- PR #28 112 suites / 1830 tests 通过，CI 通过。
- PR #30 `npx tsc --noEmit` 无类型错误，核心 controller/parser specs 通过。
- PR #34 `bash -n` 校验部署脚本，`docker compose config` 通过。
- PR #39 群任务产品文档、测试套件指南与相关回归测试同步更新。
- PR #50 `pnpm run build:web`、部署脚本语法检查、workflow YAML 解析和 `git diff --check` 通过。

## [2.0.0] - 2026-03-23

**来源分支**: `develop`
**覆盖 PR**: `#15/#16/#18/#19/#20/#21`

### 更新摘要
- PR #15 chore: 禁止直接推送 develop 分支
- PR #16 chore: 触发 AI Review 流程测试
- PR #18 chore: 接入 huajune agent integration 基础分支
- PR #19 chore: 同步 AI Code Review workflow 到 develop
- PR #20 feat: 发布 Cake Agent Runtime v2.0 自主 Agent 架构
- PR #21 chore: 更新部署容器名并移除旧 PR 模板

### 新功能
- PR #20 从花卷 API 代理层演进为 Cake Agent Runtime，自主编排 Recall -> Compose -> Execute -> Store。
- PR #20 引入多模型 Provider、动态 Context Section、工具系统、四层记忆、五阶段候选人咨询策略和 Dashboard。

### 问题修复
- 无

### 优化调整
- PR #18 作为自主 Agent 架构切换前置整合分支，为 v2.0 合并做基础准备。
- PR #19 将 AI Review 规则从内联 YAML 外置到 `.github/review-rules.md`，并移除旧 inline comment 工具。

### 运维与流程
- PR #15 Husky 阻止直接推送 develop，推动通过 PR 合并。
- PR #16 验证 AI Review 触发链路。
- PR #21 部署容器名从 `wecom-service` 改为 `cake-agent`，并清理旧 PR 模板。

### 配置变更
- 无

### 验证记录
- PR #19 验证 ai-code-review workflow 合并后可运行。
- PR #20 本地构建通过、1948 tests 通过、CI Checks 通过，生产部署验证待执行。
