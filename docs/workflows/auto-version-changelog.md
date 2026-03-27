# 自动化版本管理文档

## 概述

本项目使用 GitHub Actions 自动管理版本号和 CHANGELOG，基于 [语义化版本](https://semver.org/lang/zh-CN/) 和 [Conventional Commits](https://www.conventionalcommits.org/) 规范。

**核心优势**：
- 自动分析 Git 提交历史
- 自动计算版本号（主版本.次版本.补丁版本）
- 自动生成结构化的 CHANGELOG
- 自动创建 Git Tag
- 自动同步版本更新到 develop 分支

---

## 工作流程

### 完整流程图

```
开发者在 develop 分支工作
         ↓
    遵循 Conventional Commits 提交代码
    例如: feat: 新功能, fix: 修复 bug
         ↓
    创建 Pull Request: develop → master
         ↓
    代码审核，PR 合并到 master
         ↓
   【GitHub Actions 自动触发】
         ↓
1️⃣ 检出 master 分支代码
2️⃣ 分析从上次 tag 到 HEAD 的所有 commits
3️⃣ 根据提交类型计算新版本号
    - BREAKING CHANGE → 主版本 +1 (1.0.0 → 2.0.0)
    - feat: → 次版本 +1 (1.0.0 → 1.1.0)
    - fix: → 补丁版本 +1 (1.0.0 → 1.0.1)
4️⃣ 更新 package.json 版本号
5️⃣ 生成 CHANGELOG.md 条目
6️⃣ 直接提交 release commit 到 master 分支
7️⃣ 自动同步该 release commit 到 develop 分支
8️⃣ 创建 Git Tag (例如 v1.2.3)
9️⃣ 由该 tag 触发生产部署
```

### 关键配置

**触发条件** ([.github/workflows/version-changelog.yml](../.github/workflows/version-changelog.yml)):
```yaml
on:
  push:
    branches:
      - main
      - master
```

**脚本位置**: [scripts/update-version-changelog.js](../scripts/update-version-changelog.js)

---

## 版本号规则

遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)：

### 版本格式

```
主版本号.次版本号.补丁版本号
  │       │       │
  │       │       └─ 修复 bug (fix)
  │       └───────── 新增功能 (feat)
  └───────────────── 破坏性变更 (BREAKING CHANGE)
```

### 版本升级规则

| 提交类型 | 示例 | 版本变化 | 说明 |
|----------|------|----------|------|
| **BREAKING CHANGE** | `feat!: 重构 API 接口` | `1.0.0` → `2.0.0` | 不兼容的 API 修改 |
| **feat** | `feat: 添加用户登录功能` | `1.0.0` → `1.1.0` | 向下兼容的新功能 |
| **fix** | `fix: 修复登录按钮点击无效` | `1.0.0` → `1.0.1` | 向下兼容的 bug 修复 |
| **其他** | `docs: 更新 README` | `1.0.0` → `1.0.1` | 其他更新也增加补丁版本 |

### 示例

```bash
# 场景 1：修复 bug
git commit -m "fix: 修复用户名验证错误"
# 结果：1.0.0 → 1.0.1

# 场景 2：新增功能
git commit -m "feat: 添加消息推送功能"
# 结果：1.0.0 → 1.1.0

# 场景 3：破坏性变更
git commit -m "feat!: 重构 API，移除旧的认证方式

BREAKING CHANGE: 移除了基于 session 的认证，改用 JWT"
# 结果：1.0.0 → 2.0.0
```

---

## Conventional Commits 规范

### 提交消息格式

```
<类型>[可选的作用域]: <描述>

[可选的正文]

[可选的脚注]
```

### 提交类型

