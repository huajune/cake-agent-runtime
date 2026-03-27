# 版本发布指南

## 📋 概述

本项目采用**自动化版本发布**流程，当代码合并到 `master` 分支时，系统会自动完成以下操作：

✅ 分析提交历史，计算新版本号
✅ 更新 `package.json` 版本号
✅ 生成 `CHANGELOG.md` 更新记录
✅ 直接提交 release commit 到 `master`
✅ 自动同步到 `develop` 分支
✅ 创建 Git Tag（如 `v1.2.3`）
✅ 使用该 tag 触发生产部署

**你只需要做两件事：**
1. 按照规范提交代码
2. 创建 PR 并合并到 `master`

---

## 🚀 如何发布版本

### 第一步：在 develop 分支开发

```bash
# 确保在 develop 分支
git checkout develop

# 开发你的功能...
# 完成后提交代码（遵循提交规范，见下文）
git add .
git commit -m "feat: 添加用户导出功能"
git push origin develop
```

### 第二步：创建 Pull Request

1. 在 GitHub 上创建 PR：`develop` → `master`
2. 填写 PR 描述，说明本次更新内容
3. 等待代码审核

### 第三步：合并 PR

PR 审核通过后，点击 **Merge pull request** 合并到 `master` 分支。

### 第四步：等待自动化完成

合并后，GitHub Actions 会自动：
- 分析提交历史
- 计算版本号
- 提交 release commit 到 `master`
- 同步该 release commit 到 `develop`
- 创建 Tag 并触发部署

