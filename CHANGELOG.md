# Changelog

所有重要的项目更改都将记录在此文件中。

本项目遵循 语义化版本 规范。
版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。
变更记录按 PR 驱动整理：自动清理 PR/commit 前缀与常见英文工程表述，尽量产出可直接用于发布通知的中文摘要。

---

## [5.6.0] - 2026-04-30

**来源分支**: `develop`

### 更新摘要
- PR #154 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答，改异步通知运营接手
- PR #154 岗位推荐主动告知具体工作班次：早班/午高峰短班/晚班 + 工时长度 + 工作日，减少候选人入职后发现时段冲突
- PR #154 候选人时段硬筛：候选人声明只能特定时段（如只做晚班）后，召回阶段即过滤掉不匹配岗位，不再推无效岗位
- PR #154 健康证不再阻塞面试：默认"先来面试，录用后再去办"，约面前不主动追问；仅当岗位明确要求"持证才能预约"时才前置确认
- PR #154 发薪/工资问题严禁甩锅：不再允许"到店问/面试时问/店长确认"等敷衍话术
- PR #154 结伴求职分流：两人一起求职、当前门店名额不足时，主动推荐就近同行业门店，避免一人空手
- PR #154 干扰信号下流程仍稳：候选人发"日期已过/改约"等话术时仍照常进入面试预约校验
- PR #154 招聘红线体系精简：从 29 条整合到 13 条，规则更清晰、Agent 更少误触发
- PR #157 把 master（已固化的 v5.5.0）合并回 develop，解除 PR #156（v5.6.0 发版）的冲突
- PR #157 趁机重写 v5.6.0 的 `pending-release.json` + `CHANGELOG.md` 待发布块，按业务视角组织摘要
- PR #159 **结构**：原 \`**本次更新**\` 单列表 → 拆成两段
- PR #159 **业务改动（候选人/运营可感知）**：来源 CHANGELOG \`### 新功能\` + \`### 问题修复\`
- PR #159 **优化与运维（非业务感知）**：来源 CHANGELOG \`### 优化调整\` + \`### 运维与流程\`
- PR #159 **颜色**：success 卡片主色调 \`turquoise\`（青绿）→ \`violet\`（紫）
- PR #159 **兼容**：当结构化段落都为空时，回退到原 \`**本次更新**\` 单列表（保留 v5.5.0 之前老 release 的兼容路径）

### 新功能
- PR #154 人工介入更顺畅：候选人发"转人工"后 Agent 立即停止抢答，改异步通知运营接手
- PR #154 岗位推荐主动告知具体工作班次（早班/午高峰短班/晚班 + 工时长度 + 工作日）
- PR #154 候选人时段硬筛：声明只能特定时段后，召回阶段即过滤掉不匹配岗位
- PR #154 结伴求职分流：当前门店名额不足时，主动推荐就近同行业门店
- PR #159 **结构**：原 \`**本次更新**\` 单列表 → 拆成两段
- PR #159 **颜色**：success 卡片主色调 \`turquoise\`（青绿）→ \`violet\`（紫）

### 问题修复
- PR #154 健康证不再阻塞面试：默认"先来面试，录用后再去办"，约面前不主动追问
- PR #154 发薪/工资问题严禁甩锅：不再允许"到店问/面试时问/店长确认"等敷衍话术
- PR #154 干扰信号下流程仍稳：候选人发"日期已过/改约"时仍照常进入面试预约校验
- PR #159 **业务改动（候选人/运营可感知）**：来源 CHANGELOG \`### 新功能\` + \`### 问题修复\`

### 优化调整
- PR #154 招聘红线体系精简：从 29 条整合到 13 条，prompt 强化"如实呈现/班次时间"
- PR #154 投递层兜底回退：移除发薪甩锅 / 同品牌压缩等静默拦截，投递层只拦内部实现泄漏
- PR #154 班次时间逻辑下沉到工具内部（format-shift-time.util），数据缺失返 null 不补 fallback
- PR #154 死代码清理：未生效 phrase guard / 推断字段 / 监控计数器全部清理
- PR #157 把 master（已固化的 v5.5.0）合并回 develop，解除 PR #156（v5.6.0 发版）的冲突
- PR #159 **优化与运维（非业务感知）**：来源 CHANGELOG \`### 优化调整\` + \`### 运维与流程\`

