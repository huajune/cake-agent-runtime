# 版本与发布指南

> 本文合并了「发布操作流程」与「版本自动化机制」两部分（原 `auto-version-changelog.md` 已并入）。
> 上半部分是**怎么操作**（日常开发 / 正式发布），下半部分是**机制参考**（workflow、文件职责、版本号规则、FAQ）。

---

## 一、发布流概览

PR 驱动的两段式自动化：

1. 日常开发通过 PR 合并到 `develop`
2. 合并后自动创建或更新机器人「版本元数据 PR」到 `develop`
3. 合并「版本元数据 PR」后，自动创建或更新 `develop → master` release PR
4. release PR 合并后，自动创建或更新机器人「正式发布固化 PR」到 `master`
5. 固化 PR 合并后自动打 tag、创建 GitHub Release、触发生产部署、发飞书通知

含义：`develop` 负责准备待发布版本，`master` 负责正式发布。

> **全自动闸口（推荐）**：配置了 `RELEASE_BOT_TOKEN` secret 且仓库开启 Allow auto-merge 后，
> 第 2、4、5 步的机器人 PR（元数据 PR / 固化 PR / master→develop 回同步 PR）会自动
> approve + auto-merge，**整个发版只剩一次人工操作：合并 `develop → master` release PR**。
> 未配置时回退到逐个人工合并的旧流程。配置方法见「九、配置要求」。

---

## 二、日常开发怎么走

### 第一步：提交功能 PR 到 develop

PR 标题用 Conventional Commits 风格（方便自动算版本号）：

```bash
feat(group-task): 支持群任务发布卡片
fix(ci): 修复 UTC 环境下的日期测试失败
chore(release): 调整版本自动化流程
```

PR 正文按模板填中文说明，重点这些小节（自动化脚本按中文标题提取，**不要改名**）：
`更新摘要`、`新功能`、`问题修复`、`优化调整`、`运维与流程`、`配置变更`、`验证记录`。

### 第二步：PR 合并到 develop

合并后 GitHub Actions 自动：计算下一版本号 → 更新 `package.json` → 更新 `CHANGELOG.md` 顶部「待发布」区 → 创建/更新机器人 PR 到 `develop`。你不用手改版本号，但需把这个机器人 PR 合并进 `develop`。

---

## 三、正式发布怎么走

1. 从 [发版底账模板](../releases/_template.md) 创建或更新本批 pending 底账，按实际 diff 策展 P0/P1 回归 case
2. 确认 `develop` 上 `CHANGELOG.md` 待发布内容正确
3. 合并机器人「版本元数据 PR」，版本确定后将 pending 底账重命名为 `docs/releases/YYYY/vX.Y.Z.md`
4. 等系统自动创建/更新 `develop → master` release PR（也可 `pnpm release:pr:create` 手动创建、`pnpm release:pr:preview` 预览）
5. 确认底账 P0 全部通过，审核版本说明 / 配置影响 / 验证证据 / 回滚方案 → 合并 release PR
6. 合并后系统创建机器人「正式发布固化 PR」到 `master`；**该 PR 合并后**才继续：打 `vX.Y.Z` tag → 创建 GitHub Release → 触发部署 → 发飞书企微私域监控群通知
7. 发布完成后在底账补齐 tag、Release、部署、生产验证、监控与遗留事项

> 手动在网页建 `develop → master` PR 时不用填通用模板，填个临时标题即可，`Release PR Autofill` workflow 会从 `CHANGELOG.md` 待发布区生成标题正文。

### 托管成员配置检查

`system_config.hosting_member_config` 是运行时配置，不等同于 Supabase schema migration。
如果本次改动涉及托管账号、飞书接收人、海绵 token 映射，发版前除了确认 migration，还要跑：

```bash
pnpm config:hosting:check:prod
```

若提示 drift，先执行对应环境同步并复查：

```bash
pnpm config:hosting:sync:prod
pnpm config:hosting:check:prod
```

新增非敏感的飞书接收人映射时，优先补一个幂等 SQL migration，避免只改 seed 脚本导致生产运行时配置漏同步。明文 Duliday token 不进 migration，由生产配置单独维护。

---

## 四、注意事项

**不要手工改**：`package.json` 版本号、`.release/pending-release.json`（除非在改自动化本身）。

**两类机器人 PR**（都是自动化的一部分，按正常流程合并）：

- `chore(release): 更新待发布版本信息（vX.Y.Z）`
- `chore(release): 固化正式版本记录（vX.Y.Z）`

**PR 正文不按模板写**：自动化仍跑，但中文说明退化成只记 PR 标题，信息变少。

**飞书通知没发出**：先查 GitHub Secrets `PRIVATE_CHAT_MONITOR_WEBHOOK_URL` / `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET`，再查部署 workflow 日志。

---

# 机制参考

## 五、触发流程

触发文件：[`.github/workflows/version-changelog.yml`](../../.github/workflows/version-changelog.yml)

### PR 合并到 develop（`pull_request_target: closed`, branch `develop`）

读取最近 release tag → 分析 commit 算下一版本号 → 读 PR 中文说明 → 更新 `package.json` → 更新 `CHANGELOG.md` 待发布区 → 写 [`.release/pending-release.json`](../../.release/pending-release.json) 累计状态 → 创建/更新机器人 PR 到 `develop`。

