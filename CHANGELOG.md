# Changelog

所有重要的项目更改都将记录在此文件中。

本项目遵循 语义化版本 规范。
版本号由 GitHub Actions 自动维护，发布说明统一使用中文记录。
变更记录按 PR 驱动整理：自动清理 PR/commit 前缀与常见英文工程表述，尽量产出可直接用于发布通知的中文摘要。

---

<!-- release:pending:start -->
## 待发布

**预计版本**: `v5.3.2`
**最近更新**: `2026-04-28`
**来源分支**: `develop`
**累计 PR**: 1

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
<!-- release:pending:end -->

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