### 运维与流程
- PR #154 飞书 BadCase 状态双向回写脚本（priority + status 同步）
- PR #154 prod 历史漂移规则回填，test/prod rule_count 对齐
- PR #157 趁机重写 v5.6.0 的 `pending-release.json` + `CHANGELOG.md` 待发布块，按业务视角组织摘要
- PR #159 **兼容**：当结构化段落都为空时，回退到原 \`**本次更新**\` 单列表（保留 v5.5.0 之前老 release 的兼容路径）

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #154 单测全绿：227 套件 / 2719 测试通过
- PR #154 lint + tsc 干净
- PR #154 DB 迁移已 apply test+prod，rule_count 一致
- PR #154 投递层兜底回退后 phrase guard 死代码全部清理
- PR #157 `node -e 'JSON.parse(...)'` 校验 `.release/pending-release.json` 合法
- PR #157 grep 确认无遗留冲突标记
- PR #157 Pre-push hook（lint + format + typecheck + build + jest --coverage）已通过
- PR #157 合并本 PR 后 PR #156 状态变为 MERGEABLE
- PR #159 新增测试：\`renders two-section update when structured release notes are available\`
- PR #159 现有测试：color 期望从 turquoise 改为 violet
- PR #159 现有测试：单列表 fallback（仅 \`### 更新摘要\`）仍走 \`**本次更新**\` 路径
- PR #159 \`pnpm jest tests/scripts/send-deploy-notification.spec.ts\` 全绿（5/5）
- PR #159 Pre-push hook 通过：228 套件 / 2749 测试

## [5.5.0] - 2026-04-29

**来源分支**: `develop`

### 更新摘要
- PR #148 Add badcase traceability and memory fixture support across test-suite imports, execution records, conversation snapshots, and Feishu payload handling.
- PR #148 Add Supabase migrations, backfill/check tooling, and workflow documentation for trace-memory evaluation.
- PR #148 Extend dashboard/business trend RPC support, release/deploy notification formatting, and related frontend test-suite/feedback views.
- PR #148 Tighten prompt, memory, and tool behavior used by candidate consultation badcase validation.
- PR #151 master 已固化 v5.4.0：`.release/pending-release.json` 清空 entries，`CHANGELOG.md` 把 `<!-- release:pending -->` 块替换为 `[5.4.0]` 段
- PR #151 develop 已写入 v5.5.0 待发布数据（来自 PR #148）
- PR #151 `.release/pending-release.json` 取 develop 版本（`baseVersion 5.4.0` / `nextVersion 5.5.0` / 含 #148 entry）
- PR #151 `CHANGELOG.md` 取 develop 版本（保留 v5.5.0 待发布块；`[5.4.0]` 等历史段两边一致）

### 新功能
- PR #148 Add badcase traceability and memory fixture support across test-suite imports, execution records, conversation snapshots, and Feishu payload handling.
- PR #148 Extend dashboard/business trend RPC support, release/deploy notification formatting, and related frontend test-suite/feedback views.
- PR #148 Tighten prompt, memory, and tool behavior used by candidate consultation badcase validation.

### 问题修复
- 无

### 优化调整
- 无

### 运维与流程
- PR #148 Add Supabase migrations, backfill/check tooling, and workflow documentation for trace-memory evaluation.
- PR #151 master 已固化 v5.4.0：`.release/pending-release.json` 清空 entries，`CHANGELOG.md` 把 `<!-- release:pending -->` 块替换为 `[5.4.0]` 段
- PR #151 develop 已写入 v5.5.0 待发布数据（来自 PR #148）
- PR #151 `.release/pending-release.json` 取 develop 版本（`baseVersion 5.4.0` / `nextVersion 5.5.0` / 含 #148 entry）
- PR #151 `CHANGELOG.md` 取 develop 版本（保留 v5.5.0 待发布块；`[5.4.0]` 等历史段两边一致）

