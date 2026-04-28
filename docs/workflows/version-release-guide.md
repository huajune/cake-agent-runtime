# 版本发布指南

## 现在的发布流

发布流程调整为：

1. 日常开发通过 PR 合并到 `develop`
2. 合并后自动创建或更新一个机器人“版本元数据 PR”到 `develop`
3. 合并机器人“版本元数据 PR”后，自动创建或更新 `develop -> master` release PR
4. release PR 合并后，自动创建或更新一个机器人“正式发布固化 PR”到 `master`
5. 正式发布固化 PR 合并后自动打 tag、创建 GitHub Release，并触发生产部署

这意味着：

- `develop` 负责准备待发布版本
- `master` 负责正式发布

---

## 日常开发怎么走

### 第一步：提交功能 PR 到 develop

推荐继续使用 Conventional Commits 风格的 PR 标题，例如：

```bash
feat(group-task): 支持群任务发布卡片
fix(ci): 修复 UTC 环境下的日期测试失败
chore(release): 调整版本自动化流程
```

PR 正文请按模板填写中文说明，特别是这些部分：

- `更新摘要`
- `新功能`
- `问题修复`
- `优化调整`
- `运维与流程`
- `配置变更`
- `验证记录`

### 第二步：PR 合并到 develop

合并后 GitHub Actions 会自动：

- 计算下一版本号
- 更新 `package.json`
- 更新 `CHANGELOG.md` 顶部“待发布”区块
- 创建或更新一个机器人 PR 到 `develop`

你不需要手工改版本号，但需要把这个机器人 PR 合并进 `develop`。

---

## 正式发布怎么走

### 第一步：从 develop 创建 release PR 到 master

当你准备发版时：

1. 确认 `develop` 上的 `CHANGELOG.md` 待发布内容正确
2. 合并机器人创建的“版本元数据 PR”
3. 等系统自动创建或更新 `develop -> master` release PR
4. 审核本次版本说明、配置影响、验证情况

### 第二步：合并 release PR

合并到 `master` 后，系统不会直接改受保护分支，而是会自动：

- 创建一个机器人“正式发布固化 PR”到 `master`

这个 PR 合并后，系统才会继续：

- 打 `vX.Y.Z` tag
- 创建 GitHub Release
- 触发部署
- 发送飞书发布通知到企微私域监控群

---

## CHANGELOG 里会记录什么

版本管理文件使用中文，主要包括：

- 版本号
- 发布时间 / 最近更新时间
- 来源分支
- 更新摘要
- 新功能
- 问题修复
- 优化调整
- 运维与流程
- 配置变更
- 验证记录

示例：

```md
## [4.0.1] - 2026-04-08

**来源分支**: `develop`

### 更新摘要

- PR #118 支持飞书消息通知群发布卡片
- PR #119 修复 UTC CI 下的日期断言失败
- PR #120 调整版本和部署流

### 新功能

- PR #118 支持飞书消息通知群发布卡片

### 问题修复

- PR #119 修复 UTC CI 下的日期断言失败

### 运维与流程

- PR #120 CI 覆盖 develop/master 的 PR 校验
- PR #120 发布成功后自动发送飞书企微私域监控群通知
```

---

## 注意事项

### 不要手工改这些文件

- `package.json` 里的版本号
- `.release/pending-release.json`

除非你在改自动化本身。

### 现在会多出两类机器人 PR

- `chore(release): 更新待发布版本信息（vX.Y.Z）`
- `chore(release): 固化正式版本记录（vX.Y.Z）`

这两类 PR 都是自动化流程的一部分，建议保留并按正常 PR 流程合并。

### 如果 PR 正文不按模板写，会发生什么？

自动化仍然会跑，但中文版本说明会退化成只记录 PR 标题，信息会明显变少。

### 如果飞书企微私域监控群通知没发出来，要查什么？

先检查 GitHub Secrets：

- `PRIVATE_CHAT_MONITOR_WEBHOOK_URL`
- `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET`

再检查对应的部署 workflow 日志。

### 为什么机器人 PR 不会无限循环？

因为 workflow 只在“PR 被合并”时触发，而且会跳过：

- 分支名以 `chore/release-metadata/` 开头的 PR
- 标题以 `chore(release):` 对应版本元数据模板开头的 PR
- body 里带 `<!-- release-metadata-pr -->` 标记的 PR

---

## 推荐团队习惯

- PR 标题用规范前缀，方便自动算版本号
- PR 正文用中文写清楚变更，方便自动生成版本说明
- `更新摘要` 写成可直接发群的中文，不要依赖 `feat:` / `fix:` / `chore:` 解释语义；脚本会兜底清理这些前缀
- release PR 打开后，先看 `CHANGELOG.md` 再决定是否合并

## develop → master 发版 PR

正常情况下，合并机器人“版本元数据 PR”到 `develop` 后，系统会自动创建或更新 `develop` → `master` release PR，并从 `CHANGELOG.md` 的待发布区生成标题和正文。

如果你在网页上手动创建 `develop` → `master` PR，不需要手填通用 PR 模板。填一个临时标题并创建即可，`Release PR Autofill` workflow 会自动从 `CHANGELOG.md` 的待发布区生成标题和正文。

如果自动创建没有触发，也可以用本地命令直接创建或更新发版 PR。这个命令只创建或更新 PR，不会合并、不打 tag、也不会发布：

```bash
pnpm release:pr:create
```

本地也可以预览自动生成的内容：

```bash
pnpm release:pr:preview
```