| 类型 | 说明 | CHANGELOG 分类 | 影响版本 |
|------|------|----------------|----------|
| `feat` | 新功能 | ✨ 新功能 | 次版本 +1 |
| `fix` | Bug 修复 | 🐛 Bug 修复 | 补丁版本 +1 |
| `docs` | 文档更新 | 📝 文档 | 补丁版本 +1 |
| `style` | 代码格式调整（不影响功能） | 🔨 其他更新 | 补丁版本 +1 |
| `refactor` | 代码重构（既不是新功能也不是修复） | 🔧 重构 | 补丁版本 +1 |
| `perf` | 性能优化 | ⚡ 性能优化 | 补丁版本 +1 |
| `test` | 添加或修改测试 | ✅ 测试 | 补丁版本 +1 |
| `chore` | 构建过程或辅助工具的变动 | 🔨 其他更新 | 补丁版本 +1 |
| `BREAKING CHANGE` | 破坏性变更（可以在任何类型后添加 `!`） | 💥 BREAKING CHANGES | 主版本 +1 |

### 提交示例

#### 1. 基本提交

```bash
# 新增功能
git commit -m "feat: 添加用户头像上传功能"

# 修复 bug
git commit -m "fix: 修复文件上传失败的问题"

# 文档更新
git commit -m "docs: 更新 API 文档"
```

#### 2. 带作用域的提交

```bash
git commit -m "feat(auth): 添加 OAuth 登录支持"
git commit -m "fix(message): 修复消息发送失败"
git commit -m "refactor(agent): 重构 Agent 配置加载逻辑"
```

#### 3. 多行提交（包含详细描述）

```bash
git commit -m "feat: 添加消息批量发送功能

支持一次性向多个用户发送消息，提升发送效率。

- 添加批量发送 API 接口
- 实现消息队列处理
- 添加发送进度跟踪"
```

#### 4. 破坏性变更

```bash
# 方式 1：使用 ! 标记
git commit -m "feat!: 重构 API 接口路径"

# 方式 2：使用 BREAKING CHANGE 脚注
git commit -m "feat: 升级认证机制

BREAKING CHANGE: 移除了旧的 session 认证方式，
现在必须使用 JWT token 进行认证。"
```

---

## CHANGELOG 格式

### 生成的 CHANGELOG 结构

从 2025-11-06 起，CHANGELOG 格式已优化，保留作用域信息并简化链接格式：

```markdown
## [1.2.0] - 2025-11-06

**分支**: `master`

### 💥 BREAKING CHANGES

auth: 移除旧的 session 认证方式 (abc1234)

### ✨ 新功能

user: 添加用户头像上传功能 (def5678)
message: 支持批量消息发送 (ghi9012)
添加消息推送功能 (hij3456)

### 🐛 Bug 修复

upload: 修复文件上传失败的问题 (jkl3456)
修复 TypeScript 类型错误 (mno7890)

### 📝 文档

api: 更新 API 文档 (pqr1234)
```

### 格式说明

**作用域显示**：
- 带作用域的提交：`feat(user): 添加功能` → `user: 添加功能 (abc1234)`
- 无作用域的提交：`feat: 添加功能` → `添加功能 (abc1234)`

**Hash 格式**：
- 使用 7 位短 hash，简洁明了
- 如需查看完整提交，可使用 `git show abc1234`

### CHANGELOG 特性

- **自动分类**：根据提交类型自动归类
- **保留作用域**：清晰展示改动所属的模块或功能
- **简洁格式**：移除 markdown 链接，使用简单的短 hash
- **版本信息**：显示版本号、日期、分支
- **保留历史**：新版本插入到顶部，保留所有历史记录
- **多行支持**：正确处理包含详细描述的多行提交消息

---

## 使用指南

### 日常开发流程

**1. 在 develop 分支开发**

```bash
git checkout develop
git pull origin develop

# 开发新功能...

# 遵循 Conventional Commits 提交
git add .
git commit -m "feat: 添加新功能"
git push origin develop
```

**2. 创建 Pull Request**

```bash
# 在 GitHub 上创建 PR: develop → master
# 标题和描述也建议遵循 Conventional Commits
```

**3. 合并 PR**

```bash
# 合并 PR 后，GitHub Actions 自动：
# - 分析提交历史
# - 更新版本号
# - 生成 CHANGELOG
# - 创建 Git Tag
# - 同步到 develop
```

**4. 查看结果**

```bash
# 拉取最新的 develop 分支（包含版本更新）
git checkout develop
git pull origin develop

# 查看 CHANGELOG
cat CHANGELOG.md

# 查看版本号
cat package.json | grep version

# 查看 Tags
git tag -l
```