大约 1-2 分钟后，你可以在以下位置查看结果：
- [Actions 执行日志](../../.github/workflows/version-changelog.yml)
- [CHANGELOG.md](../../CHANGELOG.md) 查看更新记录
- [Releases](https://github.com/huajune/cake-agent-runtime/tags) 查看版本标签

---

## 📝 提交规范（重要！）

### 提交消息格式

```
<类型>(<作用域>): <简短描述>

[可选的详细描述]
```

### 常用提交类型

| 类型 | 说明 | 示例 | 版本变化 |
|------|------|------|----------|
| `feat` | 新功能 | `feat(user): 添加用户导出功能` | 次版本 +1 |
| `fix` | Bug 修复 | `fix(auth): 修复登录失效问题` | 补丁版本 +1 |
| `refactor` | 重构 | `refactor(api): 优化接口响应结构` | 补丁版本 +1 |
| `perf` | 性能优化 | `perf(query): 优化数据库查询性能` | 补丁版本 +1 |
| `docs` | 文档更新 | `docs: 更新 API 文档` | 补丁版本 +1 |
| `style` | 代码格式 | `style: 统一代码缩进` | 补丁版本 +1 |
| `test` | 测试 | `test(user): 添加用户模块测试` | 补丁版本 +1 |
| `chore` | 构建/工具 | `chore: 升级依赖版本` | 补丁版本 +1 |

### 提交示例

**✅ 好的提交：**

```bash
# 带作用域的提交（推荐）
git commit -m "feat(message): 添加消息去重功能"
git commit -m "fix(agent): 修复 Agent 缓存失效问题"
git commit -m "refactor(api): 简化错误处理逻辑"

# 不带作用域的提交
git commit -m "feat: 添加数据导出接口"
git commit -m "fix: 修复内存泄漏问题"
```

**❌ 不好的提交：**

```bash
git commit -m "更新代码"           # 没有类型前缀
git commit -m "fix bug"            # 描述不明确
git commit -m "feat:添加功能"      # 缺少空格
git commit -m "完成需求"           # 不符合规范
```

---

## 🔢 版本号规则

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范：

```
版本格式：主版本.次版本.补丁版本 (例如: 1.2.3)
```

### 版本递增规则

| 提交类型 | 版本变化 | 示例 |
|----------|----------|------|
| `BREAKING CHANGE` | 主版本 +1 | `1.5.3` → `2.0.0` |
| `feat:` | 次版本 +1 | `1.5.3` → `1.6.0` |
| `fix:` 及其他 | 补丁版本 +1 | `1.5.3` → `1.5.4` |

### BREAKING CHANGE 说明

如果你的更新包含**不兼容的 API 变更**，需要在提交消息中注明：

```bash
git commit -m "feat(api): 重构用户接口

BREAKING CHANGE: 用户接口返回格式变更，需要更新客户端代码
- 移除了 `user.profile` 字段
- 新增 `user.info` 字段
"
```

---

## 📖 CHANGELOG 格式

### 自动生成示例

```markdown
## [1.2.3] - 2025-11-06

**分支**: `master`

Bug 修复：
- 修复 Agent 缓存失效问题 (a1b2c3d)
- auth: 修复登录超时问题 (e4f5g6h)

Feature 更新：
- message: 添加消息去重功能 (i7j8k9l)
- 添加数据导出接口 (m0n1o2p)
- 优化数据库查询性能 (q3r4s5t)
```

### 格式说明

- **Bug 修复**：所有 `fix:` 类型的提交
- **Feature 更新**：所有其他类型的提交（feat, refactor, perf, docs, chore 等）
- 提交格式：`作用域: 描述 (短hash)` 或 `描述 (短hash)`

### 自动过滤规则

以下提交**不会**出现在 CHANGELOG 中：
- 包含 `[skip ci]` 的提交（版本同步提交）
- `Merge pull request` 开头的提交（PR 合并记录）

---

## ⚠️ 注意事项

### 1. 分支管理

- **开发分支**：`develop`（日常开发）
- **主分支**：`master`（生产版本）
- ⚠️ 不要由开发者直接在 `master` 分支提交业务代码
- ⚠️ 所有功能必须通过 PR 合并到 `master`
- ℹ️ release workflow 会代表机器人推送版本提交到 `master`

### 2. 提交规范

- ✅ 每次提交只做一件事
- ✅ 提交消息要清晰描述改动内容
- ✅ 使用英文冒号后加空格（`feat: `）
- ⚠️ 不要使用中文冒号（`feat：`）

### 3. PR 合并

- ✅ 合并前确保 CI 检查通过
- ✅ 合并后检查 Actions 执行状态
- ⚠️ 如果 Actions 失败，及时处理

### 4. 版本同步

- GitHub Actions 会自动将版本更新同步到 `develop` 分支
- 开发前记得 `git pull origin develop` 拉取最新代码
- 如果自动同步失败（有冲突），需要手动解决

---

## 🔍 常见问题

### Q1: 我提交了代码但版本号没变？

**A:** 检查以下几点：
1. 是否合并到了 `master` 分支（只有 `master` 触发自动化）
2. 提交消息是否符合规范（必须有 `feat:` `fix:` 等前缀）
3. 查看 [GitHub Actions](https://github.com/huajune/cake-agent-runtime/actions) 是否执行成功

### Q2: 如何查看历史版本？

**A:** 三种方式：
1. 查看 [CHANGELOG.md](../../CHANGELOG.md)
2. 查看 [GitHub Releases](https://github.com/huajune/cake-agent-runtime/releases)
3. 运行 `git tag -l` 查看所有版本标签

### Q3: 我想回退到某个版本怎么办？

**A:** 使用 Git Tag 回退：
```bash
# 查看所有版本
git tag -l

# 切换到指定版本
git checkout v1.2.3

# 或基于某个版本创建分支
git checkout -b fix-branch v1.2.3
```

### Q4: 自动化失败了怎么办？

**A:** 查看 [GitHub Actions 日志](https://github.com/huajune/cake-agent-runtime/actions)，常见原因：
- 提交消息格式不正确
- Git 冲突（需要手动解决）
- 权限问题（联系管理员）

### Q5: 我能手动修改版本号吗？

**A:** ⚠️ **不推荐**手动修改 `package.json` 中的版本号，这会导致：
- 版本号与 CHANGELOG 不一致
- Git Tag 混乱
- 自动化流程出错

如果确实需要手动调整，请联系项目维护者。

---

## 📚 相关文档

- [自动化版本管理技术文档](./auto-version-changelog.md) - 详细的技术实现说明
- [Conventional Commits 规范](https://www.conventionalcommits.org/) - 提交消息规范
- [语义化版本规范](https://semver.org/lang/zh-CN/) - 版本号规范
- [GitHub Actions 工作流配置](../../.github/workflows/version-changelog.yml)

---

## 💡 最佳实践

### 1. 提交粒度

```bash
# ✅ 好的做法：每个功能单独提交
git commit -m "feat(user): 添加用户导出接口"
git commit -m "feat(user): 添加导出格式验证"
git commit -m "test(user): 添加导出功能测试"

# ❌ 不好的做法：所有改动一次提交
git commit -m "feat: 完成用户模块所有功能"
```

### 2. 作用域使用

常用作用域参考：
- `user` - 用户相关
- `message` - 消息相关
- `agent` - Agent 相关
- `api` - API 接口
- `auth` - 认证授权
- `db` - 数据库
- `config` - 配置

### 3. 发布前检查清单

在创建 PR 到 `master` 之前，确认：

- [ ] 所有测试通过
- [ ] 代码已格式化（`pnpm run format`）
- [ ] 代码已通过 Lint 检查（`pnpm run lint`）
- [ ] 提交消息符合规范
- [ ] 功能已在 `develop` 分支测试
- [ ] PR 描述清晰完整

---

**有问题？** 查看 [自动化版本管理技术文档](./auto-version-changelog.md) 或联系项目维护者。