### 配置变更
- 无

### 环境变量提醒
- PR #148 检测到环境变量相关文件变更：`.env.example`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #148 `pnpm run typecheck`
- PR #148 `pnpm exec jest --watchman=false --runTestsByPath tests/biz/monitoring/services/dashboard/analytics-query.service.spec.ts`
- PR #148 Pre-commit hook: lint + format passed
- PR #148 Pre-push hook: `pnpm run ci:check` passed, including lint, format, typecheck, build, and `jest --coverage --watchman=false` (219 suites / 2574 tests)
- PR #151 `node -e 'JSON.parse(...)'` 校验 `.release/pending-release.json` 合法
- PR #151 `grep` 确认无遗留冲突标记
- PR #151 CI Checks 通过
- PR #151 合并本 PR 后 PR #150 状态变为 MERGEABLE

## [5.4.0] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #141 支持消息流水按托管 BOT 筛选
- PR #140 Hardened interview precheck/booking around `00:00-00:00` date-only windows so deadline-like timestamps are not submitted as concrete interview times.
- PR #140 Added bookable slot metadata and prompt guidance so the agent asks for a valid date/time instead of inventing one.
- PR #140 Updated `invite_to_group` routing to refresh group member counts from the enterprise group list before selecting a group.
- PR #140 Skips groups at or over `GROUP_MEMBER_LIMIT`, retries the next candidate when the invite API reports `-10`, and only alerts when every matching group is full.
- PR #140 Reduces invalid interview booking submissions for special all-day/date-only windows.
- PR #140 Prevents continuing to invite candidates into full part-time groups when another city/industry-matched group is available.
- PR #140 Keeps the group capacity alert reserved for the true overflow case where all matching groups are full.
- PR #145 合并最新 master 到 develop，用于解除 #143 发版 PR 的冲突
- PR #145 保留 develop 的 v5.4.0 待发布元数据
- PR #145 保留 master 已固化的 v5.3.2 发布记录

### 新功能
- PR #141 支持消息流水按托管 BOT 筛选

### 问题修复
- PR #140 Hardened interview precheck/booking around `00:00-00:00` date-only windows so deadline-like timestamps are not submitted as concrete interview times.
- PR #140 Added bookable slot metadata and prompt guidance so the agent asks for a valid date/time instead of inventing one.
- PR #140 Updated `invite_to_group` routing to refresh group member counts from the enterprise group list before selecting a group.
- PR #140 Skips groups at or over `GROUP_MEMBER_LIMIT`, retries the next candidate when the invite API reports `-10`, and only alerts when every matching group is full.
- PR #140 Reduces invalid interview booking submissions for special all-day/date-only windows.
- PR #140 Prevents continuing to invite candidates into full part-time groups when another city/industry-matched group is available.
- PR #140 Keeps the group capacity alert reserved for the true overflow case where all matching groups are full.

### 优化调整
- PR #145 合并最新 master 到 develop，用于解除 #143 发版 PR 的冲突

### 运维与流程
- PR #145 保留 develop 的 v5.4.0 待发布元数据
- PR #145 保留 master 已固化的 v5.3.2 发布记录

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #141 `pnpm jest tests/biz/message/message.controller.spec.ts tests/biz/message/services/message-processing.service.spec.ts tests/biz/message/repositories/message-processing.repository.spec.ts --runInBand --watchman=false`
- PR #141 `pnpm run build:web`
- PR #141 `pnpm run typecheck`
- PR #141 `pnpm run lint:check`
- PR #141 `pnpm run format:check`
- PR #141 `API_GUARD_TOKEN=ci-placeholder-token pnpm run build`
- PR #141 push 前完整 `pnpm run ci:check` 通过：216 suites / 2539 tests
- PR #140 `pnpm jest tests/tools/tool/duliday-interview-precheck.tool.spec.ts tests/tools/tool/duliday-interview-booking.tool.spec.ts tests/tools/tool/invite-to-group.tool.spec.ts --runInBand --watchman=false`
- PR #140 `pnpm run typecheck`
- PR #140 `pnpm run lint:check`
- PR #140 `pnpm prettier --check src/tools/invite-to-group.tool.ts tests/tools/tool/invite-to-group.tool.spec.ts`
- PR #140 `git diff --check`
- PR #140 Pre-push `pnpm run ci:check` passed: 216 test suites, 2540 tests.
- PR #145 JSON parse: package.json / .release/pending-release.json
- PR #145 确认 package.json、CHANGELOG.md、.release/pending-release.json 无冲突标记
- PR #145 git diff --check --cached