### release PR 合并到 master（`pull_request_target: closed`, branch `master`）

读 `master` 已带过去的待发布内容 → 固化为正式版本记录 → 创建/更新机器人 PR 到 `master` → 该 PR 合并后创建 `vX.Y.Z` tag → 创建 GitHub Release → 由 tag 触发部署。

## 六、文件职责

| 文件                               | 职责                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `package.json`                     | 当前待发布版本号；在 `develop` 体现"下次发哪个版本"                    |
| `CHANGELOG.md`                     | 面向团队的中文版本记录；顶部「待发布」区，发布后固化成正式版本区       |
| `.release/pending-release.json`    | 机器读写的待发布状态；存累计 PR 条目避免重复追加；不建议手改           |
| `.github/pull_request_template.md` | 规范 PR 中文说明；CHANGELOG 内容优先从这里提取                         |
| `docs/releases/`                   | 人工可审计的逐版本发版底账；记录范围、风险、回归、证据、回滚与发布结果 |

## 七、版本号规则

标准语义化版本，基于 commit 历史计算：`BREAKING CHANGE`/`type!:` → major+1；`feat:` → minor+1；其他有效提交（`fix:`/`perf:`/`refactor:`/`docs:` 等）→ patch+1。注意版本号按 commit 算，但 CHANGELOG 文案不照抄 commit，优先取 PR 模板中文说明。

> 历史口径变更：v8.0.0 之前 `feat:` 直接升 major（"业务新能力进下一大版本"），导致发版批次混入一个小 feat 就跳大版本（两天内 v6→v7→v8），已改回标准 semver。

## 八、CHANGELOG 结构

**develop 待发布区**：

```md
## 待发布

**预计版本**: `v4.0.1`
**最近更新**: `2026-04-08`
**来源分支**: `develop`
**累计 PR**: 3

### 更新摘要

- PR #101 修复群任务时区问题

### 新功能 / 问题修复 / 优化调整 / 运维与流程 / 配置变更 / 验证记录

- ...
```

**master 正式版本区**：

```md
## [4.0.1] - 2026-04-08

**来源分支**: `develop`

### 更新摘要

- PR #101 修复群任务时区问题
```

## 九、配置要求

- GitHub Actions 权限：`contents: write`（提交版本文件 + 创建 tag/release）。开启严格分支保护时**不需要**给 Actions 开直推 bypass——本方案通过机器人 PR 兼容受保护分支。
- 飞书部署通知 Secrets：`PRIVATE_CHAT_MONITOR_WEBHOOK_URL` / `PRIVATE_CHAT_MONITOR_WEBHOOK_SECRET`。

### 全自动闸口（可选，强烈推荐）

配好以下两项后，机器人 PR 不再需要人工 approve / 合并：

1. **`RELEASE_BOT_TOKEN` secret**：仓库管理员创建 fine-grained PAT（Repository access 选本仓库；
   Permissions 给 `Contents: Read and write` + `Pull requests: Read and write`），存为仓库 secret。
   原理：PAT push/建 PR 会正常触发 `pull_request` 事件（CI 原生跑，不再需要 workflow_dispatch
   兜底派发），且由 PAT 身份合并的 `merged` 事件能继续触发下一段 workflow——`GITHUB_TOKEN`
   的这两类产物都会被 GitHub 反递归机制吞掉，这是旧流程所有 dispatch 补丁的根因。
2. **仓库 Settings → General → Allow auto-merge** 打勾（auto-merge 功能开关，需管理员）。

安全边界：自动 approve 前会校验 PR 变更文件仅限 `package.json` / `CHANGELOG.md` /
`.release/pending-release.json`，含其他文件时跳过自动放行、回退人工处理。
未配置 `RELEASE_BOT_TOKEN` 时一切行为与旧流程一致。

## 十、机器人 PR 约定 & 防循环

- `develop` 元数据 PR 分支：`chore/release-metadata/develop`
- `master` 固化 PR 分支：`chore/release-metadata/master`
- PR body 隐藏标记：`<!-- release-metadata-pr -->`

workflow 只在 PR 合并时触发，且显式跳过：`head.ref` 以 `chore/release-metadata/` 开头 / 标题为 `chore(release): ...` / body 含 `<!-- release-metadata-pr -->`。所以机器人 PR 只承载版本文件变更，不会再触发自己。

## 十一、常见问题

- **为什么不直接用 commit message 生成 CHANGELOG？** commit 适合机判 major/minor/patch，不适合给团队看；中文 PR 描述更稳定。
- **为什么 develop 要先生成待发布信息？** release PR 打开前团队就能看到"当前准备上线的版本号和内容"。
- **master 已发布但 develop 没同步？** 下次 `develop` 自动更新时，脚本按最新 tag 把旧待发布内容转成历史版本记录，再累计新内容。

---

## 推荐团队习惯

- PR 标题用规范前缀，方便自动算版本号
- PR 正文用中文写清变更；`更新摘要` 写成可直接发群的中文，不依赖 `feat:`/`fix:` 前缀（脚本会兜底清理）
- release PR 打开后，先看 `CHANGELOG.md` 再决定是否合并