### 手动触发版本更新（可选）

如果需要在本地测试脚本：

```bash
# 运行脚本
node scripts/update-version-changelog.js

# 查看更改
git diff package.json CHANGELOG.md

# 如果满意，提交更改
git add package.json CHANGELOG.md
git commit -m "chore: update version and changelog"
git push
```

---

## 故障排查

### 问题 1: Actions 没有触发

**症状**：合并 PR 后，没有看到版本更新

**排查步骤**：

1. 检查分支是否是 `master` 或 `main`：
   ```bash
   git branch --show-current
   ```

2. 检查提交消息是否包含 `[skip ci]`：
   ```bash
   git log -1 --pretty=format:"%s"
   ```

3. 查看 Actions 运行记录：
   - 访问 GitHub 仓库
   - 点击 "Actions" 标签
   - 查看 "Update Version and Changelog" 工作流

### 问题 2: 版本号没有按预期增加

**症状**：预期升级次版本，但只升级了补丁版本

**原因**：提交消息不符合 Conventional Commits 规范

**解决方法**：

```bash
# ❌ 错误：没有类型前缀
git commit -m "添加新功能"

# ✅ 正确：使用 feat: 前缀
git commit -m "feat: 添加新功能"

# ❌ 错误：类型拼写错误
git commit -m "feature: 添加新功能"

# ✅ 正确：类型必须是规范中定义的
git commit -m "feat: 添加新功能"
```

### 问题 3: CHANGELOG 内容不完整

**症状**：某些提交没有出现在 CHANGELOG 中

**原因**：

1. 提交在上次 tag 之前
2. 提交消息格式不规范
3. 脚本只分析最近 50 个提交

**解决方法**：

```bash
# 查看最后一个 tag
git tag -l | tail -1

# 查看从上次 tag 到现在的提交
git log <last-tag>..HEAD --oneline

# 如果需要调整分析的提交数量，修改脚本配置
# scripts/update-version-changelog.js
# commitLimit: 50 → commitLimit: 100
```

### 问题 4: 同步到 develop 失败

**症状**：Actions 日志显示合并冲突

**原因**：develop 分支有新的提交，与 master 冲突

**解决方法**：

```bash
# 手动同步
git checkout develop
git pull origin develop
git merge origin/master --no-ff
# 解决冲突...
git add .
git commit -m "chore: sync version from master"
git push origin develop
```

### 问题 5: 脚本运行错误

**症状**：Actions 失败，错误信息：`__dirname is not defined`

**原因**：脚本使用 ES modules，但 `__dirname` 不可用

**解决方法**：已在最新版本修复，确保使用最新代码：

```bash
git pull origin develop
```

### 问题 6: CHANGELOG 版本为空（已修复）

**症状**：某些版本在 CHANGELOG 中只有标题，没有具体的提交记录

**原因**：脚本无法正确解析包含多行描述的提交消息

**详细说明**：

在 2025-11-06 之前，脚本使用 `||` 作为字段分隔符，当提交包含多行描述时：

```
fix: 修复 bug

详细说明：
- 修复了 A 问题
- 修复了 B 问题
```

会导致解析失败，返回空数组，最终 CHANGELOG 为空。

**解决方法**：

已在 2025-11-06 修复（commit `9a963bf`）：
- 使用 ASCII 控制字符（`%x1e`、`%x1f`）作为分隔符
- 正确处理多行提交消息
- 确保使用最新版本的脚本

```bash
# 更新到最新版本
git pull origin develop

# 验证脚本版本
git log -1 --oneline scripts/update-version-changelog.js
# 应该包含修复提交 9a963bf 或更新的提交
```

---

## 配置自定义

### 修改版本计算规则

编辑 [scripts/update-version-changelog.js](../scripts/update-version-changelog.js)：

```javascript
function calculateNewVersion(currentVersion, hasBreaking, hasFeat, hasFix) {
  const [major, minor, patch] = currentVersion.split('.').map(Number);

  if (hasBreaking) {
    return `${major + 1}.0.0`; // 主版本 +1
  } else if (hasFeat) {
    return `${major}.${minor + 1}.0`; // 次版本 +1
  } else if (hasFix) {
    return `${major}.${minor}.${patch + 1}`; // 补丁版本 +1
  } else {
    // 自定义：其他提交也增加补丁版本
    return `${major}.${minor}.${patch + 1}`;
  }
}
```