## [5.3.2] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #135 修复部署 workflow 的飞书通知 job 读不到 production 环境 secrets 的问题。
- PR #135 补充 `DEPLOY_NOTIFICATION_WEBHOOK_URL` / `DEPLOY_NOTIFICATION_WEBHOOK_SECRET` 作为旧配置名兜底。
- PR #135 当 webhook 未配置时跳过通知但不阻断发布，避免“代码已部署成功但 workflow 被通知步骤标红”。

### 新功能
- 无

### 问题修复
- PR #135 修复部署 workflow 的飞书通知 job 读不到 production 环境 secrets 的问题。
- PR #135 补充 `DEPLOY_NOTIFICATION_WEBHOOK_URL` / `DEPLOY_NOTIFICATION_WEBHOOK_SECRET` 作为旧配置名兜底。

### 优化调整
- 无

### 运维与流程
- PR #135 当 webhook 未配置时跳过通知但不阻断发布，避免“代码已部署成功但 workflow 被通知步骤标红”。

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #135 ruby YAML 解析 `.github/workflows/deploy.yml` 通过
- PR #135 `pnpm exec prettier --check .github/workflows/deploy.yml`
- PR #135 `REQUIRE_DEPLOY_NOTIFICATION=false node scripts/send-deploy-notification.js`
- PR #135 pre-push `pnpm run ci:check`：216 个测试套件、2532 个测试通过

## [5.3.1] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #129 在版本元数据 PR 合并到 develop 后，自动创建或更新 develop → master 发版 PR。
- PR #129 修复 scripts/get-release-notes.js 对 CHANGELOG 发布段的提取逻辑，避免 JS 正则不支持 \Z 导致 GitHub Release 创建失败。
- PR #129 发布 workflow 在 tag 已存在但 GitHub Release 缺失/需要更新时，也会继续触发部署，支持半失败恢复。
- PR #129 更新发版文档，明确自动创建流程和本地命令兜底。

### 新功能
- PR #129 发布 workflow 在 tag 已存在但 GitHub Release 缺失/需要更新时，也会继续触发部署，支持半失败恢复。

### 问题修复
- PR #129 修复 scripts/get-release-notes.js 对 CHANGELOG 发布段的提取逻辑，避免 JS 正则不支持 \Z 导致 GitHub Release 创建失败。
- PR #129 更新发版文档，明确自动创建流程和本地命令兜底。

### 优化调整
- PR #129 在版本元数据 PR 合并到 develop 后，自动创建或更新 develop → master 发版 PR。

### 运维与流程
- 无

### 配置变更
- 无

### 环境变量提醒
- 无

### 验证记录
- PR #129 node --check scripts/build-release-pr-body.js && node --check scripts/create-release-pr.js && node --check scripts/get-release-notes.js
- PR #129 使用 origin/master 的 CHANGELOG 验证可提取 v5.3.0 发布说明
- PR #129 pnpm release:pr:preview
- PR #129 ruby YAML 解析 .github/workflows/version-changelog.yml 通过
- PR #129 pnpm exec prettier --check .github/workflows/version-changelog.yml scripts/get-release-notes.js
- PR #129 pre-push pnpm run ci:check：216 个测试套件、2532 个测试通过

## [5.3.0] - 2026-04-28

**来源分支**: `develop`

