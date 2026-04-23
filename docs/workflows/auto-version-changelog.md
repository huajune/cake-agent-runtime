# 自动化版本管理文档

## 概述

当前版本管理改成 PR 驱动的两段式自动化：

1. 功能 PR 合并到 `develop` 后，机器人创建或更新一个“版本元数据 PR”到 `develop`
2. `develop -> master` 的 release PR 合并后，机器人再创建一个“正式发布固化 PR”到 `master`
3. 正式发布固化 PR 合并后，自动创建 Git Tag、GitHub Release，并继续走部署流程

这套流程的目标是：

- 让 `develop` 始终带着“待发布版本”的准确信息
- 让 `master` 只承接已经确认要发布的版本
- 让 `CHANGELOG.md` 的内容统一使用中文，而不是直接照搬英文 commit message

---

## 触发流程

### 1. PR 合并到 develop

触发文件：[`version-changelog.yml`](../../.github/workflows/version-changelog.yml)

触发条件：

```yaml
on:
  pull_request_target:
    types: [closed]
    branches:
      - develop
```

执行内容：

1. 读取最近一次 release tag
2. 分析自上次 release 以来的 commit，自动计算下一版本号
3. 读取本次 PR 的中文说明
4. 更新 `package.json`
5. 更新 `CHANGELOG.md` 顶部的“待发布”区块
6. 写入 [`.release/pending-release.json`](../../.release/pending-release.json) 作为累计状态
7. 创建或更新一个机器人 PR 到 `develop`

### 2. release PR 合并到 master

触发文件：[`version-changelog.yml`](../../.github/workflows/version-changelog.yml)

触发条件：

```yaml
on:
  pull_request_target:
    types: [closed]
    branches:
      - master
```

执行内容：

1. 读取 `master` 上已带过去的待发布内容
2. 把“待发布”固化为正式版本记录
3. 创建或更新一个机器人 PR 到 `master`
4. 当该机器人 PR 合并后，创建 `vX.Y.Z` tag
5. 创建 GitHub Release
6. 由 tag 继续触发部署工作流

---

## 文件职责

### `package.json`

- 保存当前待发布版本号
- 在 `develop` 上体现“下一次上线准备发哪个版本”

### `CHANGELOG.md`

- 面向团队的中文版本记录
- 顶部维护一个“待发布”区块
- 发布后固化成正式版本区块

### `.release/pending-release.json`

- 机器读写的待发布状态文件
- 存放累计 PR 条目，避免每次重跑都重复追加文本
- 仅作为自动化中间状态，不建议手工修改

### `.github/pull_request_template.md`

- 规范 PR 使用中文填写更新说明
- `CHANGELOG.md` 的中文内容优先从这里提取

---

## 版本号规则

版本号继续遵循语义化版本：

- `BREAKING CHANGE` 或 `feat!:`: 主版本 +1
- `feat:`: 次版本 +1
- 其他有效提交: 补丁版本 +1

注意：

- 版本号计算仍然基于 commit 历史
- 但 `CHANGELOG.md` 文案不再直接照抄 commit message
- 中文版本说明优先来自 PR 模板

---

## CHANGELOG 结构

### develop 上的待发布结构

```md
## 待发布

**预计版本**: `v4.0.1`
**最近更新**: `2026-04-08`
**来源分支**: `develop`
**累计 PR**: 3

### 更新摘要

- PR #101 fix: 修复群任务时区问题
- PR #102 feat: 支持消息通知群发布卡片
- PR #103 chore: 优化发布流和版本管理脚本

### 新功能

- PR #102 支持消息通知群发布卡片

### 问题修复

- PR #101 修复 UTC CI 下的日期断言失败

### 优化调整

- PR #103 优化发布流和版本管理脚本

### 运维与流程

- PR #103 调整 CI/CD 工作流

### 配置变更

- 无

### 验证记录

- `pnpm run ci:check`
```

### master 上的正式版本结构

```md
## [4.0.1] - 2026-04-08

**来源分支**: `develop`

### 更新摘要

- PR #101 fix: 修复群任务时区问题

### 新功能

- 无

### 问题修复

- PR #101 修复 UTC CI 下的日期断言失败
```

---

## 配置要求

### GitHub Actions 权限

工作流需要：

- `contents: write`

因为需要自动提交版本文件并创建 tag / release。

如果仓库对 `develop` / `master` 开启了严格分支保护，不需要给 GitHub Actions 开直推 bypass。当前方案本身就是通过机器人 PR 来兼容受保护分支。

### 飞书部署通知

部署通知发送到飞书“企微私域监控群”，需要在 GitHub Secrets 中配置：

- `PRIVATE_CHAT_MONITOR_WEBHOOK_URL`
- `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET`

---

## 约定

### PR 模板中的这些标题不要随意改名

- `更新摘要`
- `新功能`
- `问题修复`
- `优化调整`
- `运维与流程`
- `配置变更`
- `验证记录`

自动化脚本会按这些中文标题提取内容。

### 推荐做法

- PR 标题继续遵循 Conventional Commits，方便自动计算版本号
- PR 正文使用中文，方便生成团队可读的版本说明
- `更新摘要` 里的 bullet 会原样保留到 `CHANGELOG.md`，可以写成 `feat:` / `fix:` / `chore:` 这类轻量分类

### 机器人 PR 约定

- `develop` 元数据 PR 分支：`chore/release-metadata/develop`
- `master` 固化 PR 分支：`chore/release-metadata/master`
- PR body 会带隐藏标记：`<!-- release-metadata-pr -->`

这个标记专门用于防止机器人 PR 合并后再次触发自己创建新的机器人 PR。

---

## 常见问题

### 为什么不是直接用 commit message 生成 CHANGELOG？

因为 commit 更适合机器判断 `major/minor/patch`，不适合直接给团队看发布说明。中文 PR 描述更稳定，也更适合沉淀版本记录。

### 为什么 develop 要先生成待发布信息？

因为这样在 release PR 打开前，团队就能直接看到“当前准备上线的版本号”和“上线会包含哪些内容”。

### 为什么不会循环触发？

因为 workflow 只在 PR 合并时触发，并且会显式跳过：

- `head.ref` 以 `chore/release-metadata/` 开头的 PR
- 标题为 `chore(release): ...` 的机器人 PR
- body 含 `<!-- release-metadata-pr -->` 标记的 PR

所以机器人 PR 只负责承载版本文件变更，不会再次生成新的机器人 PR。

### 如果 master 已发布，但 develop 还没同步怎么办？

脚本会在下一次 `develop` 自动更新时，根据最新 tag 自动把旧的待发布内容转成历史版本记录，再继续累计新的待发布内容。