### 修改 CHANGELOG 格式

编辑 [scripts/update-version-changelog.js](../scripts/update-version-changelog.js) 中的 `generateChangelog` 函数：

```javascript
function generateChangelog(version, types, commits) {
  const date = new Date().toISOString().split('T')[0];

  let changelog = `## [${version}] - ${date}\n\n`;

  // 自定义分类顺序和图标
  if (types.breaking.length > 0) {
    changelog += `### 💥 BREAKING CHANGES\n\n`;
    // ...
  }

  // 添加自定义分类
  if (types.security?.length > 0) {
    changelog += `### 🔒 安全更新\n\n`;
    // ...
  }

  return changelog;
}
```

### 跳过自动版本更新

如果某次 PR 不想触发自动版本更新，在合并提交消息中添加 `[skip ci]`：

```bash
# 合并 PR 时，编辑合并提交消息
chore: merge develop into master [skip ci]
```

---

## 最佳实践

### 1. 保持提交原子性

每个提交只做一件事，方便生成清晰的 CHANGELOG：

```bash
# ✅ 好的做法
git commit -m "feat: 添加用户登录功能"
git commit -m "feat: 添加用户注册功能"

# ❌ 不好的做法
git commit -m "feat: 添加用户登录和注册功能，修复了几个 bug，更新了文档"
```

### 2. 使用描述性的提交消息

```bash
# ✅ 好的描述
git commit -m "fix: 修复用户头像上传时文件大小限制错误"

# ❌ 模糊的描述
git commit -m "fix: 修复 bug"
```

### 3. 适时使用作用域

当项目较大时，使用作用域帮助分类：

```bash
git commit -m "feat(auth): 添加 OAuth 登录"
git commit -m "fix(message): 修复消息发送失败"
git commit -m "refactor(agent): 优化配置加载"
```

### 4. 破坏性变更要慎重

破坏性变更会升级主版本号，影响重大：

```bash
# 确保在提交消息中清楚说明变更内容和迁移方法
git commit -m "feat!: 重构 API 接口

BREAKING CHANGE: 所有 API 路径从 /api/v1 改为 /api/v2

迁移指南：
1. 更新客户端请求路径
2. 更新认证 token 格式
3. 参考新版 API 文档：docs/api-v2.md"
```

### 5. 定期合并到 master

建议每个迭代结束时合并一次 `develop → master`，避免一次性积累太多提交。

---

## 相关资源

- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [Conventional Commits 规范](https://www.conventionalcommits.org/)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [项目 CHANGELOG](../CHANGELOG.md)
- [版本更新脚本](../scripts/update-version-changelog.js)
- [GitHub Actions 工作流配置](../.github/workflows/version-changelog.yml)

---

## 常见问题 FAQ

**Q: 为什么要使用自动化版本管理？**

A: 自动化版本管理有以下优势：
- 避免手动管理版本号的错误
- 自动生成规范化的 CHANGELOG
- 统一团队的提交规范
- 提高开发效率

**Q: 如果我不想遵循 Conventional Commits 会怎样？**

A: 不遵循规范的提交仍会被记录，但：
- 版本号只会增加补丁版本
- CHANGELOG 中会归类到"其他更新"
- 建议团队统一遵循规范，以获得最佳效果

**Q: 可以手动修改 CHANGELOG 吗？**

A: 可以，但不建议：
- 手动修改的内容会在下次自动更新时保留
- 建议通过规范的提交消息让系统自动生成

**Q: 如何回退版本？**

A: 使用 Git Tag 回退：
```bash
# 查看所有版本
git tag -l

# 回退到指定版本
git checkout v1.2.3

# 或者创建新分支
git checkout -b hotfix-1.2.3 v1.2.3
```

**Q: develop 和 master 的版本号会不一致吗？**

A: 不会，因为：
- master 更新版本后会自动同步到 develop
- 两个分支的版本号始终保持一致

---

**最后更新**: 2025-11-06
**维护者**: 开发团队