### 更新摘要
- PR #111 发布部署流水线支持 tag 触发与环境变量同步提醒
- PR #115 测试套件验证流程增强 + 数据集策展硬闸门
- PR #118 Agent 思考/工具/回复链可视化重放与运营视角文档
- PR #120 修复企微图片/文本合并处理，以及预约与仪表盘统计记录
- PR #120 托管用户运营页支持搜索、稳定排序、BOT 筛选和真实配置数据
- PR #120 消息处理详情抽屉新增好/坏反馈，并将 Batch ID 回写飞书
- PR #120 优化反馈成功/失败状态展示，并补充后端错误详情
- PR #120 优化待发布说明和部署通知格式
- PR #123 准备 Web 后台发版改动
- PR #125 新增 Release PR Autofill：develop → master 发版 PR 创建后，自动从 CHANGELOG.md 待发布内容生成中文标题和正文。
- PR #125 增加本地发版 PR 命令：pnpm release:pr:preview 预览，pnpm release:pr:create 创建或更新 develop → master PR。
- PR #125 更新 PR 模板和发版文档，说明发版 PR 可以先填临时标题，也可以用命令避免手填。

### 新功能
- PR #115 测试套件新增校验标题字段，前端重写复核弹窗、执行详情与对话列表组件
- PR #115 测试批次导入与回写飞书的服务链路完善
- PR #118 Agent 响应快照持久化，前端在执行详情按思考链 → 工具调用 → 回复链单一来源还原
- PR #118 新增运营/产品视角的 Agent 运行时与工作流文档，并与研发版架构文档交叉链接
- PR #123 准备 Web 后台发版改动
- PR #125 新增 Release PR Autofill：develop → master 发版 PR 创建后，自动从 CHANGELOG.md 待发布内容生成中文标题和正文。

### 问题修复
- PR #120 修复企微图片/文本合并处理，以及预约与仪表盘统计记录

### 优化调整
- PR #115 收紧 badcase 数据集策展规则
- PR #118 批次状态机放开 completed → reviewing，支持单条重跑后重新评审
- PR #120 托管用户运营页支持搜索、稳定排序、BOT 筛选和真实配置数据

### 运维与流程
- PR #111 发布工作流在打 tag、创建 GitHub Release 之后自动触发部署，避免受保护分支推送不触发下游
- PR #111 部署工作流支持手动指定 tag 触发，便于回滚或定向重发
- PR #111 PR 合并后在变更记录中标记环境变量相关文件，提示生产侧手动同步
- PR #120 消息处理详情抽屉新增好/坏反馈，并将 Batch ID 回写飞书
- PR #120 优化反馈成功/失败状态展示，并补充后端错误详情
- PR #120 优化待发布说明和部署通知格式
- PR #125 增加本地发版 PR 命令：pnpm release:pr:preview 预览，pnpm release:pr:create 创建或更新 develop → master PR。
- PR #125 更新 PR 模板和发版文档，说明发版 PR 可以先填临时标题，也可以用命令避免手填。

### 配置变更
- 无

### 环境变量提醒
- PR #115 检测到环境变量相关文件变更：`.env.example`、`src/infra/config/env.validation.ts`。请手动同步远程服务器 `/data/cake/.env.production`。

### 验证记录
- PR #111 pnpm run ci:check 通过：216 suites / 2515 tests
- PR #115 测试环境已应用 validation_title 字段迁移
- PR #115 Dashboard 测试套件列表 / 执行详情 / 对话复核弹窗回归通过
- PR #118 pnpm run test:ci 通过：216 suites / 2526 tests
- PR #118 pnpm run lint:check / format:check / typecheck 全部通过
- PR #120 pnpm run ci:check
- PR #120 pre-push hook passed: 216 suites / 2532 tests
- PR #123 pre-commit: `pnpm run lint` + `pnpm run format` 通过。
- PR #123 pre-push: `pnpm run ci:check` 通过。
- PR #123 `ci:check` 覆盖：`lint:check`、`format:check`、`typecheck`、`build:ci`、`test:ci`。
- PR #123 `test:ci`: 216 suites / 2532 tests passed。
- PR #125 node --check scripts/build-release-pr-body.js
- PR #125 node --check scripts/create-release-pr.js
- PR #125 pnpm release:pr:preview
- PR #125 pnpm exec prettier --check package.json scripts/create-release-pr.js docs/workflows/version-release-guide.md
- PR #125 pre-push pnpm run ci:check：216 个测试套件、2532 个测试通过
